const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Créer un agent rattaché à l'agence (réservé au compte principal, pas à un agent lui-même) ──
router.post("/", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    if (req.user.agence_id) {
      return res.status(403).json({ error: "Seul le compte principal de l'agence peut créer des agents." });
    }
    const { nom, telephone, password } = req.body;
    if (!nom || !telephone || !password) return res.status(400).json({ error: "Nom, téléphone et mot de passe sont requis." });

    const existe = await query(`SELECT id FROM users WHERE telephone = $1`, [telephone]);
    if (existe.rows.length) return res.status(409).json({ error: "Ce numéro de téléphone est déjà utilisé." });

    const principal = await query(`SELECT cni_statut, commune FROM users WHERE id = $1`, [req.user.id]);
    const hash = bcrypt.hashSync(password, 10);
    const r = await query(
      `INSERT INTO users (role, nom, telephone, password_hash, cni_statut, commune, agence_id)
       VALUES ('intermediaire', $1, $2, $3, $4, $5, $6) RETURNING id, nom, telephone`,
      [nom, telephone, hash, principal.rows[0]?.cni_statut || "en_attente", principal.rows[0]?.commune || null, req.user.id]
    );
    await auditLog(req.user.id, "agent_cree", { agent_id: r.rows[0].id });
    res.status(201).json({ message: "Agent créé. Il peut se connecter avec ce téléphone et ce mot de passe.", agent: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes agents (réservé au compte principal) ──
router.get("/mine", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    if (req.user.agence_id) return res.json({ agents: [] });
    const r = await query(`SELECT id, nom, telephone, actif, created_at FROM users WHERE agence_id = $1 ORDER BY created_at DESC`, [req.user.id]);
    res.json({ agents: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Retirer l'accès d'un agent (désactivation, pas de suppression — préserve l'historique) ──
router.delete("/:id", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    if (req.user.agence_id) return res.status(403).json({ error: "Seul le compte principal peut retirer un agent." });
    const r = await query(`UPDATE users SET actif = FALSE WHERE id = $1 AND agence_id = $2 RETURNING id`, [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Agent introuvable." });
    await auditLog(req.user.id, "agent_retire", { agent_id: req.params.id });
    res.json({ message: "Accès de l'agent désactivé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Réactiver un agent ──
router.post("/:id/reactiver", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    if (req.user.agence_id) return res.status(403).json({ error: "Seul le compte principal peut réactiver un agent." });
    const r = await query(`UPDATE users SET actif = TRUE WHERE id = $1 AND agence_id = $2 RETURNING id`, [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Agent introuvable." });
    res.json({ message: "Agent réactivé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

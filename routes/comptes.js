const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Rechercher des comptes ──
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { recherche, role } = req.query;
    let sql = `SELECT id, role, nom, telephone, actif, cni_statut, agence_id, created_at FROM users WHERE 1=1`;
    const params = [];
    if (recherche) { params.push(`%${recherche}%`); sql += ` AND (nom ILIKE $${params.length} OR telephone ILIKE $${params.length})`; }
    if (role) { params.push(role); sql += ` AND role = $${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 50`;
    const r = await query(sql, params);
    res.json({ comptes: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Suspendre un compte ──
router.post("/:id/suspendre", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "Vous ne pouvez pas suspendre votre propre compte." });
    const check = await query(`SELECT role FROM users WHERE id = $1`, [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: "Compte introuvable." });
    if (check.rows[0].role === "admin") return res.status(403).json({ error: "Impossible de suspendre un compte admin depuis cet écran." });

    await query(`UPDATE users SET actif = FALSE WHERE id = $1`, [req.params.id]);
    await auditLog(req.user.id, "compte_suspendu", { compte_id: req.params.id });
    res.json({ message: "Compte suspendu." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Réactiver un compte ──
router.post("/:id/reactiver", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(`UPDATE users SET actif = TRUE WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Compte introuvable." });
    await auditLog(req.user.id, "compte_reactive", { compte_id: req.params.id });
    res.json({ message: "Compte réactivé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

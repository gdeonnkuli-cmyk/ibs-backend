const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Signaler une offre (locataire) ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { offre_id, motif, details } = req.body;
    if (!offre_id || !motif) return res.status(400).json({ error: "offre_id et motif sont requis." });
    const o = await query(`SELECT id FROM offres WHERE id = $1`, [offre_id]);
    if (!o.rows.length) return res.status(404).json({ error: "Offre introuvable." });

    await query(
      `INSERT INTO signalements (offre_id, locataire_id, motif, details) VALUES ($1,$2,$3,$4)`,
      [offre_id, req.user.id, motif, details || null]
    );
    await auditLog(req.user.id, "offre_signalee", { offre_id, motif });
    res.status(201).json({ message: "Signalement transmis à l'équipe IBS. Merci." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Admin : file de modération ──
router.get("/admin", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(
      `SELECT s.id, s.motif, s.details, s.statut, s.created_at,
              o.id AS offre_id, p.titre, p.commune,
              u.nom AS signale_par
       FROM signalements s
       JOIN offres o ON o.id = s.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = s.locataire_id
       ORDER BY (s.statut = 'en_attente') DESC, s.created_at DESC`
    );
    res.json({ signalements: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Admin : traiter un signalement (avec option de suspendre l'offre) ──
router.post("/:id/traiter", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { statut, suspendre_offre } = req.body;
    if (!["traite", "rejete"].includes(statut)) return res.status(400).json({ error: "Statut invalide." });

    const s = await query(`SELECT * FROM signalements WHERE id = $1`, [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ error: "Signalement introuvable." });

    await query(`UPDATE signalements SET statut = $1 WHERE id = $2`, [statut, req.params.id]);
    if (statut === "traite" && suspendre_offre) {
      await query(`UPDATE offres SET statut = 'suspendue' WHERE id = $1`, [s.rows[0].offre_id]);
    }
    await auditLog(req.user.id, "signalement_traite", { signalement_id: req.params.id, statut, suspendre_offre: !!suspendre_offre });
    res.json({ message: "Signalement mis à jour." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

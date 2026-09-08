const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();

// ── Créer une alerte ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { commune, type, budget_max, chambres } = req.body;
    if (!commune && !type && !budget_max && !chambres) {
      return res.status(400).json({ error: "Précisez au moins un critère (commune, type, budget ou chambres)." });
    }
    const r = await query(
      `INSERT INTO alertes (locataire_id, commune, type, budget_max, chambres)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.id, commune || null, type || null, budget_max ? Number(budget_max) : null, chambres ? Number(chambres) : null]
    );
    res.status(201).json({ id: r.rows[0].id, message: "Alerte créée." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes alertes ──
router.get("/mine", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM alertes WHERE locataire_id = $1 ORDER BY created_at DESC`, [req.user.id]);
    res.json({ alertes: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Activer / suspendre une alerte ──
router.post("/:id/toggle", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(`UPDATE alertes SET actif = NOT actif WHERE id = $1 AND locataire_id = $2 RETURNING actif`, [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Alerte introuvable." });
    res.json({ actif: r.rows[0].actif });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Supprimer une alerte ──
router.delete("/:id", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    await query(`DELETE FROM alertes WHERE id = $1 AND locataire_id = $2`, [req.params.id, req.user.id]);
    res.json({ message: "Alerte supprimée." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

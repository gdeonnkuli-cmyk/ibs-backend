const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole, agenceIdDe } = require("../auth");

const router = express.Router();

// ── Créer un mandant ──
router.post("/", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    const { nom, telephone, commune } = req.body;
    if (!nom) return res.status(400).json({ error: "Le nom du mandant est requis." });
    const r = await query(
      `INSERT INTO mandants (intermediaire_id, nom, telephone, commune) VALUES ($1,$2,$3,$4) RETURNING id, nom, telephone, commune`,
      [agenceIdDe(req.user), nom, telephone || null, commune || null]
    );
    res.status(201).json({ mandant: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes mandants, avec nombre de biens gérés pour chacun ──
router.get("/mine", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT m.id, m.nom, m.telephone, m.commune, m.created_at,
              COUNT(p.id) AS biens_geres
       FROM mandants m
       LEFT JOIN proprietes p ON p.mandant_id = m.id
       WHERE m.intermediaire_id = $1
       GROUP BY m.id
       ORDER BY m.created_at DESC`,
      [agenceIdDe(req.user)]
    );
    res.json({ mandants: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Modifier un mandant ──
router.patch("/:id", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    const { nom, telephone, commune } = req.body;
    const r = await query(
      `UPDATE mandants SET nom = COALESCE($1, nom), telephone = COALESCE($2, telephone), commune = COALESCE($3, commune)
       WHERE id = $4 AND intermediaire_id = $5 RETURNING id`,
      [nom, telephone, commune, req.params.id, agenceIdDe(req.user)]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Mandant introuvable." });
    res.json({ message: "Mandant mis à jour." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Supprimer un mandant (uniquement s'il n'a plus aucun bien rattaché) ──
router.delete("/:id", requireAuth, requireRole("intermediaire"), async (req, res) => {
  try {
    const lies = await query(`SELECT COUNT(*) FROM proprietes WHERE mandant_id = $1`, [req.params.id]);
    if (Number(lies.rows[0].count) > 0) {
      return res.status(409).json({ error: "Ce mandant a encore des biens rattachés — détachez-les d'abord." });
    }
    const r = await query(`DELETE FROM mandants WHERE id = $1 AND intermediaire_id = $2 RETURNING id`, [req.params.id, agenceIdDe(req.user)]);
    if (!r.rows.length) return res.status(404).json({ error: "Mandant introuvable." });
    res.json({ message: "Mandant supprimé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

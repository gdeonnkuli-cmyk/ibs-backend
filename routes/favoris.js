const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();

// ── Ajouter une offre aux favoris ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { offre_id } = req.body;
    if (!offre_id) return res.status(400).json({ error: "offre_id requis." });
    await query(
      `INSERT INTO favoris (locataire_id, offre_id) VALUES ($1,$2) ON CONFLICT (locataire_id, offre_id) DO NOTHING`,
      [req.user.id, offre_id]
    );
    res.status(201).json({ message: "Ajouté aux favoris." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Retirer une offre des favoris ──
router.delete("/:offre_id", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    await query(`DELETE FROM favoris WHERE locataire_id = $1 AND offre_id = $2`, [req.user.id, req.params.offre_id]);
    res.json({ message: "Retiré des favoris." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes favoris (avec les données complètes de chaque offre) ──
router.get("/mine", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT o.id AS offre_id, o.statut, o.vues,
              p.titre, p.type, p.commune, p.adresse, p.chambres, p.loyer_usd, p.description,
              p.statut_verification, p.garantie_mois, p.charges_incluses, p.equipements, p.disponibilite,
              u.nom AS bailleur_nom, f.created_at AS favori_depuis
       FROM favoris f
       JOIN offres o ON o.id = f.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = p.bailleur_id
       WHERE f.locataire_id = $1
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ favoris: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Liste des offre_id favorites (pour cocher les cœurs sans tout recharger) ──
router.get("/ids", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(`SELECT offre_id FROM favoris WHERE locataire_id = $1`, [req.user.id]);
    res.json({ ids: r.rows.map(row => row.offre_id) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

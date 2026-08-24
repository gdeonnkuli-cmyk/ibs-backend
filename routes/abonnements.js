const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Paliers IBS : basés sur les offres vérifiées et les baux signés, pas le volume brut ──
const TIERS = [
  { code: "elite",     nom: "Elite IBS",  cap: null, min_offres_verifiees: 30, min_baux_signes: 15 },
  { code: "reference", nom: "Référence",  cap: 150,  min_offres_verifiees: 10, min_baux_signes: 5  },
  { code: "confirme",  nom: "Confirmé",   cap: 50,   min_offres_verifiees: 3,  min_baux_signes: 1  },
  { code: "debutant",  nom: "Débutant",   cap: 20,   min_offres_verifiees: 0,  min_baux_signes: 0  },
];
function computeTier(offresVerifiees, bauxSignes) {
  for (const t of TIERS) {
    if (offresVerifiees >= t.min_offres_verifiees && bauxSignes >= t.min_baux_signes) return t;
  }
  return TIERS[TIERS.length - 1];
}
async function statsBailleur(bailleurId) {
  const r = await query(
    `SELECT
       (SELECT COUNT(*) FROM proprietes WHERE bailleur_id = $1 AND statut_verification = 'verifie') AS offres_verifiees,
       (SELECT COUNT(*) FROM contrats WHERE bailleur_id = $1 AND statut = 'signe') AS baux_signes,
       (SELECT COUNT(*) FROM abonnements WHERE bailleur_id = $1) AS abonnes_count`,
    [bailleurId]
  );
  const row = r.rows[0];
  const offresVerifiees = Number(row.offres_verifiees), bauxSignes = Number(row.baux_signes);
  const tier = computeTier(offresVerifiees, bauxSignes);
  return { offres_verifiees: offresVerifiees, baux_signes: bauxSignes, abonnes_count: Number(row.abonnes_count), tier };
}

// ── S'abonner à un bailleur / agence (locataire) ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { bailleur_id } = req.body;
    if (!bailleur_id) return res.status(400).json({ error: "bailleur_id requis." });

    const b = await query(`SELECT id FROM users WHERE id = $1 AND role IN ('bailleur','intermediaire')`, [bailleur_id]);
    if (!b.rows.length) return res.status(404).json({ error: "Bailleur ou agence introuvable." });

    const already = await query(`SELECT 1 FROM abonnements WHERE locataire_id = $1 AND bailleur_id = $2`, [req.user.id, bailleur_id]);
    if (!already.rows.length) {
      const stats = await statsBailleur(bailleur_id);
      if (stats.tier.cap !== null && stats.abonnes_count >= stats.tier.cap) {
        return res.status(403).json({
          error: `Ce bailleur a atteint son plafond d'abonnés pour le palier "${stats.tier.nom}" (${stats.tier.cap}). Le plafond augmente avec plus d'offres vérifiées et de baux signés via IBS.`,
        });
      }
    }

    await query(
      `INSERT INTO abonnements (locataire_id, bailleur_id) VALUES ($1,$2)
       ON CONFLICT (locataire_id, bailleur_id) DO NOTHING`,
      [req.user.id, bailleur_id]
    );
    await auditLog(req.user.id, "abonnement_suivi", { bailleur_id });
    res.status(201).json({ message: "Abonnement enregistré." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Se désabonner ──
router.delete("/:bailleur_id", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    await query(`DELETE FROM abonnements WHERE locataire_id = $1 AND bailleur_id = $2`, [req.user.id, req.params.bailleur_id]);
    await auditLog(req.user.id, "abonnement_retire", { bailleur_id: req.params.bailleur_id });
    res.json({ message: "Désabonné." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Palier + stats d'un bailleur (public — affiché sur ses offres) ──
router.get("/palier/:bailleur_id", async (req, res) => {
  try {
    const b = await query(`SELECT id FROM users WHERE id = $1 AND role IN ('bailleur','intermediaire')`, [req.params.bailleur_id]);
    if (!b.rows.length) return res.status(404).json({ error: "Bailleur ou agence introuvable." });
    const stats = await statsBailleur(req.params.bailleur_id);
    res.json(stats);
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Classement du mois : bailleurs par baux signés (glissant 30 jours) ──
router.get("/classement", async (req, res) => {
  try {
    const r = await query(
      `SELECT u.id AS bailleur_id, u.nom, u.role,
              COUNT(c.id) AS baux_signes_mois
       FROM users u
       JOIN contrats c ON c.bailleur_id = u.id AND c.statut = 'signe' AND c.signed_at >= NOW() - INTERVAL '30 days'
       WHERE u.role IN ('bailleur','intermediaire')
       GROUP BY u.id, u.nom, u.role
       ORDER BY baux_signes_mois DESC, u.nom ASC
       LIMIT 20`
    );
    const withTiers = await Promise.all(r.rows.map(async (row) => {
      const stats = await statsBailleur(row.bailleur_id);
      return { ...row, baux_signes_mois: Number(row.baux_signes_mois), tier: stats.tier, offres_verifiees: stats.offres_verifiees };
    }));
    res.json({ classement: withTiers });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes abonnements : bailleurs/agences suivis + nb d'offres actives ──
router.get("/mine", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT u.id AS bailleur_id, u.nom, u.role,
              COUNT(o.id) FILTER (WHERE o.statut = 'active') AS offres_actives
       FROM abonnements a
       JOIN users u ON u.id = a.bailleur_id
       LEFT JOIN proprietes p ON p.bailleur_id = u.id
       LEFT JOIN offres o ON o.propriete_id = p.id
       WHERE a.locataire_id = $1
       GROUP BY u.id, u.nom, u.role
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );
    res.json({ abonnements: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Fil : offres publiées par mes abonnements (vérifiées ou en attente) ──
router.get("/fil", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT o.id AS offre_id, o.statut, o.vues, o.created_at,
              p.titre, p.type, p.commune, p.adresse, p.chambres, p.loyer_usd, p.description,
              p.statut_verification, p.garantie_mois, p.charges_incluses, p.equipements, p.disponibilite,
              u.nom AS bailleur_nom, u.id AS bailleur_id
       FROM offres o
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = p.bailleur_id
       JOIN abonnements a ON a.bailleur_id = u.id
       WHERE a.locataire_id = $1 AND o.statut = 'active'
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ offres: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;
module.exports.TIERS = TIERS;
module.exports.statsBailleur = statsBailleur;

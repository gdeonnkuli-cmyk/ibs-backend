const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { notify } = require("../notify");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Locataire postule sur une offre ──────────────────
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const ur = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    const user = ur.rows[0];
    if (user.cni_statut !== "verifie") {
      return res.status(403).json({ error: "Votre identité doit être vérifiée avant de candidater." });
    }

    const { offre_id, message } = req.body;
    const or_ = await query(
      `SELECT o.*, p.bailleur_id, p.titre FROM offres o JOIN proprietes p ON p.id = o.propriete_id WHERE o.id = $1`,
      [offre_id]
    );
    const offre = or_.rows[0];
    if (!offre) return res.status(404).json({ error: "Offre introuvable." });
    if (offre.statut !== "active") return res.status(400).json({ error: "Cette offre n'est plus disponible." });

    const existing = await query(`SELECT id FROM demandes WHERE offre_id = $1 AND locataire_id = $2`, [offre_id, user.id]);
    if (existing.rows.length) return res.status(409).json({ error: "Vous avez déjà postulé sur cette offre." });

    const ins = await query(
      `INSERT INTO demandes (offre_id, locataire_id, message) VALUES ($1,$2,$3) RETURNING id`,
      [offre_id, user.id, message || null]
    );

    await auditLog(user.id, "candidature", { offre_id });
    await notify(offre.bailleur_id, `Nouvelle candidature de ${user.nom} pour "${offre.titre}".`, "sms");

    res.status(201).json({ message: "Candidature envoyée.", demande_id: ins.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Bailleur : candidatures reçues sur ses offres ────
router.get("/recues", requireAuth, requireRole("bailleur","intermediaire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT d.id AS demande_id, d.statut, d.message, d.created_at,
              o.id AS offre_id, p.titre,
              u.id AS locataire_id, u.nom AS locataire_nom, u.telephone AS locataire_telephone
       FROM demandes d
       JOIN offres o ON o.id = d.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = d.locataire_id
       WHERE p.bailleur_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    res.json({ demandes: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Locataire : mes candidatures ─────────────────────
router.get("/mine", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT d.id AS demande_id, d.statut, d.created_at, p.titre, p.commune, p.loyer_usd
       FROM demandes d
       JOIN offres o ON o.id = d.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       WHERE d.locataire_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    res.json({ demandes: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Bailleur sélectionne un candidat → crée le contrat (brouillon) ──
router.post("/:id/selectionner", requireAuth, requireRole("bailleur","intermediaire"), async (req, res) => {
  try {
    const dr = await query(
      `SELECT d.*, o.id AS offre_id, p.bailleur_id, p.loyer_usd, p.titre
       FROM demandes d JOIN offres o ON o.id = d.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    const demande = dr.rows[0];
    if (!demande) return res.status(404).json({ error: "Candidature introuvable." });
    if (demande.bailleur_id !== req.user.id) return res.status(403).json({ error: "Cette candidature ne concerne pas vos offres." });

    await query(`UPDATE demandes SET statut = 'selectionnee' WHERE id = $1`, [demande.id]);
    await query(`UPDATE offres SET statut = 'louee' WHERE id = $1`, [demande.offre_id]);
    await query(`UPDATE demandes SET statut = 'refusee' WHERE offre_id = $1 AND id != $2`, [demande.offre_id, demande.id]);

    const commission = Math.round(demande.loyer_usd * 0.5 * 100) / 100;
    const c = await query(
      `INSERT INTO contrats (offre_id, bailleur_id, locataire_id, loyer_usd, commission_usd, statut)
       VALUES ($1,$2,$3,$4,$5,'brouillon') RETURNING id`,
      [demande.offre_id, demande.bailleur_id, demande.locataire_id, demande.loyer_usd, commission]
    );

    await auditLog(req.user.id, "candidat_selectionne", { demande_id: demande.id, contrat_id: c.rows[0].id });
    await notify(demande.locataire_id, `Vous avez été sélectionné(e) pour "${demande.titre}". Le contrat est en préparation.`, "sms");

    res.json({ message: "Candidat sélectionné, contrat créé en brouillon.", contrat_id: c.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

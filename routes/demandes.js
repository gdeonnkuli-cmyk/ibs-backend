const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { notify } = require("../notify");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Locataire postule sur une offre ──────────────────
router.post("/", requireAuth, requireRole("locataire"), (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  if (user.cni_statut !== "verifie") {
    return res.status(403).json({ error: "Votre identité doit être vérifiée avant de candidater." });
  }

  const { offre_id, message } = req.body;
  const offre = db
    .prepare(`SELECT o.*, p.bailleur_id, p.titre FROM offres o JOIN proprietes p ON p.id = o.propriete_id WHERE o.id = ?`)
    .get(offre_id);
  if (!offre) return res.status(404).json({ error: "Offre introuvable." });
  if (offre.statut !== "active") return res.status(400).json({ error: "Cette offre n'est plus disponible." });

  const dejaCandidate = db
    .prepare(`SELECT id FROM demandes WHERE offre_id = ? AND locataire_id = ?`)
    .get(offre_id, user.id);
  if (dejaCandidate) return res.status(409).json({ error: "Vous avez déjà postulé sur cette offre." });

  const result = db
    .prepare(`INSERT INTO demandes (offre_id, locataire_id, message) VALUES (?, ?, ?)`)
    .run(offre_id, user.id, message || null);

  auditLog(user.id, "candidature", { offre_id });
  notify(offre.bailleur_id, `Nouvelle candidature de ${user.nom} pour "${offre.titre}".`, "sms");

  res.status(201).json({ message: "Candidature envoyée.", demande_id: result.lastInsertRowid });
});

// ── Bailleur : candidatures reçues sur ses offres ────
router.get("/recues", requireAuth, requireRole("bailleur"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id AS demande_id, d.statut, d.message, d.created_at,
              o.id AS offre_id, p.titre,
              u.id AS locataire_id, u.nom AS locataire_nom, u.telephone AS locataire_telephone
       FROM demandes d
       JOIN offres o ON o.id = d.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = d.locataire_id
       WHERE p.bailleur_id = ?
       ORDER BY d.created_at DESC`
    )
    .all(req.user.id);
  res.json({ demandes: rows });
});

// ── Locataire : mes candidatures ─────────────────────
router.get("/mine", requireAuth, requireRole("locataire"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id AS demande_id, d.statut, d.created_at, p.titre, p.commune, p.loyer_usd
       FROM demandes d
       JOIN offres o ON o.id = d.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       WHERE d.locataire_id = ?
       ORDER BY d.created_at DESC`
    )
    .all(req.user.id);
  res.json({ demandes: rows });
});

// ── Bailleur sélectionne un candidat → déclenche la création du contrat (brouillon) ──
router.post("/:id/selectionner", requireAuth, requireRole("bailleur"), (req, res) => {
  const demande = db
    .prepare(
      `SELECT d.*, o.id AS offre_id, p.bailleur_id, p.loyer_usd, p.titre
       FROM demandes d JOIN offres o ON o.id = d.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE d.id = ?`
    )
    .get(req.params.id);
  if (!demande) return res.status(404).json({ error: "Candidature introuvable." });
  if (demande.bailleur_id !== req.user.id) return res.status(403).json({ error: "Cette candidature ne concerne pas vos offres." });

  db.prepare(`UPDATE demandes SET statut = 'selectionnee' WHERE id = ?`).run(demande.id);
  db.prepare(`UPDATE offres SET statut = 'louee' WHERE id = ?`).run(demande.offre_id);
  db.prepare(`UPDATE demandes SET statut = 'refusee' WHERE offre_id = ? AND id != ?`).run(demande.offre_id, demande.id);

  const commission = Math.round(demande.loyer_usd * 0.5 * 100) / 100;
  const contrat = db
    .prepare(
      `INSERT INTO contrats (offre_id, bailleur_id, locataire_id, loyer_usd, commission_usd, statut)
       VALUES (?, ?, ?, ?, ?, 'brouillon')`
    )
    .run(demande.offre_id, demande.bailleur_id, demande.locataire_id, demande.loyer_usd, commission);

  auditLog(req.user.id, "candidat_selectionne", { demande_id: demande.id, contrat_id: contrat.lastInsertRowid });
  notify(demande.locataire_id, `Vous avez été sélectionné(e) pour "${demande.titre}". Le contrat est en préparation.`, "sms");

  res.json({ message: "Candidat sélectionné, contrat créé en brouillon.", contrat_id: contrat.lastInsertRowid });
});

module.exports = router;

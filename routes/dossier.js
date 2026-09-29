// dossier.js — Dossier de candidature du locataire.
//
// Une candidature ne portait qu'un message libre : le bailleur choisissait sur
// une phrase. Le dossier rassemble ce qu'il regarde vraiment — de quoi vit le
// candidat, qui se porte garant, quelles pièces il peut montrer — et surtout ce
// qu'aucune promesse ne remplace : son carnet de loyer sur IBS.
//
// L'historique de paiement est la seule pièce que le candidat ne peut pas
// écrire lui-même. Il est recalculé à chaque lecture depuis paiements_loyer, et
// figé sur la candidature au moment où elle part.

const express = require("express");
const PDFDocument = require("pdfkit");
const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { requireAuth, requireRole, JWT_SECRET } = require("../auth");
const { auditLog } = require("../audit");
const { urlDeStockageValide, MESSAGE_URL_INVALIDE } = require("../storage");
const { appliquerFiligrane } = require("../pdfwatermark");

const router = express.Router();

const TYPES_CONTRAT = ["cdi", "cdd", "independant", "fonctionnaire", "etudiant", "autre"];
const TYPES_PIECE = ["attestation_travail", "bulletin_paie", "releve_bancaire", "attestation_garant", "autre"];
const MAX_PIECES = 8;

/**
 * Ce que le carnet de loyer dit d'un locataire, tous baux confondus.
 *
 * Un locataire sans historique n'est pas un mauvais payeur : il est nouveau.
 * Les deux cas se distinguent, sans quoi l'absence de données se lirait comme
 * un mauvais score et le dossier desservirait ceux qu'il est censé aider.
 */
async function historiquePaiement(locataireId) {
  const r = await query(
    `SELECT
       (SELECT count(*) FROM contrats WHERE locataire_id = $1 AND statut IN ('signe','preavis','termine')) AS baux,
       (SELECT count(*) FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
         WHERE c.locataire_id = $1 AND pl.statut = 'confirme') AS mois_regles,
       (SELECT count(*) FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
         WHERE c.locataire_id = $1 AND pl.statut = 'conteste') AS mois_contestes,
       (SELECT coalesce(sum(pl.montant_usd), 0) FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
         WHERE c.locataire_id = $1 AND pl.statut = 'confirme') AS total_regle_usd,
       (SELECT min(pl.mois) FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
         WHERE c.locataire_id = $1 AND pl.statut = 'confirme') AS depuis`,
    [locataireId]
  );
  const h = r.rows[0];
  const baux = Number(h.baux);
  const regles = Number(h.mois_regles);

  return {
    baux,
    mois_regles: regles,
    mois_contestes: Number(h.mois_contestes),
    total_regle_usd: Math.round(Number(h.total_regle_usd)),
    depuis: h.depuis ? new Date(h.depuis).toISOString().slice(0, 7) : null,
    // Distinguer « rien à montrer » de « mauvais dossier » : sans historique,
    // on ne dit rien plutôt que d'afficher un zéro qui ressemble à un reproche.
    nouveau: baux === 0 || regles === 0,
  };
}

/** Ce qui manque au dossier, dans l'ordre où un bailleur le remarque. */
function completude(u) {
  const attendus = [
    ["profession", !!u.profession, "votre profession"],
    ["revenu", u.revenu_usd > 0, "votre revenu mensuel"],
    ["type_contrat", !!u.type_contrat, "votre type de contrat"],
    ["occupants", u.nb_occupants > 0, "le nombre d'occupants"],
    ["garant", !!(u.garant_nom && u.garant_telephone), "un garant"],
    ["pieces", (u.dossier_pieces || []).length > 0, "au moins une pièce justificative"],
  ];
  const faits = attendus.filter(([, ok]) => ok).length;
  return {
    pourcentage: Math.round((faits / attendus.length) * 100),
    manquant: attendus.filter(([, ok]) => !ok).map(([, , libelle]) => libelle),
  };
}

const vueDossier = (u) => ({
  profession: u.profession || null,
  employeur: u.employeur || null,
  revenu_usd: u.revenu_usd ?? null,
  type_contrat: u.type_contrat || null,
  nb_occupants: u.nb_occupants ?? null,
  garant_nom: u.garant_nom || null,
  garant_telephone: u.garant_telephone || null,
  garant_lien: u.garant_lien || null,
  pieces: u.dossier_pieces || [],
  maj_at: u.dossier_maj_at || null,
});

// ── Mon dossier ──────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: "Compte introuvable." });
    res.json({
      dossier: vueDossier(u),
      completude: completude(u),
      historique: await historiquePaiement(req.user.id),
      types_contrat: TYPES_CONTRAT,
      types_piece: TYPES_PIECE,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Enregistrer mon dossier ──────────────────────────────────────────────
router.put("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const {
      profession, employeur, revenu_usd, type_contrat, nb_occupants,
      garant_nom, garant_telephone, garant_lien, pieces,
    } = req.body;

    if (type_contrat && !TYPES_CONTRAT.includes(type_contrat)) {
      return res.status(400).json({ error: `Type de contrat invalide. Attendu : ${TYPES_CONTRAT.join(", ")}.` });
    }
    if (revenu_usd != null && (!Number.isFinite(Number(revenu_usd)) || Number(revenu_usd) < 0)) {
      return res.status(400).json({ error: "Revenu invalide." });
    }
    if (nb_occupants != null && (!Number.isInteger(Number(nb_occupants)) || Number(nb_occupants) < 1 || Number(nb_occupants) > 30)) {
      return res.status(400).json({ error: "Nombre d'occupants invalide." });
    }
    // Un garant sans numéro ne se joint pas : c'est une ligne de texte, pas une
    // garantie. Les deux vont ensemble ou aucun des deux.
    if ((garant_nom && !garant_telephone) || (garant_telephone && !garant_nom)) {
      return res.status(400).json({ error: "Un garant demande un nom et un numéro de téléphone." });
    }

    const liste = Array.isArray(pieces) ? pieces.slice(0, MAX_PIECES) : [];
    for (const p of liste) {
      if (!p || !TYPES_PIECE.includes(p.type)) {
        return res.status(400).json({ error: `Type de pièce invalide. Attendu : ${TYPES_PIECE.join(", ")}.` });
      }
      if (!urlDeStockageValide(p.url)) return res.status(400).json({ error: MESSAGE_URL_INVALIDE });
    }

    await query(
      `UPDATE users SET
         profession = $2, employeur = $3, revenu_usd = $4, type_contrat = $5, nb_occupants = $6,
         garant_nom = $7, garant_telephone = $8, garant_lien = $9,
         dossier_pieces = $10::jsonb, dossier_maj_at = NOW()
       WHERE id = $1`,
      [req.user.id, profession || null, employeur || null,
       revenu_usd != null && revenu_usd !== "" ? Number(revenu_usd) : null,
       type_contrat || null,
       nb_occupants != null && nb_occupants !== "" ? Number(nb_occupants) : null,
       garant_nom || null, garant_telephone || null, garant_lien || null,
       JSON.stringify(liste.map((p) => ({ type: p.type, url: p.url })))]
    );
    // Le journal ne porte ni revenu ni numéro de garant : savoir que le dossier
    // a changé suffit, le détail appartient au locataire.
    await auditLog(req.user.id, "dossier_mis_a_jour", { pieces: liste.length });

    const r = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    res.json({ message: "Dossier enregistré.", completude: completude(r.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Attestation de bon payeur (PDF) ──────────────────────────────────────
// La seule pièce du dossier que le candidat ne rédige pas lui-même : elle sort
// du carnet de loyer, donc de déclarations validées par ses bailleurs
// successifs. C'est ce qu'IBS peut attester et qu'aucune annonce ne remplace.
router.get("/attestation", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: "Authentification requise." });
    let user;
    try { user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Session invalide ou expirée." }); }
    if (user.role !== "locataire") return res.status(403).json({ error: "Réservé aux locataires." });

    const h = await historiquePaiement(user.id);
    // Attester d'un historique vide n'attesterait de rien : mieux vaut le dire
    // que délivrer un document creux.
    if (h.nouveau) {
      return res.status(409).json({
        error: "Aucun loyer confirmé à ce jour : l'attestation sera disponible dès votre premier mois réglé sur IBS.",
      });
    }

    const u = await query(`SELECT nom, telephone FROM users WHERE id = $1`, [user.id]);
    const moi = u.rows[0];

    const NAVY = "#0D1B3E", GOLD = "#C9963A", MUTED = "#5B6072";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ibs-attestation-${user.id}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 56 });
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
    doc.fillColor(GOLD).fontSize(22).font("Helvetica-Bold").text("IBS", 56, 28);
    doc.fillColor("#FFFFFF").fontSize(11).font("Helvetica")
       .text("Immo-Bail Solution — Attestation de paiement de loyer", 56, 55);

    doc.moveDown(3);
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold").text("Attestation de paiement");
    doc.moveDown(1);

    const ligne = (label, valeur) => {
      doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(label);
      doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text(String(valeur));
      doc.moveDown(0.6);
    };
    ligne("Locataire", moi.nom);
    ligne("Baux conclus sur IBS", h.baux);
    ligne("Mois de loyer réglés et confirmés", h.mois_regles);
    ligne("Montant total réglé", `${h.total_regle_usd} USD`);
    if (h.depuis) ligne("Locataire sur IBS depuis", h.depuis);
    if (h.mois_contestes > 0) ligne("Mois ayant fait l'objet d'une contestation", h.mois_contestes);

    doc.moveDown(1);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica-Oblique").text(
      "Ce document récapitule les paiements de loyer enregistrés dans le carnet IBS et confirmés par les "
      + "bailleurs concernés. Il ne porte que sur les baux conclus via la plateforme et n'atteste d'aucun "
      + "paiement effectué en dehors. IBS ne se porte pas garant du locataire.",
      { width: 480 }
    );

    appliquerFiligrane(doc, { nom: moi.nom, telephone: moi.telephone });
    doc.end();
  } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = { router, vueDossier, historiquePaiement, completude };

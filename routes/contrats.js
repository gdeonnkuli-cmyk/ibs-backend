const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../auth");
const { notify, generateOtp, verifyOtp } = require("../notify");
const { auditLog } = require("../audit");

const router = express.Router();

function getContrat(id) {
  return db
    .prepare(
      `SELECT c.*, p.titre, p.commune, p.adresse,
              b.nom AS bailleur_nom, b.telephone AS bailleur_telephone, b.cni_statut AS bailleur_cni_statut,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone, l.cni_statut AS locataire_cni_statut
       FROM contrats c
       JOIN offres o ON o.id = c.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users b ON b.id = c.bailleur_id
       JOIN users l ON l.id = c.locataire_id
       WHERE c.id = ?`
    )
    .get(id);
}

function assertPartie(req, res, contrat) {
  if (contrat.bailleur_id !== req.user.id && contrat.locataire_id !== req.user.id) {
    res.status(403).json({ error: "Ce contrat ne vous concerne pas." });
    return false;
  }
  return true;
}

// ── Détail d'un contrat ──────────────────────────────
router.get("/:id", requireAuth, (req, res) => {
  const contrat = getContrat(req.params.id);
  if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
  if (!assertPartie(req, res, contrat)) return;
  res.json({ contrat });
});

// ── Mes contrats (bailleur ou locataire) ─────────────
router.get("/", requireAuth, (req, res) => {
  const col = req.user.role === "bailleur" ? "bailleur_id" : "locataire_id";
  const rows = db
    .prepare(
      `SELECT c.id, c.statut, c.loyer_usd, c.duree_mois, c.signed_at, c.reference_signature,
              p.titre, p.commune
       FROM contrats c JOIN offres o ON o.id = c.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE c.${col} = ? ORDER BY c.created_at DESC`
    )
    .all(req.user.id);
  res.json({ contrats: rows });
});

// ── Étape 1 : renseigner durée + mode de réception des loyers (brouillon → en_confirmation) ──
router.post("/:id/preparer", requireAuth, (req, res) => {
  const contrat = getContrat(req.params.id);
  if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
  if (!assertPartie(req, res, contrat)) return;
  if (contrat.bailleur_id !== req.user.id) return res.status(403).json({ error: "Seul le bailleur prépare le contrat." });
  if (contrat.statut !== "brouillon") return res.status(400).json({ error: "Ce contrat n'est plus modifiable." });

  const { duree_mois, reception_loyer } = req.body;
  db.prepare(
    `UPDATE contrats SET duree_mois = ?, reception_loyer = ?, statut = 'en_confirmation' WHERE id = ?`
  ).run(duree_mois || 12, reception_loyer || null, contrat.id);

  auditLog(req.user.id, "contrat_prepare", { contrat_id: contrat.id });
  res.json({ message: "Contrat prêt pour confirmation avant signature." });
});

// ── Étape 2 : Confirmation avant signature (chaque partie confirme séparément) ──
// C'est ici que l'identité pré-remplie, le statut et les engagements sont validés
// avant de déclencher l'OTP — cf. spécification "Confirmation avant signature".
router.post("/:id/confirmer", requireAuth, (req, res) => {
  const contrat = getContrat(req.params.id);
  if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
  if (!assertPartie(req, res, contrat)) return;
  if (!["en_confirmation", "en_signature"].includes(contrat.statut)) {
    return res.status(400).json({ error: "Ce contrat n'est pas encore prêt pour confirmation." });
  }

  const { atteste_exactitude, accepte_traitement_donnees, consent_alertes } = req.body;
  if (!atteste_exactitude || !accepte_traitement_donnees || !consent_alertes) {
    return res.status(400).json({ error: "Les trois engagements doivent être acceptés pour continuer." });
  }

  const estBailleur = contrat.bailleur_id === req.user.id;
  const cniStatut = estBailleur ? contrat.bailleur_cni_statut : contrat.locataire_cni_statut;
  if (cniStatut !== "verifie") {
    return res.status(403).json({ error: "Votre identité doit être vérifiée par IBS avant de confirmer." });
  }

  db.prepare(
    `UPDATE contrats SET ${estBailleur ? "confirme_bailleur" : "confirme_locataire"} = 1, statut = 'en_signature' WHERE id = ?`
  ).run(contrat.id);

  auditLog(req.user.id, "contrat_confirme", { contrat_id: contrat.id });

  // Une fois confirmé, on envoie tout de suite le code de signature à cette partie
  const telephone = estBailleur ? contrat.bailleur_telephone : contrat.locataire_telephone;
  generateOtp(telephone, "signature", contrat.id);
  notify(req.user.id, "Confirmation enregistrée. Un code de signature vous a été envoyé par SMS.", "sms");

  res.json({ message: "Confirmation enregistrée. Code de signature envoyé par SMS." });
});

router.post("/:id/renvoyer-otp-signature", requireAuth, (req, res) => {
  const contrat = getContrat(req.params.id);
  if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
  if (!assertPartie(req, res, contrat)) return;
  const estBailleur = contrat.bailleur_id === req.user.id;
  const telephone = estBailleur ? contrat.bailleur_telephone : contrat.locataire_telephone;
  generateOtp(telephone, "signature", contrat.id);
  res.json({ message: "Nouveau code envoyé." });
});

// ── Étape 3 : Signature électronique par OTP (chaque partie signe séparément) ──
router.post("/:id/signer", requireAuth, (req, res) => {
  const contrat = getContrat(req.params.id);
  if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
  if (!assertPartie(req, res, contrat)) return;
  if (contrat.statut !== "en_signature") return res.status(400).json({ error: "Ce contrat n'est pas prêt pour signature." });

  const estBailleur = contrat.bailleur_id === req.user.id;
  if (estBailleur && !contrat.confirme_bailleur) return res.status(400).json({ error: "Confirmez vos informations avant de signer." });
  if (!estBailleur && !contrat.confirme_locataire) return res.status(400).json({ error: "Confirmez vos informations avant de signer." });

  const telephone = estBailleur ? contrat.bailleur_telephone : contrat.locataire_telephone;
  const { code } = req.body;
  const verif = verifyOtp(telephone, code, "signature", contrat.id);
  if (!verif.ok) return res.status(400).json({ error: verif.reason });

  db.prepare(
    `UPDATE contrats SET ${estBailleur ? "signe_bailleur" : "signe_locataire"} = 1 WHERE id = ?`
  ).run(contrat.id);

  auditLog(req.user.id, "contrat_signe_partie", { contrat_id: contrat.id, partie: estBailleur ? "bailleur" : "locataire" });

  const updated = getContrat(contrat.id);
  const deuxSignatures = updated.signe_bailleur && updated.signe_locataire;

  if (deuxSignatures) {
    // Les deux parties ont signé : on archive — empreinte immuable du contrat
    const contenu = JSON.stringify({
      id: updated.id,
      titre: updated.titre,
      commune: updated.commune,
      bailleur: updated.bailleur_nom,
      locataire: updated.locataire_nom,
      loyer_usd: updated.loyer_usd,
      duree_mois: updated.duree_mois,
      commission_usd: updated.commission_usd,
      signed_at: new Date().toISOString(),
    });
    const hash = crypto.createHash("sha256").update(contenu).digest("hex");
    const reference = "IBS-SIG-" + Math.floor(10000 + Math.random() * 89999);

    db.prepare(
      `UPDATE contrats SET statut = 'signe', contenu_hash = ?, reference_signature = ?, signed_at = datetime('now') WHERE id = ?`
    ).run(hash, reference, contrat.id);

    db.prepare(`INSERT INTO documents (contrat_id, type, url) VALUES (?, 'contrat_pdf', ?)`).run(
      contrat.id,
      `/contrats/${contrat.id}/pdf` // stub — génération PDF réelle en Phase 1 (DomPDF/Puppeteer)
    );

    auditLog(req.user.id, "contrat_archive", { contrat_id: contrat.id, reference });
    notify(updated.bailleur_id, `Bail "${updated.titre}" signé électroniquement · Réf. ${reference}`, "sms");
    notify(updated.locataire_id, `Bail "${updated.titre}" signé électroniquement · Réf. ${reference}`, "sms");

    return res.json({
      message: "Signature enregistrée. Les deux parties ayant signé, le contrat est archivé.",
      statut: "signe",
      reference_signature: reference,
    });
  }

  notify(
    estBailleur ? contrat.locataire_id : contrat.bailleur_id,
    `${estBailleur ? contrat.bailleur_nom : contrat.locataire_nom} a signé le bail "${contrat.titre}". À votre tour.`,
    "sms"
  );

  res.json({ message: "Votre signature est enregistrée. En attente de la seconde partie." });
});

module.exports = router;

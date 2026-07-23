const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const { query } = require("../db");
const { requireAuth, JWT_SECRET } = require("../auth");
const { notify, generateOtp, verifyOtp } = require("../notify");
const { auditLog } = require("../audit");

const router = express.Router();

async function getContrat(id) {
  const r = await query(
    `SELECT c.*, p.titre, p.commune, p.adresse,
            b.nom AS bailleur_nom, b.telephone AS bailleur_telephone, b.cni_statut AS bailleur_cni_statut,
            l.nom AS locataire_nom, l.telephone AS locataire_telephone, l.cni_statut AS locataire_cni_statut
     FROM contrats c
     JOIN offres o ON o.id = c.offre_id
     JOIN proprietes p ON p.id = o.propriete_id
     JOIN users b ON b.id = c.bailleur_id
     JOIN users l ON l.id = c.locataire_id
     WHERE c.id = $1`,
    [id]
  );
  return r.rows[0];
}

function assertPartie(req, res, contrat) {
  if (contrat.bailleur_id !== req.user.id && contrat.locataire_id !== req.user.id) {
    res.status(403).json({ error: "Ce contrat ne vous concerne pas." });
    return false;
  }
  return true;
}

// ── Détail d'un contrat ──────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const contrat = await getContrat(req.params.id);
    if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
    if (!assertPartie(req, res, contrat)) return;
    res.json({ contrat });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes contrats ──────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const col = req.user.role === "bailleur" ? "bailleur_id" : "locataire_id";
    const r = await query(
      `SELECT c.id, c.statut, c.loyer_usd, c.duree_mois, c.signed_at, c.reference_signature,
              p.titre, p.commune
       FROM contrats c JOIN offres o ON o.id = c.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE c.${col} = $1 ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    res.json({ contrats: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Étape 1 : préparer (durée + réception des loyers) ──
router.post("/:id/preparer", requireAuth, async (req, res) => {
  try {
    const contrat = await getContrat(req.params.id);
    if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
    if (!assertPartie(req, res, contrat)) return;
    if (contrat.bailleur_id !== req.user.id) return res.status(403).json({ error: "Seul le bailleur prépare le contrat." });
    if (contrat.statut !== "brouillon") return res.status(400).json({ error: "Ce contrat n'est plus modifiable." });

    const { duree_mois, reception_loyer } = req.body;
    await query(
      `UPDATE contrats SET duree_mois = $1, reception_loyer = $2, statut = 'en_confirmation' WHERE id = $3`,
      [duree_mois || 12, reception_loyer || null, contrat.id]
    );

    await auditLog(req.user.id, "contrat_prepare", { contrat_id: contrat.id });
    res.json({ message: "Contrat prêt pour confirmation avant signature." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Étape 2 : Confirmation avant signature ──
router.post("/:id/confirmer", requireAuth, async (req, res) => {
  try {
    const contrat = await getContrat(req.params.id);
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

    const col = estBailleur ? "confirme_bailleur" : "confirme_locataire";
    await query(`UPDATE contrats SET ${col} = TRUE, statut = 'en_signature' WHERE id = $1`, [contrat.id]);

    await auditLog(req.user.id, "contrat_confirme", { contrat_id: contrat.id });

    const telephone = estBailleur ? contrat.bailleur_telephone : contrat.locataire_telephone;
    await generateOtp(telephone, "signature", contrat.id);
    await notify(req.user.id, "Confirmation enregistrée. Un code de signature vous a été envoyé par SMS.", "sms");

    res.json({ message: "Confirmation enregistrée. Code de signature envoyé par SMS." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/:id/renvoyer-otp-signature", requireAuth, async (req, res) => {
  try {
    const contrat = await getContrat(req.params.id);
    if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
    if (!assertPartie(req, res, contrat)) return;
    const estBailleur = contrat.bailleur_id === req.user.id;
    const telephone = estBailleur ? contrat.bailleur_telephone : contrat.locataire_telephone;
    await generateOtp(telephone, "signature", contrat.id);
    res.json({ message: "Nouveau code envoyé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Étape 3 : Signature électronique par OTP ──
router.post("/:id/signer", requireAuth, async (req, res) => {
  try {
    const contrat = await getContrat(req.params.id);
    if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
    if (!assertPartie(req, res, contrat)) return;
    if (contrat.statut !== "en_signature") return res.status(400).json({ error: "Ce contrat n'est pas prêt pour signature." });

    const estBailleur = contrat.bailleur_id === req.user.id;
    if (estBailleur && !contrat.confirme_bailleur) return res.status(400).json({ error: "Confirmez vos informations avant de signer." });
    if (!estBailleur && !contrat.confirme_locataire) return res.status(400).json({ error: "Confirmez vos informations avant de signer." });

    const telephone = estBailleur ? contrat.bailleur_telephone : contrat.locataire_telephone;
    const { code } = req.body;
    const verif = await verifyOtp(telephone, code, "signature", contrat.id);
    if (!verif.ok) return res.status(400).json({ error: verif.reason });

    const col = estBailleur ? "signe_bailleur" : "signe_locataire";
    await query(`UPDATE contrats SET ${col} = TRUE WHERE id = $1`, [contrat.id]);

    await auditLog(req.user.id, "contrat_signe_partie", { contrat_id: contrat.id, partie: estBailleur ? "bailleur" : "locataire" });

    const updated = await getContrat(contrat.id);
    const deuxSignatures = updated.signe_bailleur && updated.signe_locataire;

    if (deuxSignatures) {
      const contenu = JSON.stringify({
        id: updated.id, titre: updated.titre, commune: updated.commune,
        bailleur: updated.bailleur_nom, locataire: updated.locataire_nom,
        loyer_usd: updated.loyer_usd, duree_mois: updated.duree_mois,
        commission_usd: updated.commission_usd, signed_at: new Date().toISOString(),
      });
      const hash = crypto.createHash("sha256").update(contenu).digest("hex");
      const reference = "IBS-SIG-" + Math.floor(10000 + Math.random() * 89999);

      await query(
        `UPDATE contrats SET statut = 'signe', contenu_hash = $1, reference_signature = $2, signed_at = NOW() WHERE id = $3`,
        [hash, reference, contrat.id]
      );

      await query(`INSERT INTO documents (contrat_id, type, url) VALUES ($1,'contrat_pdf',$2)`, [
        contrat.id, `/contrats/${contrat.id}/pdf`,
      ]);

      await auditLog(req.user.id, "contrat_archive", { contrat_id: contrat.id, reference });
      await notify(updated.bailleur_id, `Bail "${updated.titre}" signé électroniquement · Réf. ${reference}`, "sms");
      await notify(updated.locataire_id, `Bail "${updated.titre}" signé électroniquement · Réf. ${reference}`, "sms");

      return res.json({
        message: "Signature enregistrée. Les deux parties ayant signé, le contrat est archivé.",
        statut: "signe",
        reference_signature: reference,
      });
    }

    await notify(
      estBailleur ? contrat.locataire_id : contrat.bailleur_id,
      `${estBailleur ? contrat.bailleur_nom : contrat.locataire_nom} a signé le bail "${contrat.titre}". À votre tour.`,
      "sms"
    );

    res.json({ message: "Votre signature est enregistrée. En attente de la seconde partie." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── PDF du contrat signé (accessible via lien direct : ?token=... ou header Authorization) ──
router.get("/:id/pdf", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: "Authentification requise." });
    let user;
    try { user = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ error: "Session invalide ou expirée." }); }

    const contrat = await getContrat(req.params.id);
    if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
    if (contrat.bailleur_id !== user.id && contrat.locataire_id !== user.id) {
      return res.status(403).json({ error: "Ce contrat ne vous concerne pas." });
    }
    if (contrat.statut !== "signe") return res.status(400).json({ error: "Ce contrat n'est pas encore signé." });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="bail-${contrat.reference_signature}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 56 });
    doc.pipe(res);

    const NAVY = "#0D1B3E", GOLD = "#C9963A", MUTED = "#5B6072";

    doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
    doc.fillColor(GOLD).fontSize(22).font("Helvetica-Bold").text("IBS", 56, 28);
    doc.fillColor("#FFFFFF").fontSize(11).font("Helvetica").text("Immo-Bail Solution — Contrat de bail", 56, 55);

    doc.moveDown(3);
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold").text("Contrat de bail à usage d'habitation", { align: "left" });
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(`Référence de signature : ${contrat.reference_signature}`);
    doc.moveDown(1.2);

    function row(label, value) {
      doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(label, { continued: false });
      doc.fillColor(NAVY).fontSize(11).font("Helvetica-Bold").text(value || "—");
      doc.moveDown(0.6);
    }

    doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text("Parties");
    doc.moveDown(0.3);
    row("Bailleur", `${contrat.bailleur_nom} — ${contrat.bailleur_telephone}`);
    row("Locataire", `${contrat.locataire_nom} — ${contrat.locataire_telephone}`);

    doc.moveDown(0.5);
    doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text("Bien loué");
    doc.moveDown(0.3);
    row("Désignation", contrat.titre);
    row("Adresse", contrat.adresse || contrat.commune);
    row("Commune", contrat.commune);

    doc.moveDown(0.5);
    doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text("Conditions financières");
    doc.moveDown(0.3);
    row("Loyer mensuel", `${contrat.loyer_usd} USD`);
    row("Durée du bail", `${contrat.duree_mois} mois`);
    row("Commission IBS (50% d'un mois, à la signature)", `${contrat.commission_usd} USD`);
    row("Réception des loyers", contrat.reception_loyer);

    doc.moveDown(0.5);
    doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text("Signature électronique");
    doc.moveDown(0.3);
    row("Signé le", new Date(contrat.signed_at).toLocaleString("fr-FR"));
    row("Référence", contrat.reference_signature);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica").text(`Empreinte SHA-256 du document : ${contrat.contenu_hash}`, { width: 480 });

    doc.moveDown(2);
    doc.fillColor(MUTED).fontSize(8).font("Helvetica-Oblique").text(
      "Ce document a été généré et signé électroniquement via la plateforme IBS — Immo-Bail Solution. " +
      "Le paiement du loyer et la commission se règlent hors plateforme durant cette phase pilote (V0).",
      { width: 480 }
    );

    doc.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "Erreur serveur." });
  }
});

module.exports = router;

const express = require("express");
const PDFDocument = require("pdfkit");
const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { requireAuth, JWT_SECRET, agenceIdDe } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

async function getContratPourPartie(contratId, user) {
  const r = await query(`SELECT * FROM contrats WHERE id = $1`, [contratId]);
  const c = r.rows[0];
  if (!c) return null;
  if (c.bailleur_id !== agenceIdDe(user) && c.locataire_id !== user.id) return "forbidden";
  return c;
}

// ── Déclarer un mois payé (locataire ou bailleur, contrat signé uniquement) ──
router.post("/", requireAuth, async (req, res) => {
  try {
    const { contrat_id, mois, montant_usd, moyen } = req.body;
    if (!contrat_id || !mois || !montant_usd) return res.status(400).json({ error: "contrat_id, mois et montant_usd sont requis." });

    const c = await getContratPourPartie(contrat_id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut !== "signe") return res.status(403).json({ error: "Le carnet de loyer n'est disponible que pour un bail signé." });

    const moisDate = mois.length === 7 ? mois + "-01" : mois; // accepte "2026-09" ou "2026-09-01"

    await query(
      `INSERT INTO paiements_loyer (contrat_id, mois, montant_usd, moyen, declare_par)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (contrat_id, mois) DO UPDATE SET montant_usd = $3, moyen = $4, declare_par = $5`,
      [contrat_id, moisDate, montant_usd, moyen || null, req.user.id]
    );
    await auditLog(req.user.id, "loyer_declare_paye", { contrat_id, mois: moisDate });
    res.status(201).json({ message: "Mois marqué comme payé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Voir le carnet complet d'un contrat (échéancier calculé + paiements déclarés) ──
router.get("/contrat/:contrat_id", requireAuth, async (req, res) => {
  try {
    const c = await getContratPourPartie(req.params.contrat_id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.statut !== "signe") return res.status(403).json({ error: "Le carnet de loyer n'est disponible que pour un bail signé." });

    const paiements = await query(
      `SELECT mois, montant_usd, moyen, declare_par, created_at FROM paiements_loyer WHERE contrat_id = $1 ORDER BY mois ASC`,
      [c.id]
    );
    const payesParMois = new Map(paiements.rows.map(p => [p.mois.toISOString().slice(0, 7), p]));

    const debut = new Date(c.signed_at || c.created_at);
    debut.setDate(1);
    const aujourdHui = new Date(); aujourdHui.setDate(1);

    const echeancier = [];
    for (let i = 0; i < c.duree_mois; i++) {
      const d = new Date(debut); d.setMonth(d.getMonth() + i);
      const cle = d.toISOString().slice(0, 7);
      const paiement = payesParMois.get(cle);
      let statut;
      if (paiement) statut = "paye";
      else if (d < aujourdHui) statut = "en_retard";
      else if (d.getTime() === aujourdHui.getTime()) statut = "du_ce_mois";
      else statut = "a_venir";
      echeancier.push({ mois: cle, montant_usd: paiement ? paiement.montant_usd : c.loyer_usd, statut, moyen: paiement ? paiement.moyen : null });
    }

    const moisEnRetard = echeancier.filter(e => e.statut === "en_retard").length;
    res.json({ echeancier, mois_en_retard: moisEnRetard, loyer_usd: c.loyer_usd, duree_mois: c.duree_mois });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Reçu de paiement PDF pour un mois donné (déclaratif : IBS ne transite jamais les fonds) ──
router.get("/:contrat_id/recu/:mois", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: "Authentification requise." });
    let user;
    try { user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: "Session invalide ou expirée." }); }

    const c = await getContratPourPartie(req.params.contrat_id, user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });

    const moisDate = req.params.mois.length === 7 ? req.params.mois + "-01" : req.params.mois;
    const p = await query(
      `SELECT pl.*, pr.titre, pr.commune, b.nom AS bailleur_nom, l.nom AS locataire_nom
       FROM paiements_loyer pl
       JOIN contrats c2 ON c2.id = pl.contrat_id
       JOIN offres o ON o.id = c2.offre_id
       JOIN proprietes pr ON pr.id = o.propriete_id
       JOIN users b ON b.id = c2.bailleur_id
       JOIN users l ON l.id = c2.locataire_id
       WHERE pl.contrat_id = $1 AND pl.mois = $2`,
      [req.params.contrat_id, moisDate]
    );
    if (!p.rows.length) return res.status(404).json({ error: "Aucun paiement déclaré pour ce mois." });
    const paiement = p.rows[0];

    const NAVY = "#0D1B3E", GOLD = "#C9963A", MUTED = "#5B6072";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ibs-recu-${req.params.contrat_id}-${moisDate.slice(0, 7)}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 56 });
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
    doc.fillColor(GOLD).fontSize(22).font("Helvetica-Bold").text("IBS", 56, 28);
    doc.fillColor("#FFFFFF").fontSize(11).font("Helvetica").text("Immo-Bail Solution — Reçu de paiement de loyer", 56, 55);

    doc.moveDown(3);
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold").text(`Reçu — ${new Date(moisDate).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}`);
    doc.moveDown(1);

    function ligne(label, valeur) {
      doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(label);
      doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text(String(valeur));
      doc.moveDown(0.6);
    }
    ligne("Bien concerné", `${paiement.titre} — ${paiement.commune}`);
    ligne("Bailleur", paiement.bailleur_nom);
    ligne("Locataire", paiement.locataire_nom);
    ligne("Montant déclaré payé", `${paiement.montant_usd} USD`);
    ligne("Moyen de paiement", paiement.moyen || "Non précisé");
    ligne("Déclaré le", new Date(paiement.created_at).toLocaleDateString("fr-FR"));

    doc.moveDown(1);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica-Oblique").text(
      "Ce reçu reflète une déclaration faite dans le carnet de loyer IBS par l'une des parties. " +
      "IBS ne transite jamais les fonds — ce document n'est pas une preuve de virement bancaire.",
      { width: 480 }
    );

    doc.end();
  } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

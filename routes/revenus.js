const express = require("express");
const PDFDocument = require("pdfkit");
const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { requireAuth, requireRole, JWT_SECRET, agenceIdDe } = require("../auth");

const router = express.Router();

const MOIS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

// ── Authentifie soit via header Bearer (appels API normaux), soit via ?token= (liens de téléchargement direct) ──
function authFromHeaderOrQuery(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

async function chargerDonneesRevenus(bailleurId) {
  const contrats = await query(
    `SELECT c.id, c.loyer_usd, c.signed_at, c.duree_mois, c.reference_signature,
            p.titre, p.commune, u.nom AS locataire_nom
     FROM contrats c
     JOIN offres o ON o.id = c.offre_id
     JOIN proprietes p ON p.id = o.propriete_id
     JOIN users u ON u.id = c.locataire_id
     WHERE c.bailleur_id = $1 AND c.statut = 'signe'
     ORDER BY c.signed_at DESC`,
    [bailleurId]
  );

  const moisCourant = new Date().toISOString().slice(0, 7) + "-01";
  const paiementsMois = await query(
    `SELECT pl.contrat_id, pl.montant_usd, pl.moyen
     FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
     WHERE c.bailleur_id = $1 AND pl.mois = $2`,
    [bailleurId, moisCourant]
  );
  const payesParContrat = new Map(paiementsMois.rows.map(p => [p.contrat_id, p]));

  const parBien = contrats.rows.map(c => {
    const paiement = payesParContrat.get(c.id);
    return {
      contrat_id: c.id, titre: c.titre, commune: c.commune, locataire_nom: c.locataire_nom,
      loyer_usd: c.loyer_usd, reference_signature: c.reference_signature,
      statut_mois: paiement ? "paye" : "attente", montant_paye: paiement ? paiement.montant_usd : 0,
    };
  });

  const revenuMensuelPotentiel = contrats.rows.reduce((s, c) => s + Number(c.loyer_usd), 0);
  const encaisseMois = paiementsMois.rows.reduce((s, p) => s + Number(p.montant_usd), 0);
  const tauxRecouvrement = revenuMensuelPotentiel > 0 ? Math.round((encaisseMois / revenuMensuelPotentiel) * 1000) / 10 : 0;

  // ── Historique 6 mois : encaissements réels ; l'attendu est approximé par le revenu potentiel actuel
  //    (simplification V0 — ne recalcule pas la composition exacte du portefeuille mois par mois) ──
  const histo = await query(
    `SELECT to_char(pl.mois,'YYYY-MM') AS mois, SUM(pl.montant_usd) AS encaisse
     FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
     WHERE c.bailleur_id = $1 AND pl.mois >= date_trunc('month', NOW()) - INTERVAL '5 months'
     GROUP BY to_char(pl.mois,'YYYY-MM')`,
    [bailleurId]
  );
  const encaisseParMois = new Map(histo.rows.map(h => [h.mois, Number(h.encaisse)]));
  const historique6Mois = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const cle = d.toISOString().slice(0, 7);
    historique6Mois.push({
      mois: MOIS_FR[d.getMonth()], attendu: revenuMensuelPotentiel, encaisse: encaisseParMois.get(cle) || 0,
    });
  }

  return {
    baux_actifs: contrats.rows.length, revenu_mensuel_potentiel: revenuMensuelPotentiel,
    encaisse_mois: encaisseMois, taux_recouvrement: tauxRecouvrement,
    historique_6_mois: historique6Mois, par_bien: parBien,
  };
}

// ── Tableau de bord (JSON, pour l'écran de l'app) ──
router.get("/tableau-bord", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    res.json(await chargerDonneesRevenus(agenceIdDe(req.user)));
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Export CSV (s'ouvre nativement dans Excel/Sheets) ──
router.get("/export.csv", async (req, res) => {
  try {
    const user = authFromHeaderOrQuery(req);
    if (!user) return res.status(401).json({ error: "Authentification requise." });

    const paiements = await query(
      `SELECT p.titre, p.commune, u.nom AS locataire_nom, c.loyer_usd, c.reference_signature,
              pl.mois, pl.montant_usd, pl.moyen, pl.created_at
       FROM contrats c
       JOIN offres o ON o.id = c.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = c.locataire_id
       LEFT JOIN paiements_loyer pl ON pl.contrat_id = c.id
       WHERE c.bailleur_id = $1 AND c.statut = 'signe'
       ORDER BY p.titre, pl.mois`,
      [agenceIdDe(user)]
    );

    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Bien", "Commune", "Locataire", "Réf. contrat", "Loyer mensuel USD", "Mois", "Montant payé USD", "Moyen", "Date déclaration"];
    const lignes = paiements.rows.map(r => [
      r.titre, r.commune, r.locataire_nom, r.reference_signature, r.loyer_usd,
      r.mois ? r.mois.toISOString().slice(0, 7) : "",
      r.montant_usd || "", r.moyen || "", r.created_at ? new Date(r.created_at).toLocaleDateString("fr-FR") : "",
    ].map(escape).join(","));
    const csv = "\uFEFF" + [header.map(escape).join(","), ...lignes].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ibs-recapitulatif-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Export PDF (récapitulatif visuel) ──
router.get("/export.pdf", async (req, res) => {
  try {
    const user = authFromHeaderOrQuery(req);
    if (!user) return res.status(401).json({ error: "Authentification requise." });

    const agenceId = agenceIdDe(user);
    const u = await query(`SELECT nom FROM users WHERE id = $1`, [agenceId]);
    const data = await chargerDonneesRevenus(agenceId);

    const NAVY = "#0D1B3E", GOLD = "#C9963A", MUTED = "#5B6072", GR = "#2F6B4A";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="ibs-revenus-${new Date().toISOString().slice(0, 10)}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 56 });
    doc.pipe(res);

    doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
    doc.fillColor(GOLD).fontSize(22).font("Helvetica-Bold").text("IBS", 56, 28);
    doc.fillColor("#FFFFFF").fontSize(11).font("Helvetica").text("Immo-Bail Solution — Récapitulatif revenus locatifs", 56, 55);

    doc.moveDown(3);
    doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold").text(`${u.rows[0]?.nom || "Bailleur"}`);
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(`Généré le ${new Date().toLocaleDateString("fr-FR")}`);
    doc.moveDown(1);

    function stat(label, value) {
      doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(label, { continued: false });
      doc.fillColor(NAVY).fontSize(13).font("Helvetica-Bold").text(value);
      doc.moveDown(0.5);
    }
    stat("Baux actifs", String(data.baux_actifs));
    stat("Revenu mensuel potentiel", `${data.revenu_mensuel_potentiel} USD`);
    stat("Encaissé ce mois (déclaratif)", `${data.encaisse_mois} USD`);
    stat("Taux de recouvrement", `${data.taux_recouvrement} %`);

    doc.moveDown(0.8);
    doc.fillColor(NAVY).fontSize(12).font("Helvetica-Bold").text("Détail par bien");
    doc.moveDown(0.4);

    const colX = [56, 200, 320, 420, 490];
    doc.fillColor(MUTED).fontSize(8).font("Helvetica-Bold");
    doc.text("Bien", colX[0], doc.y, { width: 140, continued: false });
    doc.text("Locataire", colX[1], doc.y - 10, { width: 110 });
    doc.text("Loyer", colX[2], doc.y - 10, { width: 90 });
    doc.text("Ce mois", colX[3], doc.y - 10, { width: 100 });
    doc.moveDown(0.5);
    doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor("#E4DDC9").stroke();
    doc.moveDown(0.3);

    data.par_bien.forEach(b => {
      const y = doc.y;
      doc.fillColor(NAVY).fontSize(9).font("Helvetica").text(b.titre, colX[0], y, { width: 140 });
      doc.text(b.locataire_nom, colX[1], y, { width: 110 });
      doc.text(`${b.loyer_usd} USD`, colX[2], y, { width: 90 });
      doc.fillColor(b.statut_mois === "paye" ? GR : "#B5502F").font("Helvetica-Bold")
        .text(b.statut_mois === "paye" ? `✓ Payé (${b.montant_paye} USD)` : "En attente", colX[3], y, { width: 110 });
      doc.moveDown(0.6);
    });

    doc.moveDown(1);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica-Oblique").text(
      "Les montants \"encaissés\" reflètent les déclarations faites dans le carnet de loyer IBS. " +
      "IBS ne transite jamais les fonds — ce document est un récapitulatif déclaratif, pas une preuve de paiement bancaire.",
      { width: 480 }
    );

    doc.end();
  } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

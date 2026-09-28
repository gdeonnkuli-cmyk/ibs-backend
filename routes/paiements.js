const express = require("express");
const PDFDocument = require("pdfkit");
const jwt = require("jsonwebtoken");
const { query } = require("../db");
const { requireAuth, requireRole, JWT_SECRET, agenceIdDe } = require("../auth");
const { auditLog } = require("../audit");
const { appliquerFiligrane } = require("../pdfwatermark");
const { notify } = require("../notify");

const router = express.Router();

/** Un agent rattaché agit pour son agence : c'est l'id de l'agence qui fait foi. */
function estCoteBailleur(user, contrat) { return agenceIdDe(user) === contrat.bailleur_id; }
function estLocataire(user, contrat) { return user.id === contrat.locataire_id; }

function normaliserMois(mois) {
  return mois.length === 7 ? mois + "-01" : mois; // accepte "2026-09" ou "2026-09-01"
}

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

    const moisDate = normaliserMois(mois);
    const cotebailleur = estCoteBailleur(req.user, c);

    // Une déclaration du bailleur vaut quittance : il est le créancier, il n'a
    // aucun intérêt à reconnaître à tort un paiement. Une déclaration du
    // locataire, elle, affirme un fait à son avantage — elle attend donc la
    // confirmation du bailleur.
    const statut = cotebailleur ? "confirme" : "en_attente";

    const existant = await query(
      `SELECT statut, declare_par FROM paiements_loyer WHERE contrat_id = $1 AND mois = $2`,
      [contrat_id, moisDate]
    );
    if (existant.rows.length) {
      const e = existant.rows[0];
      // Un mois déjà reconnu payé ne se réécrit pas par une simple
      // redéclaration : seul le bailleur peut revenir sur sa parole.
      if (e.statut === "confirme" && !cotebailleur) {
        return res.status(409).json({ error: "Ce mois est déjà confirmé payé par le bailleur." });
      }
      if (e.statut === "en_attente" && !cotebailleur && e.declare_par !== req.user.id) {
        return res.status(409).json({ error: "Une déclaration est déjà en attente pour ce mois." });
      }
    }

    await query(
      `INSERT INTO paiements_loyer (contrat_id, mois, montant_usd, moyen, declare_par, statut, confirme_par, confirme_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (contrat_id, mois) DO UPDATE SET
         montant_usd = $3, moyen = $4, declare_par = $5, statut = $6,
         confirme_par = $7, confirme_at = $8,
         conteste_par = NULL, conteste_at = NULL, motif_contestation = NULL`,
      [contrat_id, moisDate, montant_usd, moyen || null, req.user.id, statut,
       cotebailleur ? req.user.id : null, cotebailleur ? new Date() : null]
    );
    await auditLog(req.user.id, "loyer_declare_paye", { contrat_id, mois: moisDate, statut });

    const libelleMois = moisDate.slice(0, 7);
    if (statut === "en_attente") {
      await notify(c.bailleur_id, `IBS : votre locataire déclare avoir payé le loyer de ${libelleMois} (${montant_usd} USD). Confirmez ou contestez dans l'application.`, "sms");
      return res.status(201).json({ message: "Déclaration enregistrée. Elle attend la confirmation du bailleur.", statut });
    }
    await notify(c.locataire_id, `IBS : votre bailleur a confirmé la réception du loyer de ${libelleMois} (${montant_usd} USD).`, "sms");
    res.status(201).json({ message: "Mois confirmé payé.", statut });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Confirmer une déclaration du locataire (bailleur uniquement) ──
router.post("/:contrat_id/:mois/confirmer", requireAuth, async (req, res) => {
  try {
    const c = await getContratPourPartie(req.params.contrat_id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (!estCoteBailleur(req.user, c)) {
      return res.status(403).json({ error: "Seul le bailleur confirme la réception d'un loyer." });
    }

    const moisDate = normaliserMois(req.params.mois);
    const r = await query(
      `UPDATE paiements_loyer
       SET statut = 'confirme', confirme_par = $3, confirme_at = NOW(),
           conteste_par = NULL, conteste_at = NULL, motif_contestation = NULL
       WHERE contrat_id = $1 AND mois = $2 AND statut <> 'confirme'
       RETURNING montant_usd`,
      [c.id, moisDate, req.user.id]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: "Aucune déclaration à confirmer pour ce mois." });
    }

    await auditLog(req.user.id, "loyer_confirme", { contrat_id: c.id, mois: moisDate });
    await notify(c.locataire_id, `IBS : votre bailleur a confirmé la réception du loyer de ${moisDate.slice(0, 7)} (${r.rows[0].montant_usd} USD).`, "sms");
    res.json({ message: "Paiement confirmé.", statut: "confirme" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Contester une déclaration faite par l'autre partie ──
// IBS constate le désaccord et le conserve ; elle ne tranche pas sur le fond.
router.post("/:contrat_id/:mois/contester", requireAuth, async (req, res) => {
  try {
    const { motif } = req.body;
    if (!motif || motif.trim().length < 5) {
      return res.status(400).json({ error: "Un motif d'au moins 5 caractères est requis." });
    }

    const c = await getContratPourPartie(req.params.contrat_id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });

    const moisDate = normaliserMois(req.params.mois);
    const existant = await query(
      `SELECT declare_par, statut FROM paiements_loyer WHERE contrat_id = $1 AND mois = $2`,
      [c.id, moisDate]
    );
    if (!existant.rows.length) return res.status(404).json({ error: "Aucune déclaration pour ce mois." });
    // On ne conteste pas sa propre déclaration : on la corrige.
    if (existant.rows[0].declare_par === req.user.id) {
      return res.status(403).json({ error: "Vous ne pouvez pas contester votre propre déclaration. Corrigez-la plutôt." });
    }
    if (existant.rows[0].statut === "conteste") {
      return res.status(409).json({ error: "Ce mois est déjà contesté." });
    }

    await query(
      `UPDATE paiements_loyer
       SET statut = 'conteste', conteste_par = $3, conteste_at = NOW(), motif_contestation = $4
       WHERE contrat_id = $1 AND mois = $2`,
      [c.id, moisDate, req.user.id, motif.trim()]
    );
    await auditLog(req.user.id, "loyer_conteste", { contrat_id: c.id, mois: moisDate, motif: motif.trim() });

    const libelle = moisDate.slice(0, 7);
    const autre = estCoteBailleur(req.user, c) ? c.locataire_id : c.bailleur_id;
    await notify(autre, `IBS : le paiement du loyer de ${libelle} est contesté. Motif : ${motif.trim()}. Rapprochez-vous de l'autre partie ou de l'équipe IBS.`, "sms");
    await notify(req.user.id, `IBS : votre contestation du loyer de ${libelle} est enregistrée.`, "in_app");

    res.json({ message: "Contestation enregistrée. Les deux parties sont notifiées.", statut: "conteste" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Litiges ouverts (admin) ──
router.get("/admin/litiges", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(
      `SELECT pl.contrat_id, to_char(pl.mois, 'YYYY-MM') AS mois, pl.montant_usd,
              pl.motif_contestation, pl.conteste_at,
              pr.titre, pr.commune,
              d.nom AS declare_par_nom, d.telephone AS declare_par_tel,
              q.nom AS conteste_par_nom, q.telephone AS conteste_par_tel
       FROM paiements_loyer pl
       JOIN contrats c ON c.id = pl.contrat_id
       JOIN offres o ON o.id = c.offre_id
       JOIN proprietes pr ON pr.id = o.propriete_id
       LEFT JOIN users d ON d.id = pl.declare_par
       LEFT JOIN users q ON q.id = pl.conteste_par
       WHERE pl.statut = 'conteste'
       ORDER BY pl.conteste_at DESC`
    );
    res.json({ litiges: r.rows, total: r.rows.length });
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
      `SELECT mois, montant_usd, moyen, declare_par, statut, motif_contestation, created_at
       FROM paiements_loyer WHERE contrat_id = $1 ORDER BY mois ASC`,
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
      if (paiement) {
        // "paye" ne vaut que pour un mois confirmé : une déclaration en
        // attente ou contestée ne solde rien.
        statut = paiement.statut === "confirme" ? "paye"
               : paiement.statut === "en_attente" ? "en_attente_confirmation"
               : "conteste";
      }
      else if (d < aujourdHui) statut = "en_retard";
      else if (d.getTime() === aujourdHui.getTime()) statut = "du_ce_mois";
      else statut = "a_venir";
      echeancier.push({
        mois: cle,
        montant_usd: paiement ? paiement.montant_usd : c.loyer_usd,
        statut,
        moyen: paiement ? paiement.moyen : null,
        declare_par_moi: paiement ? paiement.declare_par === req.user.id : false,
        motif_contestation: paiement ? paiement.motif_contestation : null,
      });
    }

    // Le carnet dit si le paiement en ligne est ouvert sur ce bail : sans cela,
    // l'écran proposerait un bouton qui ne mène qu'à un refus.
    const compte = await query(
      `SELECT 1 FROM comptes_encaissement
       WHERE bailleur_id = $1 AND statut = 'actif' AND flw_subaccount_id IS NOT NULL`,
      [c.bailleur_id]
    );

    const moisEnRetard = echeancier.filter(e => e.statut === "en_retard").length;
    res.json({
      echeancier,
      paiement_mobile_possible: compte.rows.length > 0,
      mois_en_retard: moisEnRetard,
      mois_a_confirmer: echeancier.filter(e => e.statut === "en_attente_confirmation").length,
      mois_contestes: echeancier.filter(e => e.statut === "conteste").length,
      je_suis_bailleur: estCoteBailleur(req.user, c),
      loyer_usd: c.loyer_usd,
      duree_mois: c.duree_mois,
    });
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
      `SELECT pl.*, pr.titre, pr.commune, b.nom AS bailleur_nom, b.telephone AS bailleur_telephone,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone
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
    // Un reçu n'a de valeur que sur un paiement reconnu par le bailleur. En
    // émettre un sur une déclaration en attente ou contestée reviendrait à
    // fabriquer une preuve que personne n'a validée.
    if (paiement.statut !== "confirme") {
      return res.status(409).json({
        error: paiement.statut === "conteste"
          ? "Ce paiement est contesté : aucun reçu ne peut être émis."
          : "Ce paiement attend la confirmation du bailleur : le reçu sera disponible ensuite.",
      });
    }

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
    // Un loyer réglé par Mobile Money n'est pas une déclaration : la passerelle
    // a constaté le virement. Le reçu doit dire lequel des deux il atteste,
    // sans quoi il promettrait la même valeur probante aux deux.
    const parPasserelle = paiement.moyen === "mobile_money" && paiement.tx_ref;

    ligne(parPasserelle ? "Montant réglé" : "Montant déclaré payé", `${paiement.montant_usd} USD`);
    ligne("Moyen de paiement", parPasserelle ? "Mobile Money" : (paiement.moyen || "Non précisé"));
    if (parPasserelle) {
      ligne("Référence de transaction", paiement.tx_ref);
      ligne("Réglé le", new Date(paiement.confirme_at || paiement.created_at).toLocaleDateString("fr-FR"));
    } else {
      ligne("Déclaré le", new Date(paiement.created_at).toLocaleDateString("fr-FR"));
      ligne("Confirmé par le bailleur le", paiement.confirme_at ? new Date(paiement.confirme_at).toLocaleDateString("fr-FR") : "—");
    }

    doc.moveDown(1);
    doc.fillColor(MUTED).fontSize(7.5).font("Helvetica-Oblique").text(
      parPasserelle
        ? "Ce reçu atteste d'un loyer réglé par Mobile Money via la passerelle de paiement, et reversé "
          + "directement sur le compte d'encaissement du bailleur. IBS ne détient à aucun moment ces fonds. "
          + "La référence de transaction ci-dessus permet de retrouver le virement auprès de l'opérateur."
        : "Ce reçu atteste d'un paiement déclaré dans le carnet de loyer IBS et confirmé par le bailleur. "
          + "IBS ne transite jamais les fonds — ce document n'est pas une preuve de virement bancaire.",
      { width: 480 }
    );

    appliquerFiligrane(doc, {
      nom: user.nom,
      telephone: agenceIdDe(user) === c.bailleur_id ? paiement.bailleur_telephone : paiement.locataire_telephone,
    });

    doc.end();
  } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

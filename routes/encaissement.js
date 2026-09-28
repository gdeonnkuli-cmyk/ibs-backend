// encaissement.js — Paiement du loyer par Mobile Money.
//
// Choix d'architecture, parce qu'il engage la plateforme bien au-delà du code :
// IBS ne touche pas l'argent du loyer. Le bailleur déclare son compte
// d'encaissement (numéro Mobile Money ou compte bancaire), la passerelle en
// fait un sous-compte, et chaque loyer payé est reversé directement sur ce
// sous-compte. La plateforme n'est jamais bénéficiaire des fonds.
//
// L'autre architecture — encaisser sur le compte d'IBS puis reverser — ferait
// détenir à la plateforme l'argent d'autrui, ce qui relève en RDC du statut
// d'établissement de paiement. Le reçu de loyer affirme depuis toujours qu'IBS
// ne transite jamais les fonds ; encaisser rendrait cette phrase fausse.
//
// Conséquence sur la validation : un loyer payé par Mobile Money n'a pas besoin
// d'être confirmé par le bailleur. La déclaration à deux parties existait parce
// que l'argent passait de la main à la main et que nul ne pouvait le prouver.
// Ici la passerelle atteste le virement, et le mois est soldé d'office.

const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole, agenceIdDe } = require("../auth");
const { auditLog } = require("../audit");
const { notify } = require("../notify");
const passerelle = require("../passerelles");

const router = express.Router();

const WEBHOOK_SECRET = process.env.FLUTTERWAVE_WEBHOOK_SECRET || "";
const REDIRECT_URL = process.env.FLUTTERWAVE_REDIRECT_URL || "";

// Part prélevée par IBS sur chaque loyer, en pourcentage. À zéro par défaut :
// un taux de commission est une décision commerciale, pas une valeur qu'un
// fichier de code peut se permettre d'inventer.
const COMMISSION_PCT = Math.min(Math.max(Number(process.env.IBS_COMMISSION_LOYER_PCT) || 0, 0), 50);

const OPERATEURS = ["m-pesa", "orange-money", "airtel-money", "africell-money"];

// Deux façons dont l'argent peut aller du locataire au bailleur :
//
//   · "direct" — la passerelle reverse elle-même sur le compte du bailleur
//     (sous-comptes, split). IBS n'est jamais détentrice des fonds. C'est le
//     modèle à préférer, et celui que le reçu de loyer décrit depuis toujours.
//
//   · "transit" — la passerelle encaisse sur le compte marchand d'IBS, qui
//     reverse ensuite au bailleur par décaissement. C'est le seul mode que
//     permettent les passerelles congolaises (FlexPay, MaxiCash), et il fait
//     transiter par IBS l'argent d'autrui — ce qui relève en RDC du statut
//     d'établissement de paiement.
//
// Le mode transit ne s'active donc pas tout seul : il demande de poser
// ENCAISSEMENT_TRANSIT_ASSUME=oui, pour qu'aucune configuration distraite ne
// mette la plateforme dans cette position sans que personne l'ait voulu.
const TRANSIT_ASSUME = process.env.ENCAISSEMENT_TRANSIT_ASSUME === "oui";
const MODE = passerelle.supporteBeneficiaires ? "direct" : "transit";

function passerelleConfiguree() {
  const pbm = passerelle.indisponible();
  if (pbm) return "Paiement du loyer indisponible : " + pbm;
  if (!REDIRECT_URL) return "Paiement du loyer indisponible : URL de retour non configurée côté serveur.";
  if (MODE === "transit") {
    if (!passerelle.supporteReversement) {
      return `Paiement du loyer indisponible : la passerelle « ${passerelle.nom} » ne sait ni reverser au bailleur ni décaisser.`;
    }
    if (!TRANSIT_ASSUME) {
      return `Paiement du loyer indisponible : la passerelle « ${passerelle.nom} » encaisse sur le compte d'IBS. `
        + `Ce mode fait transiter les loyers par la plateforme et doit être assumé explicitement `
        + `(ENCAISSEMENT_TRANSIT_ASSUME=oui).`;
    }
  }
  return null;
}

const normaliserMois = (mois) => (mois.length === 7 ? mois + "-01" : mois);

async function getContratPourPartie(contratId, user) {
  const r = await query(`SELECT * FROM contrats WHERE id = $1`, [contratId]);
  const c = r.rows[0];
  if (!c) return null;
  if (c.bailleur_id !== agenceIdDe(user) && c.locataire_id !== user.id) return "forbidden";
  return c;
}

// ── Compte d'encaissement du bailleur ────────────────────────────────────

router.get("/compte", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT type, operateur, numero, titulaire, statut, flw_subaccount_id IS NOT NULL AS relie, created_at
       FROM comptes_encaissement WHERE bailleur_id = $1`,
      [agenceIdDe(req.user)]
    );
    if (!r.rows.length) return res.json({ configure: false, operateurs: OPERATEURS });
    const c = r.rows[0];
    res.json({
      configure: true,
      operateurs: OPERATEURS,
      ...c,
      // Le numéro complet n'a pas à ressortir de la base une fois posé : il
      // suffit au bailleur de reconnaître le sien.
      numero: c.numero.replace(/.(?=.{3})/g, "•"),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/compte", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    const pbm = passerelleConfiguree();
    if (pbm) return res.status(503).json({ error: pbm });

    const { type, operateur, numero, titulaire } = req.body;
    if (!["mobile_money", "banque"].includes(type)) {
      return res.status(400).json({ error: "Type de compte invalide (mobile_money ou banque)." });
    }
    if (type === "mobile_money" && !OPERATEURS.includes(operateur)) {
      return res.status(400).json({ error: `Opérateur invalide. Attendu : ${OPERATEURS.join(", ")}.` });
    }
    if (!numero || String(numero).trim().length < 6) {
      return res.status(400).json({ error: "Numéro ou compte invalide." });
    }
    if (!titulaire || String(titulaire).trim().length < 3) {
      return res.status(400).json({ error: "Le nom du titulaire est requis." });
    }

    const agenceId = agenceIdDe(req.user);
    const u = await query(`SELECT nom, telephone FROM users WHERE id = $1`, [agenceId]);
    const user = u.rows[0];

    // La passerelle tient le sous-compte : c'est lui qui fait que l'argent va
    // au bailleur et non à IBS. Sans lui, aucun paiement ne doit être proposé.
    let subaccountId = null;
    try {
      const b = await passerelle.creerBeneficiaire({
        type,
        operateur,
        numero: String(numero).trim(),
        titulaire: String(titulaire).trim(),
        commissionPct: COMMISSION_PCT,
        bailleur: user,
      });
      subaccountId = b.id;
    } catch (e) {
      // Le message de l'adaptateur est destiné au bailleur : il dit ce qu'il
      // peut corriger. Une panne réseau n'en porte pas, d'où le repli.
      console.error(`Passerelle ${passerelle.nom} :`, e.message);
      return res.status(502).json({
        error: e.message || "Passerelle de paiement injoignable. Réessayez dans un moment.",
      });
    }

    await query(
      `INSERT INTO comptes_encaissement (bailleur_id, type, operateur, numero, titulaire, flw_subaccount_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (bailleur_id) DO UPDATE SET
         type = $2, operateur = $3, numero = $4, titulaire = $5,
         flw_subaccount_id = $6, statut = 'actif', updated_at = NOW()`,
      [agenceId, type, operateur || null, String(numero).trim(), String(titulaire).trim(), subaccountId]
    );
    // Le numéro n'entre pas dans le journal : il suffit de savoir qu'il a changé.
    await auditLog(req.user.id, "compte_encaissement_declare", { type, operateur: operateur || null });

    res.status(201).json({
      message: "Compte d'encaissement enregistré. Vos locataires peuvent désormais payer par Mobile Money.",
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Payer un mois de loyer (locataire) ───────────────────────────────────

router.post("/:contrat_id/:mois/initier", requireAuth, async (req, res) => {
  try {
    const pbm = passerelleConfiguree();
    if (pbm) return res.status(503).json({ error: pbm });

    const c = await getContratPourPartie(req.params.contrat_id, req.user);
    if (!c) return res.status(404).json({ error: "Contrat introuvable." });
    if (c === "forbidden") return res.status(403).json({ error: "Vous n'êtes pas partie à ce contrat." });
    if (c.locataire_id !== req.user.id) {
      return res.status(403).json({ error: "Seul le locataire règle son loyer." });
    }
    if (!["signe", "preavis"].includes(c.statut)) {
      return res.status(409).json({ error: "Ce bail n'est pas en cours." });
    }

    const moisDate = normaliserMois(req.params.mois);
    const deja = await query(
      `SELECT statut FROM paiements_loyer WHERE contrat_id = $1 AND mois = $2`, [c.id, moisDate]);
    if (deja.rows.length && deja.rows[0].statut === "confirme") {
      return res.status(409).json({ error: "Ce mois est déjà soldé." });
    }

    const compte = await query(
      `SELECT flw_subaccount_id FROM comptes_encaissement
       WHERE bailleur_id = $1 AND statut = 'actif' AND flw_subaccount_id IS NOT NULL`,
      [c.bailleur_id]
    );
    if (!compte.rows.length) {
      return res.status(409).json({
        error: "Votre bailleur n'a pas encore déclaré de compte d'encaissement. Réglez ce mois autrement et déclarez-le dans le carnet.",
      });
    }

    const montant = Number(c.loyer_usd);
    const tx_ref = `IBS-LOYER-${c.id}-${moisDate.slice(0, 7)}-${Date.now()}`;
    const u = await query(`SELECT nom, telephone FROM users WHERE id = $1`, [req.user.id]);
    const loc = u.rows[0];

    let lien;
    try {
      // Le bénéficiaire est le bailleur : c'est ce qui fait que l'argent ne
      // passe pas par IBS.
      const p = await passerelle.creerPaiement({
        txRef: tx_ref,
        montant,
        devise: "USD",
        redirectUrl: REDIRECT_URL,
        client: loc,
        beneficiaireId: compte.rows[0].flw_subaccount_id,
        libelle: `Loyer de ${moisDate.slice(0, 7)}`,
      });
      lien = p.lien;
    } catch (e) {
      console.error(`Passerelle ${passerelle.nom} :`, e.message);
      return res.status(502).json({ error: e.message || "Passerelle de paiement injoignable." });
    }

    await query(
      `INSERT INTO encaissements (contrat_id, mois, locataire_id, montant_usd, tx_ref)
       VALUES ($1,$2,$3,$4,$5)`,
      [c.id, moisDate, req.user.id, montant, tx_ref]
    );
    await auditLog(req.user.id, "loyer_paiement_initie", { contrat_id: c.id, mois: moisDate, tx_ref });

    res.json({ link: lien, tx_ref, montant_usd: montant });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

/**
 * Solde le mois à partir d'une transaction réussie.
 *
 * Idempotent, et il faut qu'il le soit : le retour du navigateur et le webhook
 * de la passerelle arrivent tous les deux, parfois en même temps. Le passage de
 * 'initie' à 'reussi' se fait par un UPDATE conditionnel — un seul appel voit
 * la ligne changer, un seul notifie.
 */
async function crediterMois(txRef, flwTransactionId) {
  const r = await query(
    `UPDATE encaissements
     SET statut = 'reussi', flw_transaction_id = $2, confirme_at = NOW(),
         reversement_statut = $3
     WHERE tx_ref = $1 AND statut <> 'reussi'
     RETURNING contrat_id, mois, montant_usd, locataire_id`,
    [txRef, flwTransactionId ? String(flwTransactionId) : null,
     MODE === "transit" ? "a_reverser" : "non_requis"]
  );
  if (!r.rows.length) return null;
  const e = r.rows[0];

  const c = await query(`SELECT bailleur_id, locataire_id FROM contrats WHERE id = $1`, [e.contrat_id]);
  if (!c.rows.length) return null;

  // Soldé sans confirmation du bailleur : la passerelle atteste le virement, il
  // n'y a plus de parole à croire sur la sienne.
  await query(
    `INSERT INTO paiements_loyer (contrat_id, mois, montant_usd, moyen, declare_par, statut, confirme_at, tx_ref, encaissement_mode)
     VALUES ($1,$2,$3,'mobile_money',$4,'confirme',NOW(),$5,$6)
     ON CONFLICT (contrat_id, mois) DO UPDATE SET
       montant_usd = $3, moyen = 'mobile_money', statut = 'confirme', confirme_at = NOW(),
       tx_ref = $5, encaissement_mode = $6,
       conteste_par = NULL, conteste_at = NULL, motif_contestation = NULL`,
    [e.contrat_id, e.mois, e.montant_usd, e.locataire_id, txRef, MODE]
  );

  const libelle = new Date(e.mois).toISOString().slice(0, 7);
  // Le mois est soldé pour le locataire dans les deux modes. Ce qui change,
  // c'est où est l'argent : le bailleur ne doit pas croire l'avoir reçu tant
  // que le reversement n'est pas parti.
  await notify(e.locataire_id,
    `IBS : votre loyer de ${libelle} est réglé (${e.montant_usd} USD). Le reçu est disponible dans votre carnet.`, "sms");

  if (MODE === "transit") {
    await reverserAuBailleur(txRef, c.rows[0].bailleur_id, e, libelle);
  } else {
    await notify(c.rows[0].bailleur_id,
      `IBS : loyer de ${libelle} reçu (${e.montant_usd} USD) par Mobile Money. Les fonds sont versés sur votre compte d'encaissement.`, "sms");
  }

  return { contrat_id: e.contrat_id, mois: libelle, montant_usd: e.montant_usd, mode: MODE };
}

/**
 * Porte au bailleur un loyer encaissé sur le compte d'IBS.
 *
 * Lancé aussitôt après le crédit : plus les fonds séjournent chez IBS, moins la
 * plateforme est un simple intermédiaire. Un échec n'annule pas le paiement du
 * locataire — son mois est réglé, c'est la dette d'IBS envers le bailleur qui
 * reste ouverte, et elle doit rester visible jusqu'à extinction.
 */
async function reverserAuBailleur(txRef, bailleurId, e, libelle) {
  const compte = await query(
    `SELECT numero FROM comptes_encaissement WHERE bailleur_id = $1 AND statut = 'actif'`,
    [bailleurId]
  );
  if (!compte.rows.length) {
    await query(
      `UPDATE encaissements SET reversement_statut = 'echoue',
         reversement_motif = 'aucun compte d''encaissement actif'
       WHERE tx_ref = $1`, [txRef]);
    console.error(`[REVERSEMENT] ${txRef} : le bailleur #${bailleurId} n'a plus de compte actif.`);
    return;
  }

  try {
    const r = await passerelle.reverser({
      montant: e.montant_usd,
      devise: "USD",
      destinataire: compte.rows[0].numero,
      reference: `REV-${txRef}`,
    });
    await query(
      `UPDATE encaissements
       SET reversement_statut = 'reverse', reversement_ref = $2, reversement_at = NOW(),
           reversement_motif = NULL, reversement_tentatives = reversement_tentatives + 1
       WHERE tx_ref = $1`,
      [txRef, r.reference || null]
    );
    await notify(bailleurId,
      `IBS : loyer de ${libelle} reçu (${e.montant_usd} USD) et reversé sur votre compte d'encaissement.`, "sms");
  } catch (err) {
    await query(
      `UPDATE encaissements
       SET reversement_statut = 'echoue', reversement_motif = $2,
           reversement_tentatives = reversement_tentatives + 1
       WHERE tx_ref = $1`,
      [txRef, String(err.message).slice(0, 300)]
    );
    console.error(`[REVERSEMENT] ${txRef} en échec :`, err.message);
    // Le bailleur est prévenu que l'argent est arrivé mais pas encore chez lui :
    // le silence ici ferait passer un retard technique pour un impayé.
    await notify(bailleurId,
      `IBS : loyer de ${libelle} (${e.montant_usd} USD) bien reçu de votre locataire. Le versement sur votre compte est en cours de traitement.`, "sms");
  }
}

// ── Vérification au retour du navigateur (locataire) ─────────────────────
router.post("/verifier", requireAuth, async (req, res) => {
  try {
    const pbm = passerelle.indisponible();
    if (pbm) return res.status(503).json({ error: pbm });
    const { transaction_id, tx_ref } = req.body;
    if (!transaction_id || !tx_ref) {
      return res.status(400).json({ error: "transaction_id et tx_ref sont requis." });
    }

    const enc = await query(
      `SELECT * FROM encaissements WHERE tx_ref = $1 AND locataire_id = $2`, [tx_ref, req.user.id]);
    if (!enc.rows.length) return res.status(404).json({ error: "Référence de paiement introuvable." });
    if (enc.rows[0].statut === "reussi") {
      return res.json({ message: "Ce paiement est déjà enregistré.", statut: "confirme" });
    }

    let tx;
    try {
      tx = await passerelle.verifierTransaction(transaction_id);
    } catch (e) {
      console.error(`Passerelle ${passerelle.nom} :`, e.message);
      return res.status(502).json({ error: "Passerelle injoignable. Le paiement sera confirmé automatiquement." });
    }

    // Le montant est comparé à celui de la tentative, pas à celui que le client
    // annonce : sans cette vérification, il suffirait de payer un dollar.
    const attendu = Number(enc.rows[0].montant_usd);
    const valide = tx && tx.reussi && tx.txRef === tx_ref
      && tx.devise === "USD" && Number(tx.montant) >= attendu;

    if (!valide) {
      await query(
        `UPDATE encaissements SET statut = 'echoue', echec_motif = $2 WHERE tx_ref = $1 AND statut = 'initie'`,
        [tx_ref, tx ? `statut ${tx.statutBrut || (tx.reussi ? "reussi" : "echoue")}, montant ${tx.montant} ${tx.devise}` : "transaction introuvable"]
      );
      return res.status(402).json({ error: "Paiement non confirmé par la passerelle." });
    }

    const credite = await crediterMois(tx_ref, transaction_id);
    await auditLog(req.user.id, "loyer_paye_mobile_money", { tx_ref, ...(credite || {}) });
    res.json({ message: "Loyer réglé. Votre carnet est à jour.", statut: "confirme", ...(credite || {}) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Webhook de la passerelle ─────────────────────────────────────────────
// Le filet : un locataire qui ferme son navigateur avant la redirection a quand
// même payé, et son mois doit être soldé.
router.post("/webhook", express.json(), async (req, res) => {
  try {
    if (!WEBHOOK_SECRET) return res.status(503).end();
    if (!passerelle.signatureValide(req.headers, WEBHOOK_SECRET)) return res.status(401).end();

    const tx = passerelle.lireWebhook(req.body);
    if (tx?.reussi && tx.txRef && String(tx.txRef).startsWith("IBS-LOYER-")) {
      const enc = await query(`SELECT montant_usd FROM encaissements WHERE tx_ref = $1`, [tx.txRef]);
      // Même contrôle de montant qu'au retour navigateur : un webhook est une
      // entrée externe, pas une autorité.
      if (enc.rows.length && Number(tx.montant) >= Number(enc.rows[0].montant_usd) && tx.devise === "USD") {
        await crediterMois(tx.txRef, tx.transactionId);
      }
    }
    res.status(200).end();
  } catch (e) { console.error(e); res.status(500).end(); }
});

// ── Reversements en souffrance (admin) ───────────────────────────────────
// Un loyer encaissé mais non reversé est une dette d'IBS envers un bailleur.
// Sans cette liste, elle n'existerait que dans les logs.
router.get("/admin/reversements", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(
      `SELECT e.tx_ref, e.mois, e.montant_usd, e.reversement_statut, e.reversement_motif,
              e.reversement_tentatives, e.confirme_at, e.contrat_id,
              pr.titre, pr.commune,
              b.id AS bailleur_id, b.nom AS bailleur_nom, b.telephone AS bailleur_tel
       FROM encaissements e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN offres o ON o.id = c.offre_id
       JOIN proprietes pr ON pr.id = o.propriete_id
       JOIN users b ON b.id = c.bailleur_id
       WHERE e.statut = 'reussi' AND e.reversement_statut IN ('a_reverser','echoue')
       ORDER BY e.confirme_at ASC`
    );
    const total = r.rows.reduce((t, x) => t + Number(x.montant_usd), 0);
    res.json({ mode: MODE, reversements: r.rows, total: r.rows.length, montant_total_usd: total });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Rejouer un reversement (admin) ───────────────────────────────────────
router.post("/admin/reversements/:tx_ref/rejouer", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    if (MODE !== "transit") {
      return res.status(409).json({ error: "Les loyers sont reversés directement par la passerelle : rien à rejouer." });
    }
    const r = await query(
      `SELECT e.*, c.bailleur_id FROM encaissements e
       JOIN contrats c ON c.id = e.contrat_id
       WHERE e.tx_ref = $1 AND e.statut = 'reussi'`,
      [req.params.tx_ref]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Encaissement introuvable." });
    const e = r.rows[0];
    if (e.reversement_statut === "reverse") {
      return res.status(409).json({ error: "Ce loyer est déjà reversé." });
    }

    const libelle = new Date(e.mois).toISOString().slice(0, 7);
    await reverserAuBailleur(e.tx_ref, e.bailleur_id, e, libelle);
    await auditLog(req.user.id, "reversement_rejoue", { tx_ref: e.tx_ref });

    const apres = await query(`SELECT reversement_statut, reversement_motif FROM encaissements WHERE tx_ref = $1`, [e.tx_ref]);
    const statut = apres.rows[0];
    res.json({
      message: statut.reversement_statut === "reverse" ? "Loyer reversé au bailleur." : "Le reversement a de nouveau échoué.",
      ...statut,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

const express = require("express");
const { query } = require("../db");
const { requireAuth, agenceIdDe } = require("../auth");

const router = express.Router();

/**
 * Résumé de l'écran d'accueil.
 *
 * L'accueil était une liste de neuf liens identiques : il fallait ouvrir les
 * écrans un par un pour savoir s'il se passait quelque chose. Cette route rend
 * ce qui presse, par rôle, en un appel — l'argent d'abord, puis ce qui remplit
 * les biens, puis ce qui les vide.
 */

const DEBUT_MOIS = "date_trunc('month', NOW())";

async function resumeBailleur(user) {
  const id = agenceIdDe(user);

  const [candidatures, messages, visites, loyers, echeances, offres] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS n FROM demandes d
       JOIN offres o ON o.id = d.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = $1 AND d.statut = 'en_attente'`, [id]),
    query(
      `SELECT COUNT(*)::int AS n FROM messages m
       JOIN offres o ON o.id = m.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = $1 AND m.expediteur_id != $2 AND m.lu = FALSE`, [id, user.id]),
    query(
      `SELECT COUNT(*)::int AS n FROM visites
       WHERE bailleur_id = $1 AND statut IN ('en_attente','acceptee') AND date_proposee::date = CURRENT_DATE`, [id]),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE pl.statut = 'en_attente')::int AS a_confirmer,
         COUNT(*) FILTER (WHERE pl.statut = 'conteste')::int  AS contestes
       FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
       WHERE c.bailleur_id = $1`, [id]),
    // Baux signés dont le terme tombe dans les 30 jours.
    query(
      `SELECT COUNT(*)::int AS n FROM contrats
       WHERE bailleur_id = $1 AND statut = 'signe' AND signed_at IS NOT NULL
         AND (signed_at + (duree_mois || ' months')::interval) BETWEEN NOW() AND NOW() + INTERVAL '30 days'`, [id]),
    query(
      `SELECT COUNT(*)::int AS n FROM offres o
       JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = $1 AND o.statut = 'active'`, [id]),
  ]);

  return {
    role: "bailleur",
    loyers_a_confirmer: loyers.rows[0].a_confirmer,
    loyers_contestes: loyers.rows[0].contestes,
    candidatures_en_attente: candidatures.rows[0].n,
    baux_a_echeance: echeances.rows[0].n,
    messages_non_lus: messages.rows[0].n,
    visites_aujourdhui: visites.rows[0].n,
    offres_actives: offres.rows[0].n,
  };
}

async function resumeLocataire(user) {
  const id = user.id;

  const [candidatures, messages, contrats, paiements] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM demandes WHERE locataire_id = $1 AND statut = 'en_attente'`, [id]),
    query(
      `SELECT COUNT(*)::int AS n FROM messages
       WHERE locataire_id = $1 AND expediteur_id != $1 AND lu = FALSE`, [id]),
    query(
      `SELECT c.id, c.loyer_usd, c.duree_mois, c.signed_at,
              (c.signed_at + (c.duree_mois || ' months')::interval)::date AS fin
       FROM contrats c WHERE c.locataire_id = $1 AND c.statut = 'signe'`, [id]),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE pl.statut = 'en_attente')::int AS en_attente,
         COUNT(*) FILTER (WHERE pl.statut = 'conteste')::int   AS contestes,
         COUNT(*) FILTER (WHERE pl.mois = ${DEBUT_MOIS}::date AND pl.statut = 'confirme')::int AS mois_courant_paye
       FROM paiements_loyer pl JOIN contrats c ON c.id = pl.contrat_id
       WHERE c.locataire_id = $1`, [id]),
  ]);

  // Mois échus sans aucune ligne : le vrai retard, celui qui n'est pas déclaré.
  let moisEnRetard = 0, loyer = 0, joursAvantFin = null;
  for (const c of contrats.rows) {
    loyer = Number(c.loyer_usd);
    const debut = new Date(c.signed_at); debut.setDate(1);
    const courant = new Date(); courant.setDate(1);
    const echus = Math.min(
      Math.max(0, (courant.getFullYear() - debut.getFullYear()) * 12 + (courant.getMonth() - debut.getMonth())),
      c.duree_mois
    );
    const lignes = await query(
      `SELECT COUNT(*)::int AS n FROM paiements_loyer WHERE contrat_id = $1 AND mois < ${DEBUT_MOIS}`, [c.id]);
    moisEnRetard += Math.max(0, echus - lignes.rows[0].n);

    const jours = Math.ceil((new Date(c.fin) - new Date()) / 86400000);
    if (jours >= 0 && (joursAvantFin === null || jours < joursAvantFin)) joursAvantFin = jours;
  }

  return {
    role: "locataire",
    a_un_bail: contrats.rows.length > 0,
    loyer_usd: loyer,
    mois_en_retard: moisEnRetard,
    loyer_du_ce_mois: contrats.rows.length > 0 && paiements.rows[0].mois_courant_paye === 0,
    paiements_en_attente: paiements.rows[0].en_attente,
    paiements_contestes: paiements.rows[0].contestes,
    candidatures_en_attente: candidatures.rows[0].n,
    messages_non_lus: messages.rows[0].n,
    jours_avant_fin_bail: joursAvantFin,
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const estBailleur = req.user.role === "bailleur" || req.user.role === "intermediaire";
    const r = estBailleur ? await resumeBailleur(req.user) : await resumeLocataire(req.user);

    const notifs = await query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND lu = FALSE`, [req.user.id]);
    res.json({ ...r, notifications_non_lues: notifs.rows[0].n });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

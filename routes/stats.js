const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();

router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const n = async (sql, params = []) => Number((await query(sql, params)).rows[0].n);

    const comptes = await n(`SELECT COUNT(*)::int AS n FROM users WHERE role != 'admin'`);
    const comptes_bailleurs = await n(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'bailleur'`);
    const comptes_locataires = await n(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'locataire'`);
    const identites_verifiees = await n(`SELECT COUNT(*)::int AS n FROM users WHERE cni_statut = 'verifie' AND role != 'admin'`);
    const offres_publiees = await n(`SELECT COUNT(*)::int AS n FROM offres`);
    const candidatures = await n(`SELECT COUNT(*)::int AS n FROM demandes`);
    const contrats_en_cours = await n(`SELECT COUNT(*)::int AS n FROM contrats WHERE statut != 'signe' AND statut != 'annule'`);
    const contrats_signes = await n(`SELECT COUNT(*)::int AS n FROM contrats WHERE statut = 'signe'`);

    const bailleurs_qui_repostent = await n(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT bailleur_id FROM proprietes GROUP BY bailleur_id HAVING COUNT(*) >= 2
       ) t`
    );

    const candidatures_par_offre = offres_publiees > 0 ? Math.round((candidatures / offres_publiees) * 100) / 100 : 0;
    const taux_conversion_signature = comptes > 0 ? Math.round((contrats_signes / comptes) * 10000) / 100 : 0;
    const taux_retour_bailleurs = comptes_bailleurs > 0 ? Math.round((bailleurs_qui_repostent / comptes_bailleurs) * 10000) / 100 : 0;

    res.json({
      entonnoir: {
        comptes_crees: comptes,
        dont_bailleurs: comptes_bailleurs,
        dont_locataires: comptes_locataires,
        identites_verifiees,
        offres_publiees,
        candidatures,
        contrats_en_cours,
        contrats_signes,
      },
      indicateurs_v0: {
        candidatures_par_offre: { valeur: candidatures_par_offre, seuil_fort: 3, seuil_faible: 1 },
        contrats_signes: { valeur: contrats_signes, seuil_fort: "≥10 / 30j", seuil_faible: "<3 / 30j" },
        taux_conversion_compte_vers_signature_pct: taux_conversion_signature,
        taux_bailleurs_qui_repostent_pct: { valeur: taux_retour_bailleurs, seuil_fort: 30, seuil_faible: 10 },
      },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

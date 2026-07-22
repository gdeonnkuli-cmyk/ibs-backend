const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();

router.get("/", requireAuth, requireRole("admin"), (req, res) => {
  const comptes = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role != 'admin'`).get().n;
  const comptes_bailleurs = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'bailleur'`).get().n;
  const comptes_locataires = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'locataire'`).get().n;
  const identites_verifiees = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE cni_statut = 'verifie' AND role != 'admin'`).get().n;
  const offres_publiees = db.prepare(`SELECT COUNT(*) AS n FROM offres`).get().n;
  const candidatures = db.prepare(`SELECT COUNT(*) AS n FROM demandes`).get().n;
  const contrats_en_cours = db.prepare(`SELECT COUNT(*) AS n FROM contrats WHERE statut != 'signe' AND statut != 'annule'`).get().n;
  const contrats_signes = db.prepare(`SELECT COUNT(*) AS n FROM contrats WHERE statut = 'signe'`).get().n;

  const bailleurs_qui_repostent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT bailleur_id FROM proprietes GROUP BY bailleur_id HAVING COUNT(*) >= 2
       )`
    )
    .get().n;

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
});

module.exports = router;

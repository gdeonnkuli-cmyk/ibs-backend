// rappels.js — Rappels automatiques (fin de bail, loyers en retard).
//
// Jusqu'ici rien ne s'exécutait tout seul : le rappel de fin de bail ne partait
// que si quelqu'un ouvrait la liste de ses contrats, et les retards de loyer
// étaient calculés à l'écran sans jamais être signalés. Une plateforme dont les
// échéances ne se rappellent pas d'elles-mêmes est un carnet, pas un service.
//
// Deux garde-fous, parce qu'un rappel coûte un SMS et qu'un doublon se
// remarque :
//   · le throttle est posé par un UPDATE conditionnel qui ne touche la ligne
//     que si le délai est écoulé. Deux instances qui passent en même temps :
//     une seule voit la ligne changer, une seule notifie.
//   · RAPPELS_AUTO=false coupe le planificateur, et le mode test ne l'arme pas.
const { query } = require("./db");
const { notify } = require("./notify");

const JOURS_AVANT_FIN = 30;      // fenêtre d'alerte avant l'échéance du bail
const DELAI_RELANCE_JOURS = 7;   // au plus un rappel par semaine et par contrat
const INTERVALLE_MS = 12 * 60 * 60 * 1000;

/**
 * Pose le jalon de manière atomique. Rend true seulement si c'est cet appel qui
 * l'a posé — donc à lui d'envoyer.
 *
 * En simulation, la même condition est évaluée en lecture seule : le tour dit
 * ce qui partirait sans rien écrire, et le throttle reste intact pour le vrai
 * tour qui suivra.
 */
async function reserverRappel(contratId, colonne, simulation) {
  const condition = `(${colonne} IS NULL OR ${colonne} < NOW() - INTERVAL '${DELAI_RELANCE_JOURS} days')`;
  const r = simulation
    ? await query(`SELECT id FROM contrats WHERE id = $1 AND ${condition}`, [contratId])
    : await query(
        `UPDATE contrats SET ${colonne} = NOW() WHERE id = $1 AND ${condition} RETURNING id`,
        [contratId]
      );
  return r.rows.length > 0;
}

/**
 * N'envoie que hors simulation ; dans les deux cas, consigne le message.
 * Le journal porte le nom et le numéro : un aperçu qui n'affiche qu'un
 * identifiant de ligne ne permet pas de contrôler à qui le SMS partirait.
 */
async function envoyer(journal, destinataire, message, simulation) {
  journal.push({
    destinataire_id: destinataire.id,
    nom: destinataire.nom,
    telephone: destinataire.telephone,
    message,
  });
  if (!simulation) await notify(destinataire.id, message, "sms");
}

const bailleur = (c) => ({ id: c.bailleur_id, nom: c.bailleur_nom, telephone: c.bailleur_tel });
const locataire = (c) => ({ id: c.locataire_id, nom: c.locataire_nom, telephone: c.locataire_tel });

function dateFinDeBail(contrat) {
  const fin = new Date(contrat.signed_at);
  fin.setMonth(fin.getMonth() + contrat.duree_mois);
  return fin;
}

// ── Baux arrivant à échéance ──────────────────────────────────────────────
async function rappelsFinDeBail({ simulation = false, journal = [] } = {}) {
  const r = await query(
    `SELECT c.id, c.signed_at, c.duree_mois, p.titre,
            ub.id AS bailleur_id, ub.nom AS bailleur_nom, ub.telephone AS bailleur_tel,
            ul.id AS locataire_id, ul.nom AS locataire_nom, ul.telephone AS locataire_tel
     FROM contrats c
     JOIN offres o ON o.id = c.offre_id
     JOIN proprietes p ON p.id = o.propriete_id
     JOIN users ub ON ub.id = c.bailleur_id
     JOIN users ul ON ul.id = c.locataire_id
     WHERE c.statut = 'signe' AND c.signed_at IS NOT NULL`
  );

  let envoyes = 0;
  for (const c of r.rows) {
    const fin = dateFinDeBail(c);
    const joursRestants = Math.ceil((fin - new Date()) / (1000 * 60 * 60 * 24));
    if (joursRestants < 0 || joursRestants > JOURS_AVANT_FIN) continue;
    if (!(await reserverRappel(c.id, "dernier_rappel_echeance", simulation))) continue;

    const dateFin = fin.toISOString().slice(0, 10);
    await envoyer(journal, bailleur(c), `IBS : le bail "${c.titre}" se termine dans ${joursRestants} jour(s), le ${dateFin}. Pensez au renouvellement ou au préavis.`, simulation);
    await envoyer(journal, locataire(c), `IBS : votre bail "${c.titre}" se termine dans ${joursRestants} jour(s), le ${dateFin}. Rapprochez-vous de votre bailleur.`, simulation);
    envoyes += 1;
  }
  return envoyes;
}

// ── Loyers échus non déclarés payés ───────────────────────────────────────
// On ne relance que les mois échus sans aucune ligne dans paiements_loyer.
// Un mois en attente de confirmation ou contesté en a une : les parties s'en
// occupent déjà et ont été notifiées à ce titre — le relancer serait du bruit.
async function rappelsLoyerEnRetard({ simulation = false, journal = [] } = {}) {
  const r = await query(
    `SELECT c.id, c.signed_at, c.created_at, c.duree_mois, c.loyer_usd, p.titre,
            ub.id AS bailleur_id, ub.nom AS bailleur_nom, ub.telephone AS bailleur_tel,
            ul.id AS locataire_id, ul.nom AS locataire_nom, ul.telephone AS locataire_tel,
            (SELECT count(*) FROM paiements_loyer pl
             WHERE pl.contrat_id = c.id AND pl.mois < date_trunc('month', NOW())) AS nb_traites,
            (SELECT count(*) FROM paiements_loyer pl WHERE pl.contrat_id = c.id) AS nb_lignes
     FROM contrats c
     JOIN offres o ON o.id = c.offre_id
     JOIN proprietes p ON p.id = o.propriete_id
     JOIN users ub ON ub.id = c.bailleur_id
     JOIN users ul ON ul.id = c.locataire_id
     WHERE c.statut = 'signe'`
  );

  const debutDuMois = new Date();
  debutDuMois.setDate(1);
  debutDuMois.setHours(0, 0, 0, 0);

  let envoyes = 0;
  for (const c of r.rows) {
    // Mois du bail déjà échus, dans la limite de sa durée. Le mois en cours
    // n'est pas compté : il n'est pas encore en retard.
    const debut = new Date(c.signed_at || c.created_at);
    debut.setDate(1);
    const moisEcoules = Math.max(
      0,
      (debutDuMois.getFullYear() - debut.getFullYear()) * 12 + (debutDuMois.getMonth() - debut.getMonth())
    );
    const moisEchus = Math.min(moisEcoules, c.duree_mois);
    // Seules les lignes des mois ÉCHUS entrent dans le compte : sinon un mois
    // payé d'avance masquerait un mois antérieur resté impayé.
    const enRetard = moisEchus - Number(c.nb_traites);
    if (enRetard <= 0) continue;

    // Aucun paiement jamais déclaré sur ce bail : le carnet de loyer n'y est
    // pas tenu. L'absence de ligne ne prouve alors pas l'absence de paiement,
    // et relancer reviendrait à réclamer des mois déjà réglés hors plateforme
    // — le loyer se règle encore de la main à la main en V0. On ne relance
    // donc que les baux dont le carnet est effectivement utilisé.
    if (Number(c.nb_lignes) === 0) continue;
    if (!(await reserverRappel(c.id, "dernier_rappel_impaye", simulation))) continue;

    const somme = (enRetard * Number(c.loyer_usd)).toFixed(0);
    const pluriel = enRetard > 1 ? "s" : "";
    await envoyer(journal, locataire(c), `IBS : ${enRetard} mois de loyer non réglé${pluriel} pour "${c.titre}" (environ ${somme} USD). Régularisez auprès de votre bailleur.`, simulation);
    await envoyer(journal, bailleur(c), `IBS : ${enRetard} mois de loyer non réglé${pluriel} sur le bail "${c.titre}" (environ ${somme} USD).`, simulation);
    envoyes += 1;
  }
  return envoyes;
}

/**
 * @param {boolean} simulation — n'envoie rien, ne pose aucun jalon, et rend la
 *   liste exacte des messages qui partiraient. Sert à vérifier l'effet d'un
 *   premier tour en production avant de dépenser des SMS.
 */
async function passerUnTour({ simulation = false } = {}) {
  try {
    const journal = [];
    const fins = await rappelsFinDeBail({ simulation, journal });
    const retards = await rappelsLoyerEnRetard({ simulation, journal });
    if (fins || retards) {
      const prefixe = simulation ? "[RAPPELS·SIMULATION]" : "[RAPPELS]";
      console.log(`${prefixe} ${fins} fin(s) de bail, ${retards} retard(s) de loyer${simulation ? " (rien envoyé)" : " signalés"}.`);
    }
    return { fins, retards, messages: journal, simulation };
  } catch (e) {
    // Un échec ne doit jamais arrêter le planificateur : le tour suivant
    // réessaiera, et le throttle n'a pas été posé pour les envois manqués.
    console.error("[RAPPELS] Tour en échec :", e.message);
    return { fins: 0, retards: 0, messages: [], erreur: e.message };
  }
}

function demarrerPlanificateur() {
  if (process.env.RAPPELS_AUTO === "false") {
    console.log("⏸️  Rappels automatiques désactivés (RAPPELS_AUTO=false).");
    return null;
  }
  if (process.env.DEV_MODE === "true") {
    console.log("⏸️  Rappels automatiques désactivés en mode test.");
    return null;
  }

  // Décalé d'une minute : au redémarrage, la base vient d'être migrée et rien
  // ne presse. Puis deux tours par jour — le throttle hebdomadaire fait le
  // reste, un tour manqué est rattrapé au suivant.
  setTimeout(passerUnTour, 60 * 1000).unref();
  const minuterie = setInterval(passerUnTour, INTERVALLE_MS);
  minuterie.unref();
  console.log("⏰ Rappels automatiques armés (toutes les 12 h).");
  return minuterie;
}

module.exports = { demarrerPlanificateur, passerUnTour, rappelsFinDeBail, rappelsLoyerEnRetard };

// regles.js — Durées du bail.
//
// Ces deux valeurs sont liées : un rappel de fin de bail qui part après la date
// limite pour donner congé dit « pensez au préavis » à quelqu'un qui ne peut
// plus le donner. Les tenir dans deux fichiers séparés les laissait diverger
// silencieusement, ce qui était déjà le cas.

// Durée retenue faute d'autre indication. Elle est modifiable à chaque congé :
// la durée applicable dépend du bail et du droit congolais, que ce code ne
// prétend pas trancher.
const PREAVIS_JOURS_DEFAUT = 90;

// Le rappel doit arriver assez tôt pour que le congé soit encore possible,
// avec de la marge : le planificateur ne passe que deux fois par jour et ne
// relance qu'une fois par semaine.
const JOURS_ALERTE_FIN = 100;

// Une fenêtre plus courte que le préavis rendrait le rappel inutile : il
// arriverait après la date limite pour donner congé. Plutôt que de laisser
// passer une telle modification, on refuse de démarrer.
if (JOURS_ALERTE_FIN <= PREAVIS_JOURS_DEFAUT) {
  throw new Error(
    `regles.js : la fenêtre de rappel (${JOURS_ALERTE_FIN} j) doit dépasser le ` +
    `préavis par défaut (${PREAVIS_JOURS_DEFAUT} j), sinon le rappel de fin de ` +
    `bail part trop tard pour que le congé soit encore possible.`
  );
}

// ── Durée de vie d'une annonce ───────────────────────────────────────────
// Une offre publiée restait en ligne indéfiniment. Sur un marché où les biens
// partent en quelques semaines, un catalogue qui ne périme rien fait perdre
// leur temps aux locataires.
const VALIDITE_OFFRE_JOURS = 45;

// Le bailleur est prévenu avant, pas au moment où son annonce disparaît.
const PREAVIS_EXPIRATION_JOURS = 7;

if (PREAVIS_EXPIRATION_JOURS >= VALIDITE_OFFRE_JOURS) {
  throw new Error(
    `regles.js : le préavis d'expiration (${PREAVIS_EXPIRATION_JOURS} j) doit être `
    + `plus court que la validité d'une offre (${VALIDITE_OFFRE_JOURS} j), sinon `
    + `chaque annonce naîtrait déjà en préavis.`
  );
}

module.exports = {
  PREAVIS_JOURS_DEFAUT, JOURS_ALERTE_FIN,
  VALIDITE_OFFRE_JOURS, PREAVIS_EXPIRATION_JOURS,
};

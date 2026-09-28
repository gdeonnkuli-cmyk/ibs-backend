// Sélection de la passerelle de paiement. Voir passerelles/README.md.
const adaptateurs = {
  flutterwave: require("./flutterwave"),
  flexpay: require("./flexpay"),
  maxicash: require("./maxicash"),
};

// Chargée seulement si on la demande : son module refuse de s'initialiser hors
// mode test, et un require systématique ferait échouer le démarrage normal.
if ((process.env.PASSERELLE_PAIEMENT || "").toLowerCase() === "factice") {
  adaptateurs.factice = require("./factice");
}

const NOM = (process.env.PASSERELLE_PAIEMENT || "flutterwave").toLowerCase();
const adaptateur = adaptateurs[NOM];

if (!adaptateur) {
  // Démarrer avec une passerelle inconnue laisserait croire que l'encaissement
  // fonctionne, jusqu'au premier paiement.
  throw new Error(
    `PASSERELLE_PAIEMENT="${NOM}" inconnue. Disponibles : ${Object.keys(adaptateurs).join(", ")}.`
  );
}

module.exports = adaptateur;

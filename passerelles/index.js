// Sélection de la passerelle de paiement. Voir passerelles/README.md.
const adaptateurs = {
  flutterwave: require("./flutterwave"),
};

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

// Passerelle factice, pour les tests uniquement.
//
// Elle reproduit le comportement d'une passerelle congolaise : encaissement sur
// le compte du marchand, reversement par décaissement séparé. Sans elle, le
// mode transit — celui qu'imposent FlexPay et MaxiCash — ne serait jamais
// exécuté avant la production, et c'est le mode où la plateforme détient
// l'argent d'autrui : le moins bien placé pour être découvert en vrai.
//
// Elle refuse de se charger hors mode test : une passerelle qui dit « payé »
// sans encaisser n'a rien à faire en production.

if (process.env.DEV_MODE !== "true") {
  throw new Error(
    "La passerelle « factice » n'est utilisable qu'avec DEV_MODE=true. "
    + "Elle simule les paiements sans encaisser quoi que ce soit."
  );
}

const crypto = require("crypto");

// Pilotable depuis le test par un fichier d'état, relu à chaque appel : une
// variable d'environnement ne se change pas dans un serveur déjà démarré, et
// redémarrer entre deux cas ferait perdre ce qu'on cherche à observer.
const fs = require("fs");
const ETAT = process.env.FACTICE_ETAT || "";
function etat() {
  if (!ETAT) return {};
  try { return JSON.parse(fs.readFileSync(ETAT, "utf8")); } catch { return {}; }
}
const ECHOUER_REVERSEMENT = () => etat().reversementEchoue === true;
const transactions = new Map();

module.exports = {
  nom: "factice",
  supporteBeneficiaires: false,
  supporteReversement: true,

  indisponible() { return null; },

  async creerBeneficiaire({ numero }) { return { id: numero }; },

  async creerPaiement({ txRef, montant, devise, redirectUrl, libelle }) {
    const id = "FACT-" + txRef;
    transactions.set(txRef, { txRef, montant: Number(montant), devise, reussi: true });
    return { lien: `${redirectUrl}?status=successful&tx_ref=${encodeURIComponent(txRef)}&transaction_id=${encodeURIComponent(id)}`, reference: id };
  },

  async verifierTransaction(transactionId) {
    const ref = String(transactionId).replace(/^FACT-/, "");
    return transactions.get(ref) || null;
  },

  async reverser({ montant, devise, destinataire, reference }) {
    if (ECHOUER_REVERSEMENT()) throw new Error("Solde marchand insuffisant (simulation).");
    return { reference: "REV-" + reference };
  },

  signatureValide(headers, secret) {
    const recu = Buffer.from(String(headers["x-factice-signature"] || ""));
    const attendu = Buffer.from(secret);
    return recu.length === attendu.length && crypto.timingSafeEqual(recu, attendu);
  },

  lireWebhook(corps) {
    if (!corps?.reference) return null;
    return {
      txRef: corps.reference,
      transactionId: "FACT-" + corps.reference,
      montant: Number(corps.montant),
      devise: corps.devise,
      reussi: corps.reussi !== false,
    };
  },
};

// Adaptateur MaxiCash (RDC).
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ CES CORRESPONDANCES DE CHAMPS N'ONT PAS ÉTÉ VÉRIFIÉES CONTRE L'API     │
// │ RÉELLE. Elles sont écrites d'après la forme habituelle de MaxiCash et  │
// │ doivent être confrontées à la documentation remise par le prestataire  │
// │ avant toute mise en production.                                        │
// └───────────────────────────────────────────────────────────────────────┘
//
// Deux pièges connus de MaxiCash, qui coûtent cher si on les découvre en
// production :
//   · les montants sont exprimés en centimes, pas en unités ;
//   · l'authentification se fait par identifiant et mot de passe marchand dans
//     le corps de la requête, pas par en-tête.
//
// MaxiCash encaisse sur le compte du marchand : pas de sous-compte par
// bailleur. Le reversement passe par l'API de décaissement.

const crypto = require("crypto");

const ID = process.env.MAXICASH_MERCHANT_ID || "";
const MDP = process.env.MAXICASH_MERCHANT_PASSWORD || "";
const API = process.env.MAXICASH_API_URL || "https://api.maxicashapp.com";
const ENTETE_SIGNATURE = process.env.MAXICASH_SIGNATURE_HEADER || "x-maxicash-signature";

// Les centimes sont la source d'erreur la plus banale de cette intégration :
// un facteur cent sur un loyer, c'est un locataire qui paie trois dollars ou
// trente mille.
const enCentimes = (montant) => String(Math.round(Number(montant) * 100));
const depuisCentimes = (valeur) => Number(valeur) / 100;

const appeler = async (chemin, corps) => {
  const r = await fetch(API + chemin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ MerchantID: ID, MerchantPassword: MDP, ...corps }),
  });
  return r.json();
};

const succes = (data) => String(data?.ResponseStatus || "").toLowerCase() === "success";

module.exports = {
  nom: "maxicash",

  supporteBeneficiaires: false,
  supporteReversement: true,

  indisponible() {
    if (!ID) return "MaxiCash non configuré (MAXICASH_MERCHANT_ID manquant).";
    if (!MDP) return "MaxiCash non configuré (MAXICASH_MERCHANT_PASSWORD manquant).";
    return null;
  },

  async creerBeneficiaire({ numero }) {
    return { id: numero };
  },

  async creerPaiement({ txRef, montant, devise, redirectUrl, client, libelle }) {
    const data = await appeler("/PayEntryPost", {
      Amount: enCentimes(montant),
      Currency: devise,
      Telephone: String(client.telephone || "").replace(/\D/g, ""),
      Email: `${String(client.telephone || "").replace(/\D/g, "")}@ibs-users.cd`,
      Reference: txRef,
      Description: libelle,
      SuccessURL: redirectUrl,
      FailureURL: redirectUrl,
      CancelURL: redirectUrl,
      NotifyURL: process.env.MAXICASH_NOTIFY_URL || "",
    });
    if (!succes(data) || !data.PaymentURL) {
      console.error("MaxiCash paiement :", data);
      throw new Error(data?.ResponseError || "Impossible de démarrer le paiement pour le moment.");
    }
    return { lien: data.PaymentURL, reference: data.Reference || txRef };
  },

  async verifierTransaction(transactionId) {
    const data = await appeler("/PayEntryQuery", { Reference: String(transactionId) });
    if (!succes(data) || !data.Transaction) return null;
    const tx = data.Transaction;
    return {
      txRef: tx.Reference,
      montant: depuisCentimes(tx.Amount),
      devise: tx.Currency,
      reussi: String(tx.Status).toLowerCase() === "success",
      statutBrut: String(tx.Status),
    };
  },

  async reverser({ montant, devise, destinataire, reference }) {
    const data = await appeler("/PayOutPost", {
      Amount: enCentimes(montant),
      Currency: devise,
      Telephone: String(destinataire).replace(/\D/g, ""),
      Reference: reference,
    });
    if (!succes(data)) {
      console.error("MaxiCash reversement :", data);
      throw new Error(data?.ResponseError || "Reversement refusé par MaxiCash.");
    }
    return { reference: data.Reference || reference };
  },

  signatureValide(headers, secret) {
    const recu = Buffer.from(String(headers[ENTETE_SIGNATURE] || ""));
    const attendu = Buffer.from(secret);
    return recu.length === attendu.length && crypto.timingSafeEqual(recu, attendu);
  },

  lireWebhook(corps) {
    if (!corps?.Reference) return null;
    return {
      txRef: corps.Reference,
      transactionId: corps.Reference,
      montant: depuisCentimes(corps.Amount),
      devise: corps.Currency,
      reussi: String(corps.Status || "").toLowerCase() === "success",
    };
  },
};

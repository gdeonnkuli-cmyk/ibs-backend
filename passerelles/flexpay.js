// Adaptateur FlexPay (RDC).
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ CES CORRESPONDANCES DE CHAMPS N'ONT PAS ÉTÉ VÉRIFIÉES CONTRE L'API     │
// │ RÉELLE. Elles sont écrites d'après la forme habituelle de FlexPay et   │
// │ doivent être confrontées à la documentation remise par le prestataire  │
// │ avant toute mise en production. Tout est regroupé ici pour que cette   │
// │ confrontation ne demande de toucher qu'un fichier.                     │
// └───────────────────────────────────────────────────────────────────────┘
//
// FlexPay encaisse sur le compte du marchand : il n'existe pas de sous-compte
// par bailleur. Le reversement passe donc par un décaissement séparé, et
// supporteBeneficiaires est à false. Voir passerelles/README.md.

const crypto = require("crypto");

const TOKEN = process.env.FLEXPAY_TOKEN || "";
const MARCHAND = process.env.FLEXPAY_MERCHANT || "";
const API = process.env.FLEXPAY_API_URL || "https://backend.flexpay.cd/api/rest/v1";
// FlexPay signe ses rappels avec un secret partagé, sous un en-tête dont le nom
// dépend du contrat marchand. À confirmer.
const ENTETE_SIGNATURE = process.env.FLEXPAY_SIGNATURE_HEADER || "x-flexpay-signature";

const appeler = async (chemin, options = {}) => {
  const r = await fetch(API + chemin, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return r.json();
};

// FlexPay rend "0" en cas de succès, dans un champ `code` qui remonte parfois
// en chaîne, parfois en nombre.
const succes = (data) => String(data?.code) === "0";

module.exports = {
  nom: "flexpay",

  // Encaissement marchand : les fonds arrivent chez IBS avant d'être reversés.
  supporteBeneficiaires: false,
  supporteReversement: true,

  indisponible() {
    if (!TOKEN) return "FlexPay non configuré (FLEXPAY_TOKEN manquant).";
    if (!MARCHAND) return "FlexPay non configuré (FLEXPAY_MERCHANT manquant).";
    return null;
  },

  // Aucun compte n'est à ouvrir chez FlexPay : le numéro du bailleur sert
  // directement de destinataire au décaissement. On le rend tel quel pour que
  // le module le conserve.
  async creerBeneficiaire({ numero }) {
    return { id: numero };
  },

  async creerPaiement({ txRef, montant, devise, redirectUrl, client, libelle }) {
    const data = await appeler("/paymentService", {
      method: "POST",
      body: JSON.stringify({
        merchant: MARCHAND,
        type: "1", // 1 = mobile money
        reference: txRef,
        amount: String(montant),
        currency: devise,
        phone: String(client.telephone || "").replace(/\D/g, ""),
        callbackUrl: redirectUrl,
        description: libelle,
      }),
    });
    if (!succes(data) || !(data.url || data.orderNumber)) {
      console.error("FlexPay paiement :", data);
      throw new Error(data?.message || "Impossible de démarrer le paiement pour le moment.");
    }
    // Le paiement mobile money de FlexPay pousse une demande sur le téléphone du
    // client : il n'y a pas toujours de page à ouvrir. Quand il n'y en a pas,
    // on renvoie le numéro d'ordre, que l'appelant utilisera pour suivre.
    return { lien: data.url || null, reference: data.orderNumber || txRef };
  },

  async verifierTransaction(transactionId) {
    const data = await appeler(`/check/${encodeURIComponent(transactionId)}`);
    const tx = data?.transaction;
    if (!tx) return null;
    return {
      txRef: tx.reference,
      montant: Number(tx.amount),
      devise: tx.currency,
      reussi: String(tx.status) === "0",
      statutBrut: String(tx.status),
    };
  },

  async reverser({ montant, devise, destinataire, reference }) {
    const data = await appeler("/merchantPayOutService", {
      method: "POST",
      body: JSON.stringify({
        merchant: MARCHAND,
        type: "1",
        reference,
        amount: String(montant),
        currency: devise,
        phone: String(destinataire).replace(/\D/g, ""),
      }),
    });
    if (!succes(data)) {
      console.error("FlexPay reversement :", data);
      throw new Error(data?.message || "Reversement refusé par FlexPay.");
    }
    return { reference: data.orderNumber || reference };
  },

  signatureValide(headers, secret) {
    const recu = Buffer.from(String(headers[ENTETE_SIGNATURE] || ""));
    const attendu = Buffer.from(secret);
    return recu.length === attendu.length && crypto.timingSafeEqual(recu, attendu);
  },

  lireWebhook(corps) {
    if (!corps?.reference) return null;
    return {
      txRef: corps.reference,
      transactionId: corps.orderNumber || corps.reference,
      montant: Number(corps.amount),
      devise: corps.currency,
      reussi: String(corps.code) === "0",
    };
  },
};

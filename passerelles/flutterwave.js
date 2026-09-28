// Adaptateur Flutterwave (API v3).
//
// Attention à la couverture : Flutterwave ne dessert pas la RDC. Cet adaptateur
// est conservé parce qu'il sert déjà aux abonnements Premium et qu'il vaut
// modèle pour en écrire d'autres, mais il ne convient pas à l'encaissement du
// loyer à Kinshasa. Voir passerelles/README.md.
const crypto = require("crypto");

const SECRET = process.env.FLUTTERWAVE_SECRET_KEY || "";
const API = process.env.FLUTTERWAVE_API_URL || "https://api.flutterwave.com/v3";

const appeler = (chemin, options = {}) =>
  fetch(API + chemin, {
    ...options,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

module.exports = {
  nom: "flutterwave",
  supporteBeneficiaires: true,

  indisponible() {
    if (!SECRET) return "Passerelle non configurée (clé secrète manquante côté serveur).";
    return null;
  },

  async creerBeneficiaire({ type, operateur, numero, titulaire, commissionPct, bailleur }) {
    const r = await appeler("/subaccounts", {
      method: "POST",
      body: JSON.stringify({
        account_bank: type === "mobile_money" ? String(operateur).toUpperCase() : String(operateur || ""),
        account_number: numero,
        business_name: titulaire,
        business_email: `${String(bailleur.telephone || "").replace(/\D/g, "")}@ibs-users.cd`,
        business_mobile: bailleur.telephone,
        country: "CD",
        split_type: "percentage",
        split_value: commissionPct / 100,
      }),
    });
    const data = await r.json();
    if (data.status !== "success" || !data.data?.subaccount_id) {
      console.error("Flutterwave subaccount:", data);
      throw new Error("La passerelle a refusé ce compte. Vérifiez le numéro et le nom du titulaire.");
    }
    return { id: data.data.subaccount_id };
  },

  async creerPaiement({ txRef, montant, devise, redirectUrl, client, beneficiaireId, libelle }) {
    const r = await appeler("/payments", {
      method: "POST",
      body: JSON.stringify({
        tx_ref: txRef,
        amount: montant,
        currency: devise,
        redirect_url: redirectUrl,
        payment_options: "mobilemoneyfranco,card",
        customer: {
          email: `${String(client.telephone || "").replace(/\D/g, "")}@ibs-users.cd`,
          phonenumber: client.telephone,
          name: client.nom,
        },
        subaccounts: [{ id: beneficiaireId }],
        customizations: { title: "IBS — Loyer", description: libelle },
      }),
    });
    const data = await r.json();
    if (data.status !== "success" || !data.data?.link) {
      console.error("Flutterwave payment:", data);
      throw new Error("Impossible de démarrer le paiement pour le moment.");
    }
    return { lien: data.data.link };
  },

  async verifierTransaction(transactionId) {
    const r = await appeler(`/transactions/${transactionId}/verify`);
    const data = await r.json();
    if (data.status !== "success" || !data.data) return null;
    const tx = data.data;
    return {
      txRef: tx.tx_ref,
      montant: Number(tx.amount),
      devise: tx.currency,
      reussi: tx.status === "successful",
      statutBrut: tx.status,
    };
  },

  signatureValide(headers, secret) {
    const recu = Buffer.from(String(headers["verif-hash"] || ""));
    const attendu = Buffer.from(secret);
    return recu.length === attendu.length && crypto.timingSafeEqual(recu, attendu);
  },

  lireWebhook(corps) {
    const tx = corps?.data;
    if (!tx?.tx_ref) return null;
    return {
      txRef: tx.tx_ref,
      transactionId: tx.id,
      montant: Number(tx.amount),
      devise: tx.currency,
      reussi: tx.status === "successful",
    };
  },
};

# Passerelles de paiement

Le module d'encaissement ne connaît aucune passerelle. Il appelle l'adaptateur
choisi par la variable `PASSERELLE_PAIEMENT`, et c'est tout.

Cette indirection n'est pas de la précaution d'usage : Flutterwave, sur lequel
la première version était bâtie, ne couvre pas la RDC. Changer de prestataire
ne doit plus demander de retoucher les routes, les contrôles de montant, ni
l'idempotence du crédit.

## Ce qu'un adaptateur doit fournir

```js
module.exports = {
  nom: "exemple",

  // Reverse-t-elle directement au bailleur ? Voir plus bas.
  supporteBeneficiaires: true,

  // Message expliquant pourquoi elle est inutilisable, ou null si tout est là.
  indisponible() {},

  // Enregistre le compte du bailleur chez le prestataire.
  // Rend { id } ; lève une Error dont le message est montrable à l'utilisateur.
  async creerBeneficiaire({ type, operateur, numero, titulaire, commissionPct, bailleur }) {},

  // Rend { lien } : l'URL où envoyer le locataire pour qu'il paie.
  async creerPaiement({ txRef, montant, devise, redirectUrl, client, beneficiaireId, libelle }) {},

  // Rend { txRef, montant, devise, reussi } ou null si la transaction est inconnue.
  async verifierTransaction(transactionId) {},

  // La signature du webhook est-elle celle du prestataire ?
  signatureValide(headers, secret) {},

  // Extrait du corps du webhook : { txRef, transactionId, montant, devise, reussi }.
  lireWebhook(corps) {},
};
```

Le montant rendu par `verifierTransaction` et `lireWebhook` est comparé au loyer
attendu par l'appelant. Un adaptateur qui rendrait un montant faux ferait solder
des mois impayés : c'est la valeur la plus sensible de l'interface.

## supporteBeneficiaires

`true` : le prestataire sait reverser directement sur le compte du bailleur
(sous-comptes, split de paiement). IBS n'est jamais détentrice des fonds, ce qui
est le modèle retenu et ce que le reçu de loyer affirme.

`false` : le prestataire encaisse sur le compte du marchand — donc d'IBS — et
reverser demanderait un virement séparé. Le module refuse alors d'ouvrir le
paiement en ligne, parce que détenir l'argent d'autrui relève en RDC du statut
d'établissement de paiement, et que le reçu affirmerait une chose fausse.
Lever cette limite est une décision juridique, pas technique.

## Ajouter une passerelle

1. Écrire `passerelles/<nom>.js` selon l'interface ci-dessus.
2. L'inscrire dans `passerelles/index.js`.
3. Poser `PASSERELLE_PAIEMENT=<nom>`.

Aucun autre fichier n'a à changer.

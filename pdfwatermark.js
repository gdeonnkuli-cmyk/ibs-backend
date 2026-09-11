// pdfWatermark.js — Filigrane traçable pour les documents PDF sensibles.
// N'empêche pas la capture ou le partage (impossible à garantir pour un PDF téléchargé),
// mais identifie clairement qui a généré le document et quand — utile en cas de fuite.
function appliquerFiligrane(doc, { nom, telephone }) {
  const { width, height } = doc.page;
  const identite = `${nom || "Utilisateur IBS"}${telephone ? " · " + telephone : ""}`;
  const horodatage = new Date().toLocaleString("fr-FR");

  // Filigrane diagonal, discret, au centre de la page
  doc.save();
  doc.fillColor("#0D1B3E").opacity(0.055).fontSize(26).font("Helvetica-Bold");
  doc.rotate(-38, { origin: [width / 2, height / 2] });
  doc.text(identite, -120, height / 2 - 18, { width: width + 240, align: "center" });
  doc.restore();
  doc.opacity(1);

  // Pied de page, toujours lisible : trace précise de qui a téléchargé le document
  doc.fillColor("#8891B5").fontSize(7).font("Helvetica")
    .text(`Document généré pour ${identite} — ${horodatage} — Usage personnel, ne pas diffuser.`, 40, height - 32, { width: width - 80, align: "center" });
}

module.exports = { appliquerFiligrane };

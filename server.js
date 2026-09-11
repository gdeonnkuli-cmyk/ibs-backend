require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { migrate } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    app: "IBS — Immo-Bail Solution API",
    version: "V0",
    statut: "beta",
    note: "Le paiement du loyer n'est pas encore intégré à la plateforme (transition manuelle en V0).",
  });
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/offres", require("./routes/offres"));
app.use("/api/demandes", require("./routes/demandes"));
app.use("/api/contrats", require("./routes/contrats"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/admin/stats", require("./routes/stats"));
app.use("/api/abonnements", require("./routes/abonnements"));
app.use("/api/paiements", require("./routes/paiements"));
app.use("/api/avis", require("./routes/avis"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/alertes", require("./routes/alertes"));
app.use("/api/favoris", require("./routes/favoris"));
app.use("/api/signalements", require("./routes/signalements"));
app.use("/api/quartiers", require("./routes/quartiers"));
app.use("/api/revenus", require("./routes/revenus"));
app.use("/api/agents", require("./routes/agents"));
app.use("/api/mandants", require("./routes/mandants"));
app.use("/api/premium", require("./routes/premium"));
app.use("/api/visites", require("./routes/visites"));
app.use("/api/comptes", require("./routes/comptes"));
app.use("/api/audit", require("./routes/audit"));
app.use("/api/resume", require("./routes/resume"));

app.use((req, res) => res.status(404).json({ error: "Route introuvable." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await migrate();
  app.listen(PORT, () => console.log(`IBS API en écoute sur http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch((e) => {
    console.error("Échec du démarrage :", e);
    process.exit(1);
  });
}

module.exports = app;

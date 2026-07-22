require("dotenv").config();
const express = require("express");
const cors = require("cors");

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
app.use("/api/admin/stats", require("./routes/stats"));

app.use((req, res) => res.status(404).json({ error: "Route introuvable." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`IBS API en écoute sur http://localhost:${PORT}`));
}

module.exports = app;

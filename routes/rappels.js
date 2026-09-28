const express = require("express");
const { requireAuth, requireRole } = require("../auth");
const { passerUnTour, reglesRappels } = require("../rappels");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Règles en vigueur (admin) ──
// L'écran les affichait de mémoire, et annonçait encore une fenêtre de 30 jours
// quand elle en faisait cent. Une description qui ment sur ce que fait le
// système est pire que pas de description.
router.get("/regles", requireAuth, requireRole("admin"), (req, res) => {
  res.json(reglesRappels());
});

// ── Déclencher un tour de rappels immédiatement (admin) ──
// Le planificateur passe toutes les 12 h : sans cette route, vérifier qu'il
// fonctionne en production demanderait d'attendre. Le throttle s'applique de la
// même façon ici, un appel répété n'envoie donc rien de plus.
router.post("/executer", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    // ?simulation=true : rend la liste exacte des SMS qui partiraient, sans en
    // envoyer un seul et sans consommer le throttle. À passer avant le premier
    // vrai tour, pour voir ce que recevraient les utilisateurs.
    const simulation = req.query.simulation === "true";
    const { fins, retards, messages } = await passerUnTour({ simulation });
    await auditLog(req.user.id, simulation ? "rappels_simules" : "rappels_executes", { fins, retards });
    res.json({
      message: simulation
        ? "Simulation terminée — aucun SMS envoyé, aucun compteur consommé."
        : "Tour de rappels terminé.",
      simulation,
      fins_de_bail_signalees: fins,
      retards_de_loyer_signales: retards,
      sms: messages.length,
      ...(simulation ? { apercu: messages } : {}),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

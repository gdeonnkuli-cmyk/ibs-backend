const express = require("express");
const { requireAuth, requireRole } = require("../auth");
const { passerUnTour } = require("../rappels");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Déclencher un tour de rappels immédiatement (admin) ──
// Le planificateur passe toutes les 12 h : sans cette route, vérifier qu'il
// fonctionne en production demanderait d'attendre. Le throttle hebdomadaire
// s'applique de la même façon ici, un appel répété n'envoie donc rien de plus.
router.post("/executer", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { fins, retards } = await passerUnTour();
    await auditLog(req.user.id, "rappels_executes", { fins, retards });
    res.json({
      message: "Tour de rappels terminé.",
      fins_de_bail_signalees: fins,
      retards_de_loyer_signales: retards,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

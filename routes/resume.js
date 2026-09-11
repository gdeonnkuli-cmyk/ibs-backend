const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole, agenceIdDe } = require("../auth");

const router = express.Router();

// ── Résumé du jour : candidatures en attente, messages non lus, visites du jour ──
router.get("/", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    const agenceId = agenceIdDe(req.user);

    const candidatures = await query(
      `SELECT COUNT(*) FROM demandes d JOIN offres o ON o.id = d.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = $1 AND d.statut = 'en_attente'`,
      [agenceId]
    );

    const messages = await query(
      `SELECT COUNT(*) FROM messages m JOIN offres o ON o.id = m.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = $1 AND m.expediteur_id != $2 AND m.lu = FALSE`,
      [agenceId, req.user.id]
    );

    const visites = await query(
      `SELECT COUNT(*) FROM visites WHERE bailleur_id = $1 AND statut IN ('en_attente','acceptee') AND date_proposee::date = CURRENT_DATE`,
      [agenceId]
    );

    res.json({
      candidatures_en_attente: Number(candidatures.rows[0].count),
      messages_non_lus: Number(messages.rows[0].count),
      visites_aujourdhui: Number(visites.rows[0].count),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

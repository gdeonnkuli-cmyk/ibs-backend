const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole, agenceIdDe } = require("../auth");
const { notify } = require("../notify");

const router = express.Router();

// ── Locataire : demander une visite ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { offre_id, date_proposee, message } = req.body;
    if (!offre_id || !date_proposee) return res.status(400).json({ error: "offre_id et date_proposee sont requis." });

    const o = await query(
      `SELECT p.bailleur_id, p.titre FROM offres of JOIN proprietes p ON p.id = of.propriete_id WHERE of.id = $1`,
      [offre_id]
    );
    if (!o.rows.length) return res.status(404).json({ error: "Offre introuvable." });

    const r = await query(
      `INSERT INTO visites (offre_id, locataire_id, bailleur_id, date_proposee, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [offre_id, req.user.id, o.rows[0].bailleur_id, date_proposee, message || null]
    );
    await notify(o.rows[0].bailleur_id, `${req.user.nom} propose une visite pour "${o.rows[0].titre}" le ${new Date(date_proposee).toLocaleString("fr-FR")}.`, "in_app");
    res.status(201).json({ message: "Demande de visite envoyée.", visite_id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Locataire : mes visites ──
router.get("/mine", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT v.id, v.date_proposee, v.statut, v.dernier_proposant, v.message, v.created_at,
              p.titre, p.commune, u.nom AS bailleur_nom
       FROM visites v
       JOIN offres o ON o.id = v.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = v.bailleur_id
       WHERE v.locataire_id = $1 ORDER BY v.date_proposee ASC`,
      [req.user.id]
    );
    res.json({ visites: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Bailleur/agence : visites demandées sur mes biens ──
router.get("/recues", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT v.id, v.date_proposee, v.statut, v.dernier_proposant, v.message, v.created_at,
              p.titre, p.commune, u.nom AS locataire_nom, u.telephone AS locataire_telephone
       FROM visites v
       JOIN offres o ON o.id = v.offre_id
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = v.locataire_id
       WHERE v.bailleur_id = $1 ORDER BY v.date_proposee ASC`,
      [agenceIdDe(req.user)]
    );
    res.json({ visites: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Accepter / refuser / proposer un autre créneau ──
router.post("/:id/action", requireAuth, async (req, res) => {
  try {
    const { action, date_proposee } = req.body;
    if (!["accepter", "refuser", "proposer_autre"].includes(action)) return res.status(400).json({ error: "Action invalide." });

    const v = await query(`SELECT * FROM visites WHERE id = $1`, [req.params.id]);
    if (!v.rows.length) return res.status(404).json({ error: "Visite introuvable." });
    const visite = v.rows[0];

    const estLocataire = visite.locataire_id === req.user.id;
    const estBailleur = agenceIdDe(req.user) === visite.bailleur_id;
    if (!estLocataire && !estBailleur) return res.status(403).json({ error: "Cette visite ne vous concerne pas." });

    const autrePartieId = estLocataire ? visite.bailleur_id : visite.locataire_id;
    const o = await query(
      `SELECT p.titre FROM offres of JOIN proprietes p ON p.id = of.propriete_id WHERE of.id = $1`,
      [visite.offre_id]
    );
    const titre = o.rows[0]?.titre || "l'offre";

    if (action === "accepter") {
      await query(`UPDATE visites SET statut = 'acceptee' WHERE id = $1`, [req.params.id]);
      await notify(autrePartieId, `Visite acceptée pour "${titre}" le ${new Date(visite.date_proposee).toLocaleString("fr-FR")}.`, "in_app");
    } else if (action === "refuser") {
      await query(`UPDATE visites SET statut = 'refusee' WHERE id = $1`, [req.params.id]);
      await notify(autrePartieId, `Visite refusée pour "${titre}".`, "in_app");
    } else {
      if (!date_proposee) return res.status(400).json({ error: "date_proposee requise pour proposer un autre créneau." });
      await query(
        `UPDATE visites SET date_proposee = $1, dernier_proposant = $2, statut = 'en_attente' WHERE id = $3`,
        [date_proposee, estLocataire ? "locataire" : "bailleur", req.params.id]
      );
      await notify(autrePartieId, `Nouveau créneau proposé pour "${titre}" : ${new Date(date_proposee).toLocaleString("fr-FR")}.`, "in_app");
    }
    res.json({ message: "Mis à jour." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

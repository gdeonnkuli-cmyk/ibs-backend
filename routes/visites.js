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

    // Une visite se fixe dans l'avenir. Rien ne l'empêchait, et un créneau passé
    // se serait affiché dans l'agenda des deux parties sans qu'aucune ne puisse
    // s'y rendre.
    const quand = new Date(date_proposee);
    if (isNaN(quand)) return res.status(400).json({ error: "Date de visite invalide." });
    if (quand.getTime() < Date.now()) {
      return res.status(400).json({ error: "La date de visite doit être à venir." });
    }

    const o = await query(
      `SELECT p.bailleur_id, p.titre, of.statut FROM offres of JOIN proprietes p ON p.id = of.propriete_id WHERE of.id = $1`,
      [offre_id]
    );
    if (!o.rows.length) return res.status(404).json({ error: "Offre introuvable." });
    if (o.rows[0].statut !== "active") {
      return res.status(409).json({ error: "Ce bien n'est plus disponible à la visite." });
    }

    // Une seule négociation ouverte par bien : sans cela, un locataire pressé
    // empilait les demandes et le bailleur devait répondre à chacune.
    const enCours = await query(
      `SELECT id FROM visites WHERE offre_id = $1 AND locataire_id = $2 AND statut = 'en_attente'`,
      [offre_id, req.user.id]
    );
    if (enCours.rows.length) {
      return res.status(409).json({ error: "Vous avez déjà une demande de visite en attente pour ce bien." });
    }

    const r = await query(
      `INSERT INTO visites (offre_id, locataire_id, bailleur_id, date_proposee, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [offre_id, req.user.id, o.rows[0].bailleur_id, date_proposee, message || null]
    );
    // Par SMS et non en notification interne : une demande de visite que le
    // bailleur découvre trois jours plus tard est une visite perdue. C'est le
    // seul message de ce module qui parte en SMS — les réponses suivantes
    // arrivent alors que la conversation est déjà engagée.
    await notify(o.rows[0].bailleur_id,
      `IBS : ${req.user.nom} demande à visiter "${o.rows[0].titre}" le ${quand.toLocaleString("fr-FR")}. Répondez dans l'application.`, "sms");
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

    // Une visite tranchée ne se rouvre pas : sans ce garde-fou, un refus
    // pouvait être retourné en acceptation des semaines plus tard.
    if (visite.statut !== "en_attente") {
      return res.status(409).json({
        error: visite.statut === "acceptee"
          ? "Cette visite est déjà confirmée."
          : "Cette visite est close. Faites une nouvelle demande si besoin.",
      });
    }

    // dernier_proposant était enregistré mais n'entrait dans aucune décision :
    // celui qui venait de proposer un créneau pouvait l'accepter lui-même, et
    // l'autre partie recevait « Visite acceptée » pour un rendez-vous qu'elle
    // n'avait jamais validé. On accepte la proposition de l'autre, pas la sienne.
    const jeSuisLeProposant = visite.dernier_proposant === (estLocataire ? "locataire" : "bailleur");
    if (action === "accepter" && jeSuisLeProposant) {
      return res.status(409).json({
        error: "Vous avez proposé ce créneau : il revient à l'autre partie de l'accepter.",
      });
    }

    const autrePartieId = estLocataire ? visite.bailleur_id : visite.locataire_id;
    const o = await query(
      `SELECT p.titre FROM offres of JOIN proprietes p ON p.id = of.propriete_id WHERE of.id = $1`,
      [visite.offre_id]
    );
    const titre = o.rows[0]?.titre || "l'offre";

    if (action === "accepter") {
      await query(`UPDATE visites SET statut = 'acceptee' WHERE id = $1`, [req.params.id]);
      // Un rendez-vous confirmé se retient : il part par SMS, comme la demande.
      await notify(autrePartieId,
        `IBS : visite confirmée pour "${titre}" le ${new Date(visite.date_proposee).toLocaleString("fr-FR")}.`, "sms");
    } else if (action === "refuser") {
      await query(`UPDATE visites SET statut = 'refusee' WHERE id = $1`, [req.params.id]);
      await notify(autrePartieId, `Visite refusée pour "${titre}".`, "in_app");
    } else {
      if (!date_proposee) return res.status(400).json({ error: "date_proposee requise pour proposer un autre créneau." });
      const quand = new Date(date_proposee);
      if (isNaN(quand) || quand.getTime() < Date.now()) {
        return res.status(400).json({ error: "Le créneau proposé doit être à venir." });
      }
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

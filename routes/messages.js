const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../auth");
const { notify } = require("../notify");

const router = express.Router();

async function getBailleurOffre(offreId) {
  const r = await query(
    `SELECT p.bailleur_id, p.titre FROM offres o JOIN proprietes p ON p.id = o.propriete_id WHERE o.id = $1`,
    [offreId]
  );
  return r.rows[0] || null;
}

// ── Envoyer un message (locataire initie ; bailleur ne peut que répondre) ──
router.post("/", requireAuth, async (req, res) => {
  try {
    const { offre_id, contenu } = req.body;
    let { locataire_id } = req.body;
    if (!offre_id || !contenu || !contenu.trim()) return res.status(400).json({ error: "offre_id et contenu sont requis." });

    const offre = await getBailleurOffre(offre_id);
    if (!offre) return res.status(404).json({ error: "Offre introuvable." });

    let destinataireId;
    if (req.user.role === "locataire") {
      locataire_id = req.user.id;
      destinataireId = offre.bailleur_id;
    } else {
      if (req.user.id !== offre.bailleur_id) return res.status(403).json({ error: "Cette offre ne vous appartient pas." });
      if (!locataire_id) return res.status(400).json({ error: "locataire_id requis pour répondre." });
      const existe = await query(`SELECT 1 FROM messages WHERE offre_id = $1 AND locataire_id = $2 LIMIT 1`, [offre_id, locataire_id]);
      if (!existe.rows.length) return res.status(403).json({ error: "Ce locataire ne vous a pas encore contacté sur cette offre." });
      destinataireId = locataire_id;
    }

    await query(
      `INSERT INTO messages (offre_id, locataire_id, expediteur_id, contenu) VALUES ($1,$2,$3,$4)`,
      [offre_id, locataire_id, req.user.id, contenu.trim()]
    );
    await notify(destinataireId, `Nouveau message de ${req.user.nom} au sujet de "${offre.titre}".`, "in_app");
    res.status(201).json({ message: "Message envoyé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Fil de discussion pour une offre + un locataire donnés ──
router.get("/:offre_id/:locataire_id", requireAuth, async (req, res) => {
  try {
    const { offre_id, locataire_id } = req.params;
    const offre = await getBailleurOffre(offre_id);
    if (!offre) return res.status(404).json({ error: "Offre introuvable." });
    if (req.user.id !== Number(locataire_id) && req.user.id !== offre.bailleur_id) {
      return res.status(403).json({ error: "Vous n'êtes pas partie à cette conversation." });
    }

    const r = await query(
      `SELECT m.id, m.contenu, m.expediteur_id, m.created_at, u.nom AS expediteur_nom
       FROM messages m JOIN users u ON u.id = m.expediteur_id
       WHERE m.offre_id = $1 AND m.locataire_id = $2 ORDER BY m.created_at ASC`,
      [offre_id, locataire_id]
    );
    await query(
      `UPDATE messages SET lu = TRUE WHERE offre_id = $1 AND locataire_id = $2 AND expediteur_id != $3`,
      [offre_id, locataire_id, req.user.id]
    );
    res.json({ titre_offre: offre.titre, messages: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Liste de mes fils de discussion (locataire ou bailleur) ──
router.get("/", requireAuth, async (req, res) => {
  try {
    let r;
    if (req.user.role === "locataire") {
      r = await query(
        `SELECT DISTINCT ON (m.offre_id) m.offre_id, p.titre AS offre_titre, u.nom AS interlocuteur_nom, u.id AS interlocuteur_id,
                m.contenu AS dernier_message, m.created_at AS dernier_message_at,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.offre_id = m.offre_id AND m2.locataire_id = $1 AND m2.expediteur_id != $1 AND m2.lu = FALSE) AS non_lus
         FROM messages m
         JOIN offres o ON o.id = m.offre_id
         JOIN proprietes p ON p.id = o.propriete_id
         JOIN users u ON u.id = p.bailleur_id
         WHERE m.locataire_id = $1
         ORDER BY m.offre_id, m.created_at DESC`,
        [req.user.id]
      );
    } else {
      r = await query(
        `SELECT DISTINCT ON (m.offre_id, m.locataire_id) m.offre_id, m.locataire_id, p.titre AS offre_titre,
                u.nom AS interlocuteur_nom, u.id AS interlocuteur_id,
                m.contenu AS dernier_message, m.created_at AS dernier_message_at,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.offre_id = m.offre_id AND m2.locataire_id = m.locataire_id AND m2.expediteur_id != $1 AND m2.lu = FALSE) AS non_lus
         FROM messages m
         JOIN offres o ON o.id = m.offre_id
         JOIN proprietes p ON p.id = o.propriete_id
         JOIN users u ON u.id = m.locataire_id
         WHERE p.bailleur_id = $1
         ORDER BY m.offre_id, m.locataire_id, m.created_at DESC`,
        [req.user.id]
      );
    }
    res.json({ threads: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

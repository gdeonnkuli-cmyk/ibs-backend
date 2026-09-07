const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Laisser / modifier un avis (locataire, sur un contrat signé le liant au bailleur) ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { contrat_id, note, commentaire } = req.body;
    const n = Number(note);
    if (!contrat_id || !n || n < 1 || n > 5) return res.status(400).json({ error: "contrat_id et une note entre 1 et 5 sont requis." });

    const c = await query(`SELECT * FROM contrats WHERE id = $1`, [contrat_id]);
    const contrat = c.rows[0];
    if (!contrat) return res.status(404).json({ error: "Contrat introuvable." });
    if (contrat.locataire_id !== req.user.id) return res.status(403).json({ error: "Vous n'êtes pas le locataire de ce contrat." });
    if (contrat.statut !== "signe") return res.status(403).json({ error: "Un avis ne peut être laissé que pour un bail signé." });

    await query(
      `INSERT INTO avis (contrat_id, bailleur_id, locataire_id, note, commentaire)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (contrat_id, locataire_id) DO UPDATE SET note = $4, commentaire = $5`,
      [contrat_id, contrat.bailleur_id, req.user.id, n, commentaire || null]
    );
    await auditLog(req.user.id, "avis_depose", { contrat_id, bailleur_id: contrat.bailleur_id, note: n });
    res.status(201).json({ message: "Avis enregistré. Merci !" });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Avis existant du locataire courant pour un contrat donné (pré-remplissage du formulaire) ──
router.get("/mine/:contrat_id", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const r = await query(`SELECT note, commentaire FROM avis WHERE contrat_id = $1 AND locataire_id = $2`, [req.params.contrat_id, req.user.id]);
    res.json({ avis: r.rows[0] || null });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Avis publics reçus par un bailleur/agence ──
router.get("/bailleur/:bailleur_id", async (req, res) => {
  try {
    const r = await query(
      `SELECT a.note, a.commentaire, a.created_at, u.nom AS locataire_nom
       FROM avis a JOIN users u ON u.id = a.locataire_id
       WHERE a.bailleur_id = $1 ORDER BY a.created_at DESC LIMIT 30`,
      [req.params.bailleur_id]
    );
    const moyenne = r.rows.length ? r.rows.reduce((s, a) => s + a.note, 0) / r.rows.length : null;
    res.json({ avis: r.rows, note_moyenne: moyenne, avis_count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();

// ── Laisser / modifier un avis sur un quartier (réservé à ceux qui y ont eu un bail signé) ──
router.post("/", requireAuth, requireRole("locataire"), async (req, res) => {
  try {
    const { commune, note_securite, note_services, note_transport, commentaire } = req.body;
    const ns = Number(note_securite), nse = Number(note_services), nt = Number(note_transport);
    if (!commune || !ns || !nse || !nt) return res.status(400).json({ error: "commune et les 3 notes (1 à 5) sont requises." });

    const bail = await query(
      `SELECT 1 FROM contrats c JOIN offres o ON o.id = c.offre_id JOIN proprietes p ON p.id = o.propriete_id
       WHERE c.locataire_id = $1 AND p.commune = $2 AND c.statut = 'signe' LIMIT 1`,
      [req.user.id, commune]
    );
    if (!bail.rows.length) return res.status(403).json({ error: "Seuls les locataires ayant eu un bail signé dans ce quartier peuvent le noter." });

    await query(
      `INSERT INTO avis_quartier (commune, locataire_id, note_securite, note_services, note_transport, commentaire)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (commune, locataire_id) DO UPDATE SET
         note_securite = $3, note_services = $4, note_transport = $5, commentaire = $6`,
      [commune, req.user.id, ns, nse, nt, commentaire || null]
    );
    res.status(201).json({ message: "Avis sur le quartier enregistré." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Avis agrégés d'un quartier (public) ──
router.get("/:commune", async (req, res) => {
  try {
    const r = await query(
      `SELECT note_securite, note_services, note_transport, commentaire, created_at
       FROM avis_quartier WHERE commune = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.commune]
    );
    const n = r.rows.length;
    const avg = (k) => n ? Math.round((r.rows.reduce((s, a) => s + a[k], 0) / n) * 10) / 10 : null;
    res.json({
      commune: req.params.commune,
      avis_count: n,
      note_securite_moyenne: avg("note_securite"),
      note_services_moyenne: avg("note_services"),
      note_transport_moyenne: avg("note_transport"),
      avis: r.rows,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

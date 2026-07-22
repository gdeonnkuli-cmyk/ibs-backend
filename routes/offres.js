const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Publier une offre (bailleur, identité vérifiée requise) ──
router.post("/", requireAuth, requireRole("bailleur"), (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  if (user.cni_statut !== "verifie") {
    return res.status(403).json({ error: "Votre identité doit être vérifiée par l'équipe IBS avant de publier une offre." });
  }

  const { titre, type, commune, adresse, chambres, loyer_usd, description, titre_propriete_url } = req.body;
  if (!titre || !type || !commune || !loyer_usd) {
    return res.status(400).json({ error: "Titre, type, commune et loyer sont requis." });
  }

  const propriete = db
    .prepare(
      `INSERT INTO proprietes (bailleur_id, titre, type, commune, adresse, chambres, loyer_usd, description, titre_propriete_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user.id, titre, type, commune, adresse || null, chambres || 1, loyer_usd, description || null, titre_propriete_url || null);

  const offre = db
    .prepare(`INSERT INTO offres (propriete_id) VALUES (?)`)
    .run(propriete.lastInsertRowid);

  auditLog(user.id, "offre_publiee", { offre_id: offre.lastInsertRowid });

  res.status(201).json({
    message: "Offre publiée. Le badge \"Vérification en cours\" reste affiché tant que le titre de propriété n'est pas contrôlé.",
    offre_id: offre.lastInsertRowid,
  });
});

// ── Recherche / liste des offres (public) ────────────
router.get("/", (req, res) => {
  const { commune, budget_max, type, chambres } = req.query;
  let sql = `
    SELECT o.id AS offre_id, o.statut, o.vues, o.created_at,
           p.titre, p.type, p.commune, p.adresse, p.chambres, p.loyer_usd, p.description,
           p.statut_verification,
           u.nom AS bailleur_nom
    FROM offres o
    JOIN proprietes p ON p.id = o.propriete_id
    JOIN users u ON u.id = p.bailleur_id
    WHERE o.statut = 'active'
  `;
  const params = [];
  if (commune) { sql += ` AND p.commune = ?`; params.push(commune); }
  if (type) { sql += ` AND p.type = ?`; params.push(type); }
  if (budget_max) { sql += ` AND p.loyer_usd <= ?`; params.push(Number(budget_max)); }
  if (chambres) { sql += ` AND p.chambres >= ?`; params.push(Number(chambres)); }
  sql += ` ORDER BY o.created_at DESC`;

  const offres = db.prepare(sql).all(...params);
  res.json({ count: offres.length, offres });
});

// ── Détail d'une offre (incrémente les vues) ─────────
router.get("/:id", (req, res) => {
  const offre = db
    .prepare(
      `SELECT o.id AS offre_id, o.statut, o.vues, o.created_at,
              p.*, u.nom AS bailleur_nom, u.telephone AS bailleur_telephone
       FROM offres o
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = p.bailleur_id
       WHERE o.id = ?`
    )
    .get(req.params.id);
  if (!offre) return res.status(404).json({ error: "Offre introuvable." });

  db.prepare(`UPDATE offres SET vues = vues + 1 WHERE id = ?`).run(req.params.id);
  res.json({ offre });
});

// ── Mes offres (bailleur) ────────────────────────────
router.get("/mine/liste", requireAuth, requireRole("bailleur"), (req, res) => {
  const offres = db
    .prepare(
      `SELECT o.id AS offre_id, o.statut, o.vues, p.titre, p.commune, p.loyer_usd, p.statut_verification
       FROM offres o JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = ? ORDER BY o.created_at DESC`
    )
    .all(req.user.id);
  res.json({ offres });
});

// ── Admin : offres en attente de vérification du titre ──
router.get("/admin/verification-pending", requireAuth, requireRole("admin"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.titre, p.commune, p.bailleur_id, p.titre_propriete_url, u.nom AS bailleur_nom
       FROM proprietes p JOIN users u ON u.id = p.bailleur_id
       WHERE p.statut_verification = 'en_attente'`
    )
    .all();
  res.json({ proprietes: rows });
});

router.post("/admin/verify-propriete/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { decision } = req.body;
  if (!["verifie", "rejete"].includes(decision)) return res.status(400).json({ error: "Décision invalide." });
  db.prepare(`UPDATE proprietes SET statut_verification = ? WHERE id = ?`).run(decision, req.params.id);
  auditLog(req.user.id, "propriete_review", { propriete_id: req.params.id, decision });
  res.json({ message: "Décision enregistrée." });
});

module.exports = router;

const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Publier une offre (bailleur, identité vérifiée requise) ──
router.post("/", requireAuth, requireRole("bailleur","intermediaire"), async (req, res) => {
  try {
    const ur = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    const user = ur.rows[0];
    if (user.cni_statut !== "verifie") {
      return res.status(403).json({ error: "Votre identité doit être vérifiée par l'équipe IBS avant de publier une offre." });
    }

    const { titre, type, commune, adresse, chambres, loyer_usd, description, titre_propriete_url } = req.body;
    if (!titre || !type || !commune || !loyer_usd) {
      return res.status(400).json({ error: "Titre, type, commune et loyer sont requis." });
    }

    const p = await query(
      `INSERT INTO proprietes (bailleur_id, titre, type, commune, adresse, chambres, loyer_usd, description, titre_propriete_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [user.id, titre, type, commune, adresse || null, chambres || 1, loyer_usd, description || null, titre_propriete_url || null]
    );

    const o = await query(`INSERT INTO offres (propriete_id) VALUES ($1) RETURNING id`, [p.rows[0].id]);

    await auditLog(user.id, "offre_publiee", { offre_id: o.rows[0].id });

    res.status(201).json({
      message: "Offre publiée. Le badge \"Vérification en cours\" reste affiché tant que le titre de propriété n'est pas contrôlé.",
      offre_id: o.rows[0].id,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Recherche / liste des offres (public) ────────────
router.get("/", async (req, res) => {
  try {
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
    if (commune) { params.push(commune); sql += ` AND p.commune = $${params.length}`; }
    if (type) { params.push(type); sql += ` AND p.type = $${params.length}`; }
    if (budget_max) { params.push(Number(budget_max)); sql += ` AND p.loyer_usd <= $${params.length}`; }
    if (chambres) { params.push(Number(chambres)); sql += ` AND p.chambres >= $${params.length}`; }
    sql += ` ORDER BY o.created_at DESC`;

    const r = await query(sql, params);
    res.json({ count: r.rows.length, offres: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Détail d'une offre (incrémente les vues) ─────────
router.get("/:id", async (req, res) => {
  try {
    const r = await query(
      `SELECT o.id AS offre_id, o.statut, o.vues, o.created_at,
              p.*, u.nom AS bailleur_nom, u.telephone AS bailleur_telephone
       FROM offres o
       JOIN proprietes p ON p.id = o.propriete_id
       JOIN users u ON u.id = p.bailleur_id
       WHERE o.id = $1`,
      [req.params.id]
    );
    const offre = r.rows[0];
    if (!offre) return res.status(404).json({ error: "Offre introuvable." });

    await query(`UPDATE offres SET vues = vues + 1 WHERE id = $1`, [req.params.id]);
    res.json({ offre });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mes offres (bailleur) ────────────────────────────
router.get("/mine/liste", requireAuth, requireRole("bailleur","intermediaire"), async (req, res) => {
  try {
    const r = await query(
      `SELECT o.id AS offre_id, o.statut, o.vues, p.titre, p.commune, p.loyer_usd, p.statut_verification
       FROM offres o JOIN proprietes p ON p.id = o.propriete_id
       WHERE p.bailleur_id = $1 ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ offres: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Admin : offres en attente de vérification du titre ──
router.get("/admin/verification-pending", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(
      `SELECT p.id, p.titre, p.commune, p.bailleur_id, p.titre_propriete_url, u.nom AS bailleur_nom
       FROM proprietes p JOIN users u ON u.id = p.bailleur_id
       WHERE p.statut_verification = 'en_attente'`
    );
    res.json({ proprietes: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/verify-propriete/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { decision } = req.body;
    if (!["verifie", "rejete"].includes(decision)) return res.status(400).json({ error: "Décision invalide." });
    await query(`UPDATE proprietes SET statut_verification = $1 WHERE id = $2`, [decision, req.params.id]);
    await auditLog(req.user.id, "propriete_review", { propriete_id: req.params.id, decision });
    res.json({ message: "Décision enregistrée." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Bailleur : modifier une offre ────────────────────
router.patch("/:id", requireAuth, requireRole("bailleur","intermediaire"), async (req, res) => {
  try {
    const check = await query(
      `SELECT p.id, p.bailleur_id FROM offres o JOIN proprietes p ON p.id = o.propriete_id WHERE o.id = $1`,
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: "Offre introuvable." });
    if (check.rows[0].bailleur_id !== req.user.id) return res.status(403).json({ error: "Cette offre ne vous appartient pas." });

    const { titre, commune, adresse, chambres, loyer_usd, description } = req.body;
    await query(
      `UPDATE proprietes SET titre = $1, commune = $2, adresse = $3, chambres = $4, loyer_usd = $5, description = $6
       WHERE id = $7`,
      [titre, commune, adresse || null, chambres || 1, loyer_usd, description || null, check.rows[0].id]
    );
    await auditLog(req.user.id, "offre_modifiee", { offre_id: req.params.id });
    res.json({ message: "Offre mise à jour." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Bailleur : suspendre / réactiver une offre ───────
router.post("/:id/statut", requireAuth, requireRole("bailleur","intermediaire"), async (req, res) => {
  try {
    const { statut } = req.body;
    if (!["active", "suspendue"].includes(statut)) return res.status(400).json({ error: "Statut invalide." });

    const check = await query(
      `SELECT o.id, o.statut, p.bailleur_id FROM offres o JOIN proprietes p ON p.id = o.propriete_id WHERE o.id = $1`,
      [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: "Offre introuvable." });
    if (check.rows[0].bailleur_id !== req.user.id) return res.status(403).json({ error: "Cette offre ne vous appartient pas." });
    if (check.rows[0].statut === "louee") return res.status(400).json({ error: "Ce bien est déjà loué — impossible de changer son statut." });

    await query(`UPDATE offres SET statut = $1 WHERE id = $2`, [statut, req.params.id]);
    await auditLog(req.user.id, "offre_statut", { offre_id: req.params.id, statut });
    res.json({ message: statut === "active" ? "Offre réactivée." : "Offre suspendue." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

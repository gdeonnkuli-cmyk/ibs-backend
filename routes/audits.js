const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../auth");

const router = express.Router();

// ── Journal d'audit : dernières actions, avec filtre optionnel par action ou par compte ──
router.get("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { action, recherche, before } = req.query;
    let sql = `
      SELECT l.id, l.action, l.details, l.created_at, u.nom AS acteur_nom, u.role AS acteur_role, u.telephone AS acteur_telephone
      FROM logs_audit l LEFT JOIN users u ON u.id = l.user_id
      WHERE 1=1
    `;
    const params = [];
    if (action) { params.push(action); sql += ` AND l.action = $${params.length}`; }
    if (recherche) { params.push(`%${recherche}%`); sql += ` AND u.nom ILIKE $${params.length}`; }
    if (before) { params.push(before); sql += ` AND l.created_at < $${params.length}`; }
    sql += ` ORDER BY l.created_at DESC LIMIT 50`;

    const r = await query(sql, params);
    res.json({ logs: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

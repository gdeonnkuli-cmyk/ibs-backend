const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../auth");

const router = express.Router();

// ── Mes notifications ────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, canal, message, lu, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    const nonLues = await query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND lu = FALSE`, [req.user.id]);
    res.json({ notifications: r.rows, non_lues: nonLues.rows[0].n });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Marquer tout comme lu ─────────────────────────────
router.post("/marquer-lu", requireAuth, async (req, res) => {
  try {
    await query(`UPDATE notifications SET lu = TRUE WHERE user_id = $1 AND lu = FALSE`, [req.user.id]);
    res.json({ message: "Notifications marquées comme lues." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

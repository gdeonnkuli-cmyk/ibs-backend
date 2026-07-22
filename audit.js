const { query } = require("./db");

async function auditLog(userId, action, details = null, ip = null) {
  await query(
    `INSERT INTO logs_audit (user_id, action, details, ip) VALUES ($1, $2, $3, $4)`,
    [userId, action, details ? JSON.stringify(details) : null, ip]
  );
}

module.exports = { auditLog };

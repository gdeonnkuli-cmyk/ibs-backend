const db = require("./db");

function auditLog(userId, action, details = null, ip = null) {
  db.prepare(
    `INSERT INTO logs_audit (user_id, action, details, ip) VALUES (?, ?, ?, ?)`
  ).run(userId, action, details ? JSON.stringify(details) : null, ip);
}

module.exports = { auditLog };

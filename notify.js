const db = require("./db");

/**
 * Envoie une notification. Tant qu'aucune passerelle SMS (Africa's Talking, etc.)
 * n'est branchée, on journalise en console + on stocke en base pour affichage in-app.
 * Le jour où la passerelle est prête, seul ce fichier change — le reste de l'app n'a pas à bouger.
 */
function notify(userId, message, canal = "sms") {
  db.prepare(
    `INSERT INTO notifications (user_id, canal, message) VALUES (?, ?, ?)`
  ).run(userId, canal, message);
  console.log(`[NOTIF:${canal}] → user#${userId} : ${message}`);
}

function generateOtp(telephone, contexte = "connexion", contratId = null) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO otp_codes (telephone, code, contexte, contrat_id, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(telephone, code, contexte, contratId, expiresAt);
  console.log(`[OTP] → ${telephone} (${contexte}) : ${code} (valide 5 min)`);
  return code;
}

function verifyOtp(telephone, code, contexte = "connexion", contratId = null) {
  const row = db
    .prepare(
      `SELECT * FROM otp_codes WHERE telephone = ? AND code = ? AND contexte = ?
       AND (contrat_id IS ? OR contrat_id = ?) AND consomme = 0
       ORDER BY id DESC LIMIT 1`
    )
    .get(telephone, code, contexte, contratId, contratId);
  if (!row) return { ok: false, reason: "Code invalide." };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "Code expiré." };
  db.prepare(`UPDATE otp_codes SET consomme = 1 WHERE id = ?`).run(row.id);
  return { ok: true };
}

module.exports = { notify, generateOtp, verifyOtp };

const { query } = require("./db");

/**
 * Envoie une notification. Tant qu'aucune passerelle SMS (Africa's Talking, etc.)
 * n'est branchée, on journalise en console + on stocke en base pour affichage in-app.
 * Le jour où la passerelle est prête, seul ce fichier change — le reste de l'app n'a pas à bouger.
 */
async function notify(userId, message, canal = "sms") {
  await query(`INSERT INTO notifications (user_id, canal, message) VALUES ($1, $2, $3)`, [userId, canal, message]);
  console.log(`[NOTIF:${canal}] → user#${userId} : ${message}`);
}

async function generateOtp(telephone, contexte = "connexion", contratId = null) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await query(
    `INSERT INTO otp_codes (telephone, code, contexte, contrat_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [telephone, code, contexte, contratId, expiresAt]
  );
  console.log(`[OTP] → ${telephone} (${contexte}) : ${code} (valide 5 min)`);
  return code;
}

async function verifyOtp(telephone, code, contexte = "connexion", contratId = null) {
  const r = await query(
    `SELECT * FROM otp_codes WHERE telephone = $1 AND code = $2 AND contexte = $3
     AND (contrat_id IS NOT DISTINCT FROM $4) AND consomme = FALSE
     ORDER BY id DESC LIMIT 1`,
    [telephone, code, contexte, contratId]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, reason: "Code invalide." };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "Code expiré." };
  await query(`UPDATE otp_codes SET consomme = TRUE WHERE id = $1`, [row.id]);
  return { ok: true };
}

async function getLastOtp(telephone, contexte = "connexion") {
  const r = await query(
    `SELECT code FROM otp_codes WHERE telephone = $1 AND contexte = $2 ORDER BY id DESC LIMIT 1`,
    [telephone, contexte]
  );
  return r.rows[0] ? r.rows[0].code : null;
}

module.exports = { notify, generateOtp, verifyOtp, getLastOtp };

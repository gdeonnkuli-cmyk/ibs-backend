const { query } = require("./db");

/**
 * Envoi SMS réel via l'API Africa's Talking (appel direct, sans SDK, via fetch natif —
 * évite les dépendances vulnérables du SDK officiel). Si AT_API_KEY / AT_USERNAME ne
 * sont pas configurées, on repasse automatiquement en mode simulé (log console).
 */
const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY = process.env.AT_API_KEY;
const AT_SENDER_ID = process.env.AT_SENDER_ID || "";
const AT_SANDBOX = process.env.AT_SANDBOX === "true";
const AT_BASE_URL = AT_SANDBOX
  ? "https://api.sandbox.africastalking.com/version1/messaging"
  : "https://api.africastalking.com/version1/messaging";

async function sendSms(telephone, message) {
  if (!AT_API_KEY || !AT_USERNAME) {
    console.log(`[SMS-SIMULÉ · pas de passerelle configurée] → ${telephone} : ${message}`);
    return;
  }
  try {
    const body = new URLSearchParams({ username: AT_USERNAME, to: telephone, message });
    if (AT_SENDER_ID) body.set("from", AT_SENDER_ID);

    const res = await fetch(AT_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        apiKey: AT_API_KEY,
      },
      body: body.toString(),
    });
    const data = await res.json().catch(() => null);
    const status = data?.SMSMessageData?.Recipients?.[0]?.status;
    if (!res.ok || (status && status !== "Success")) {
      console.error("[SMS] Échec envoi Africa's Talking :", telephone, JSON.stringify(data));
    } else {
      console.log(`[SMS envoyé] → ${telephone}`);
    }
  } catch (e) {
    console.error("[SMS] Erreur réseau Africa's Talking :", e.message);
  }
}

/**
 * Envoie une notification. Le SMS part réellement si la passerelle est configurée ;
 * dans tous les cas, la notification est aussi stockée en base pour affichage in-app.
 */
async function notify(userId, message, canal = "sms") {
  await query(`INSERT INTO notifications (user_id, canal, message) VALUES ($1, $2, $3)`, [userId, canal, message]);
  if (canal === "sms") {
    const u = await query(`SELECT telephone FROM users WHERE id = $1`, [userId]);
    if (u.rows[0]) await sendSms(u.rows[0].telephone, message);
  } else {
    console.log(`[NOTIF:${canal}] → user#${userId} : ${message}`);
  }
}

async function generateOtp(telephone, contexte = "connexion", contratId = null) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await query(
    `INSERT INTO otp_codes (telephone, code, contexte, contrat_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [telephone, code, contexte, contratId, expiresAt]
  );
  const label = contexte === "signature" ? "Code de signature IBS" : "Code de vérification IBS";
  await sendSms(telephone, `${label} : ${code} (valide 5 minutes)`);
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

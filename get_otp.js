const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(__dirname + "/ibs.db");
const [,, telephone, contexte] = process.argv;
const row = db.prepare(`SELECT code FROM otp_codes WHERE telephone = ? AND contexte = ? ORDER BY id DESC LIMIT 1`).get(telephone, contexte || "connexion");
console.log(row ? row.code : "");

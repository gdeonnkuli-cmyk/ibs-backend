const bcrypt = require("bcryptjs");
const db = require("./db");

const telephone = process.env.ADMIN_PHONE || "+243800000000";
const password = process.env.ADMIN_PASSWORD || "admin123";

const existing = db.prepare(`SELECT id FROM users WHERE telephone = ?`).get(telephone);
if (existing) {
  console.log("Admin déjà existant :", telephone);
} else {
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (role, nom, telephone, password_hash, cni_statut, telephone_verifie)
     VALUES ('admin', 'Admin IBS', ?, ?, 'verifie', 1)`
  ).run(telephone, hash);
  console.log("Compte admin créé :", telephone, "/ mot de passe :", password);
}

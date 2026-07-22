require("dotenv").config();
const bcrypt = require("bcryptjs");
const { query, migrate, pool } = require("./db");

async function main() {
  await migrate();

  const telephone = process.env.ADMIN_PHONE || "+243800000000";
  const password = process.env.ADMIN_PASSWORD || "admin123";

  const existing = await query(`SELECT id FROM users WHERE telephone = $1`, [telephone]);
  if (existing.rows.length) {
    console.log("Admin déjà existant :", telephone);
  } else {
    const hash = bcrypt.hashSync(password, 10);
    await query(
      `INSERT INTO users (role, nom, telephone, password_hash, cni_statut, telephone_verifie)
       VALUES ('admin', 'Admin IBS', $1, $2, 'verifie', TRUE)`,
      [telephone, hash]
    );
    console.log("Compte admin créé :", telephone, "/ mot de passe :", password);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

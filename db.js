 // db.js — Connexion + schéma PostgreSQL (V0 IBS)
// Utilise DATABASE_URL, injectée automatiquement par Railway quand un plugin
// PostgreSQL est ajouté au projet. En local, définissez DATABASE_URL dans .env.
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL non définie — voir .env.example. L'API ne pourra pas se connecter à la base.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('bailleur','locataire','admin')),
      nom TEXT NOT NULL,
      telephone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      cni_recto_url TEXT,
      cni_verso_url TEXT,
      cni_statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(cni_statut IN ('en_attente','verifie','rejete')),
      telephone_verifie BOOLEAN NOT NULL DEFAULT FALSE,
      commune TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      telephone TEXT NOT NULL,
      code TEXT NOT NULL,
      contexte TEXT NOT NULL DEFAULT 'connexion',
      contrat_id INTEGER,
      expires_at TIMESTAMPTZ NOT NULL,
      consomme BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proprietes (
      id SERIAL PRIMARY KEY,
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      titre TEXT NOT NULL,
      type TEXT NOT NULL,
      commune TEXT NOT NULL,
      adresse TEXT,
      chambres INTEGER NOT NULL DEFAULT 1,
      loyer_usd REAL NOT NULL,
      description TEXT,
      titre_propriete_url TEXT,
      statut_verification TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut_verification IN ('en_attente','verifie','rejete')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS offres (
      id SERIAL PRIMARY KEY,
      propriete_id INTEGER NOT NULL REFERENCES proprietes(id),
      statut TEXT NOT NULL DEFAULT 'active' CHECK(statut IN ('active','suspendue','louee')),
      vues INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS demandes (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT,
      statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut IN ('en_attente','selectionnee','refusee')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contrats (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      loyer_usd REAL NOT NULL,
      duree_mois INTEGER NOT NULL DEFAULT 12,
      commission_usd REAL NOT NULL,
      reception_loyer TEXT,
      statut TEXT NOT NULL DEFAULT 'brouillon' CHECK(statut IN ('brouillon','en_confirmation','en_signature','signe','annule')),
      confirme_bailleur BOOLEAN NOT NULL DEFAULT FALSE,
      confirme_locataire BOOLEAN NOT NULL DEFAULT FALSE,
      signe_bailleur BOOLEAN NOT NULL DEFAULT FALSE,
      signe_locataire BOOLEAN NOT NULL DEFAULT FALSE,
      contenu_hash TEXT,
      reference_signature TEXT,
      signed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      canal TEXT NOT NULL DEFAULT 'sms',
      message TEXT NOT NULL,
      lu BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      contrat_id INTEGER REFERENCES contrats(id),
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs_audit (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ Schéma PostgreSQL prêt.");
  await ensureAdmin();
}

// Crée automatiquement le compte admin au démarrage s'il n'existe pas encore.
// Évite d'avoir à lancer une commande manuelle (impossible sans accès shell en production).
async function ensureAdmin() {
  const bcrypt = require("bcryptjs");
  const existingAdmin = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existingAdmin.rows.length) {
    console.log("✅ Compte admin déjà présent.");
    return;
  }

  const telephone = process.env.ADMIN_PHONE || "+243800000000";
  const password = process.env.ADMIN_PASSWORD || "admin123";

  const conflict = await pool.query(`SELECT id, role FROM users WHERE telephone = $1`, [telephone]);
  if (conflict.rows.length) {
    console.warn(
      `⚠️  ADMIN_PHONE (${telephone}) est déjà utilisé par un compte ${conflict.rows[0].role} existant. ` +
      `Changez la variable ADMIN_PHONE sur Railway pour un numéro non utilisé, puis redéployez.`
    );
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    `INSERT INTO users (role, nom, telephone, password_hash, cni_statut, telephone_verifie)
     VALUES ('admin', 'Admin IBS', $1, $2, 'verifie', TRUE)`,
    [telephone, hash]
  );
  console.log("✅ Compte admin créé automatiquement :", telephone);
}

module.exports = { pool, query, migrate };

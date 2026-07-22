// db.js — Connexion + schéma SQLite (V0 IBS)
// Migration vers PostgreSQL prévue en Phase 2 : le SQL reste volontairement standard.
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "ibs.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('bailleur','locataire','admin')),
  nom TEXT NOT NULL,
  telephone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  cni_recto_url TEXT,
  cni_verso_url TEXT,
  cni_statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(cni_statut IN ('en_attente','verifie','rejete')),
  telephone_verifie INTEGER NOT NULL DEFAULT 0,
  commune TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telephone TEXT NOT NULL,
  code TEXT NOT NULL,
  contexte TEXT NOT NULL DEFAULT 'connexion', -- connexion | signature
  contrat_id INTEGER,
  expires_at TEXT NOT NULL,
  consomme INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proprietes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bailleur_id INTEGER NOT NULL REFERENCES users(id),
  titre TEXT NOT NULL,
  type TEXT NOT NULL, -- studio | appartement | maison | villa
  commune TEXT NOT NULL,
  adresse TEXT,
  chambres INTEGER NOT NULL DEFAULT 1,
  loyer_usd REAL NOT NULL,
  description TEXT,
  titre_propriete_url TEXT,
  statut_verification TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut_verification IN ('en_attente','verifie','rejete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offres (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  propriete_id INTEGER NOT NULL REFERENCES proprietes(id),
  statut TEXT NOT NULL DEFAULT 'active' CHECK(statut IN ('active','suspendue','louee')),
  vues INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS demandes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offre_id INTEGER NOT NULL REFERENCES offres(id),
  locataire_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT,
  statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut IN ('en_attente','selectionnee','refusee')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contrats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offre_id INTEGER NOT NULL REFERENCES offres(id),
  bailleur_id INTEGER NOT NULL REFERENCES users(id),
  locataire_id INTEGER NOT NULL REFERENCES users(id),
  loyer_usd REAL NOT NULL,
  duree_mois INTEGER NOT NULL DEFAULT 12,
  commission_usd REAL NOT NULL,
  reception_loyer TEXT,
  statut TEXT NOT NULL DEFAULT 'brouillon' CHECK(statut IN ('brouillon','en_confirmation','en_signature','signe','annule')),
  confirme_bailleur INTEGER NOT NULL DEFAULT 0,
  confirme_locataire INTEGER NOT NULL DEFAULT 0,
  signe_bailleur INTEGER NOT NULL DEFAULT 0,
  signe_locataire INTEGER NOT NULL DEFAULT 0,
  contenu_hash TEXT,
  reference_signature TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  canal TEXT NOT NULL DEFAULT 'sms', -- sms | email | in_app
  message TEXT NOT NULL,
  lu INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  contrat_id INTEGER REFERENCES contrats(id),
  type TEXT NOT NULL, -- cni | titre_propriete | contrat_pdf
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;

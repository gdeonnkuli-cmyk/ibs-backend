const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken, requireAuth, requireRole } = require("../auth");
const { notify, generateOtp, verifyOtp } = require("../notify");
const { auditLog } = require("../audit");

const router = express.Router();

// ── Inscription ──────────────────────────────────────
// V0 : CNI = upload d'URL (le stockage réel de fichiers sera branché avec S3/Cloudinary en Phase 1).
router.post("/register", (req, res) => {
  const { role, nom, telephone, password, commune, cni_recto_url, cni_verso_url } = req.body;

  if (!role || !["bailleur", "locataire"].includes(role)) {
    return res.status(400).json({ error: "Rôle invalide (bailleur ou locataire)." });
  }
  if (!nom || !telephone || !password) {
    return res.status(400).json({ error: "Nom, téléphone et mot de passe sont requis." });
  }
  if (!cni_recto_url || !cni_verso_url) {
    return res.status(400).json({ error: "La CNI (recto et verso) est obligatoire pour s'inscrire sur IBS." });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE telephone = ?`).get(telephone);
  if (existing) return res.status(409).json({ error: "Ce numéro de téléphone est déjà utilisé." });

  const password_hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      `INSERT INTO users (role, nom, telephone, password_hash, commune, cni_recto_url, cni_verso_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(role, nom, telephone, password_hash, commune || null, cni_recto_url, cni_verso_url);

  auditLog(result.lastInsertRowid, "inscription", { role });

  // Envoi immédiat d'un OTP de vérification du téléphone
  generateOtp(telephone, "connexion");
  notify(result.lastInsertRowid, "Bienvenue sur IBS. Un code de vérification vous a été envoyé par SMS.", "sms");

  res.status(201).json({
    message: "Compte créé. Vérifiez votre téléphone avec le code reçu par SMS.",
    user_id: result.lastInsertRowid,
  });
});

// ── Vérification du téléphone par OTP (après inscription) ──
router.post("/verify-phone", (req, res) => {
  const { telephone, code } = req.body;
  const result = verifyOtp(telephone, code, "connexion");
  if (!result.ok) return res.status(400).json({ error: result.reason });

  const user = db.prepare(`SELECT * FROM users WHERE telephone = ?`).get(telephone);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

  db.prepare(`UPDATE users SET telephone_verifie = 1 WHERE id = ?`).run(user.id);
  auditLog(user.id, "telephone_verifie");

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// ── Connexion ────────────────────────────────────────
router.post("/login", (req, res) => {
  const { telephone, password } = req.body;
  const user = db.prepare(`SELECT * FROM users WHERE telephone = ?`).get(telephone);
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Téléphone ou mot de passe incorrect." });
  }
  if (!user.telephone_verifie) {
    return res.status(403).json({ error: "Téléphone non vérifié. Demandez un nouveau code." });
  }
  auditLog(user.id, "connexion");
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.post("/resend-otp", (req, res) => {
  const { telephone } = req.body;
  const user = db.prepare(`SELECT * FROM users WHERE telephone = ?`).get(telephone);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
  generateOtp(telephone, "connexion");
  res.json({ message: "Nouveau code envoyé." });
});

// ── Profil courant ───────────────────────────────────
router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  res.json({ user: publicUser(user) });
});

// ── Admin : vérification des CNI en attente ──────────
router.get("/admin/cni-pending", requireAuth, requireRole("admin"), (req, res) => {
  const rows = db
    .prepare(`SELECT id, nom, telephone, role, cni_recto_url, cni_verso_url, created_at FROM users WHERE cni_statut = 'en_attente'`)
    .all();
  res.json({ users: rows });
});

router.post("/admin/cni-review/:id", requireAuth, requireRole("admin"), (req, res) => {
  const { decision } = req.body; // 'verifie' | 'rejete'
  if (!["verifie", "rejete"].includes(decision)) {
    return res.status(400).json({ error: "Décision invalide." });
  }
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

  db.prepare(`UPDATE users SET cni_statut = ? WHERE id = ?`).run(decision, user.id);
  auditLog(req.user.id, "cni_review", { target: user.id, decision });
  notify(
    user.id,
    decision === "verifie"
      ? "Votre identité a été vérifiée. Vous pouvez publier ou candidater sur IBS."
      : "Votre pièce d'identité a été refusée. Merci d'en soumettre une nouvelle.",
    "in_app"
  );
  res.json({ message: "Décision enregistrée." });
});

function publicUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

module.exports = router;

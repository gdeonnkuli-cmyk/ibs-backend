const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db");
const { signToken, requireAuth, requireRole } = require("../auth");
const { notify, generateOtp, verifyOtp, getLastOtp } = require("../notify");
const { auditLog } = require("../audit");
const { urlDeStockageValide, MESSAGE_URL_INVALIDE } = require("../storage");
const { creerLimiteur, MESSAGE_LIMITE } = require("../ratelimit");

const router = express.Router();

// Un SMS part à chaque envoi de code : ces plafonds protègent le crédit
// Africa's Talking autant que les comptes.
const limiteEnvoiSms = creerLimiteur({ nom: "envoi-sms", max: 5, fenetreMinutes: 15 });
const limiteCodeErrone = creerLimiteur({ nom: "code-errone", max: 10, fenetreMinutes: 15 });
const limiteLoginTel = creerLimiteur({ nom: "login-telephone", max: 10, fenetreMinutes: 15 });
const limiteLoginIp = creerLimiteur({ nom: "login-ip", max: 30, fenetreMinutes: 15 });

function trop(res) {
  return res.status(429).json({ error: MESSAGE_LIMITE });
}

// ── Inscription ──────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { role, nom, telephone, password, commune, cni_recto_url, cni_verso_url, agrement_ou_rccm, nom_agence } = req.body;

    if (!role || !["bailleur", "locataire", "intermediaire"].includes(role)) {
      return res.status(400).json({ error: "Rôle invalide (bailleur, locataire ou intermédiaire/agence)." });
    }
    if (!nom || !telephone || !password) {
      return res.status(400).json({ error: "Nom, téléphone et mot de passe sont requis." });
    }
    if (!cni_recto_url || !cni_verso_url) {
      return res.status(400).json({ error: "La CNI (recto et verso) est obligatoire pour s'inscrire sur IBS." });
    }
    if (!urlDeStockageValide(cni_recto_url) || !urlDeStockageValide(cni_verso_url)) {
      return res.status(400).json({ error: MESSAGE_URL_INVALIDE });
    }
    if (role === "intermediaire" && !agrement_ou_rccm) {
      return res.status(400).json({ error: "Le numéro d'agrément ou de RCCM est obligatoire pour un compte Intermédiaire/Agence." });
    }

    if (limiteEnvoiSms.depasse(telephone)) return trop(res);

    const existing = await query(`SELECT id FROM users WHERE telephone = $1`, [telephone]);
    if (existing.rows.length) return res.status(409).json({ error: "Ce numéro de téléphone est déjà utilisé." });

    const password_hash = bcrypt.hashSync(password, 10);
    const inserted = await query(
      `INSERT INTO users (role, nom, telephone, password_hash, commune, cni_recto_url, cni_verso_url, agrement_ou_rccm, nom_agence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [role, nom, telephone, password_hash, commune || null, cni_recto_url, cni_verso_url,
       role === "intermediaire" ? agrement_ou_rccm : null, role === "intermediaire" ? (nom_agence || null) : null]
    );
    const userId = inserted.rows[0].id;

    await auditLog(userId, "inscription", { role });
    await generateOtp(telephone, "connexion");
    await notify(userId, "Bienvenue sur IBS. Un code de vérification vous a été envoyé par SMS.", "sms");

    res.status(201).json({
      message: "Compte créé. Vérifiez votre téléphone avec le code reçu par SMS.",
      user_id: userId,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Vérification du téléphone par OTP ──
router.post("/verify-phone", async (req, res) => {
  try {
    const { telephone, code } = req.body;
    if (limiteCodeErrone.depasse(telephone)) return trop(res);

    const result = await verifyOtp(telephone, code, "connexion");
    if (!result.ok) return res.status(400).json({ error: result.reason });
    limiteCodeErrone.reinitialiser(telephone);

    const r = await query(`SELECT * FROM users WHERE telephone = $1`, [telephone]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

    await query(`UPDATE users SET telephone_verifie = TRUE WHERE id = $1`, [user.id]);
    await auditLog(user.id, "telephone_verifie");

    const token = signToken(user);
    res.json({ token, user: publicUser({ ...user, telephone_verifie: true }) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Connexion ────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { telephone, password } = req.body;
    // Deux plafonds : par numéro contre l'acharnement sur un compte, par IP
    // contre le balayage de plusieurs comptes depuis la même machine.
    if (limiteLoginIp.depasse(req.ip)) return trop(res);

    const r = await query(`SELECT * FROM users WHERE telephone = $1`, [telephone]);
    const user = r.rows[0];
    if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
      if (limiteLoginTel.depasse(telephone)) return trop(res);
      return res.status(401).json({ error: "Téléphone ou mot de passe incorrect." });
    }
    limiteLoginTel.reinitialiser(telephone);
    if (!user.telephone_verifie) {
      return res.status(403).json({ error: "Téléphone non vérifié. Demandez un nouveau code." });
    }
    if (!user.actif) {
      return res.status(403).json({ error: "Cet accès a été désactivé. Contactez votre agence ou l'équipe IBS." });
    }
    await auditLog(user.id, "connexion");
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/resend-otp", async (req, res) => {
  try {
    const { telephone } = req.body;
    if (!telephone) return res.status(400).json({ error: "Téléphone requis." });
    if (limiteEnvoiSms.depasse(telephone)) return trop(res);

    const r = await query(`SELECT id FROM users WHERE telephone = $1`, [telephone]);
    // Réponse identique que le numéro existe ou non : un 404 permettait de
    // dresser la liste des numéros inscrits sur IBS.
    if (r.rows.length) await generateOtp(telephone, "connexion");
    res.json({ message: "Si ce numéro est inscrit, un nouveau code vient d'être envoyé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mot de passe oublié : demande de code ────────────
// Sans cette route, un utilisateur qui oublie son mot de passe est bloqué
// définitivement : il ne peut pas se reconnecter, et ne peut pas se réinscrire
// puisque son numéro est déjà pris.
router.post("/forgot-password", async (req, res) => {
  try {
    const { telephone } = req.body;
    if (!telephone) return res.status(400).json({ error: "Téléphone requis." });
    if (limiteEnvoiSms.depasse(telephone)) return trop(res);

    const r = await query(`SELECT id, actif FROM users WHERE telephone = $1`, [telephone]);
    const user = r.rows[0];
    // Réponse identique dans tous les cas : ni l'existence du compte, ni sa
    // suspension ne doivent se déduire de cet appel.
    if (user && user.actif) {
      await generateOtp(telephone, "reinitialisation");
      await auditLog(user.id, "reinitialisation_demandee");
    }
    res.json({ message: "Si ce numéro est inscrit, un code de réinitialisation vient d'être envoyé." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Mot de passe oublié : nouveau mot de passe ───────
router.post("/reset-password", async (req, res) => {
  try {
    const { telephone, code, nouveau_password } = req.body;
    if (!telephone || !code || !nouveau_password) {
      return res.status(400).json({ error: "Téléphone, code et nouveau mot de passe sont requis." });
    }
    if (nouveau_password.length < 6) {
      return res.status(400).json({ error: "Le mot de passe doit faire au moins 6 caractères." });
    }
    if (limiteCodeErrone.depasse(telephone)) return trop(res);

    const result = await verifyOtp(telephone, code, "reinitialisation");
    if (!result.ok) return res.status(400).json({ error: result.reason });

    const r = await query(`SELECT * FROM users WHERE telephone = $1`, [telephone]);
    const user = r.rows[0];
    if (!user) return res.status(400).json({ error: "Code invalide." });
    if (!user.actif) return res.status(403).json({ error: "Cet accès a été désactivé. Contactez l'équipe IBS." });

    const hash = bcrypt.hashSync(nouveau_password, 10);
    // Le téléphone est vérifié par le fait même d'avoir reçu le code : un
    // compte resté non vérifié devient utilisable par ce chemin.
    await query(
      `UPDATE users SET password_hash = $1, telephone_verifie = TRUE WHERE id = $2`,
      [hash, user.id]
    );
    limiteCodeErrone.reinitialiser(telephone);
    limiteLoginTel.reinitialiser(telephone);
    await auditLog(user.id, "mot_de_passe_reinitialise");
    await notify(user.id, "Votre mot de passe IBS a été modifié. Si vous n'êtes pas à l'origine de ce changement, contactez l'équipe IBS.", "sms");

    const token = signToken({ ...user, password_hash: hash });
    res.json({ token, user: publicUser({ ...user, telephone_verifie: true }) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Profil courant ───────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    const user = publicUser(r.rows[0]);
    if (user && user.agence_id) {
      const a = await query(`SELECT nom FROM users WHERE id = $1`, [user.agence_id]);
      user.agence_nom = a.rows[0]?.nom || null;
    }
    res.json({ user });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Admin : vérification des CNI en attente ──────────
router.get("/admin/cni-pending", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(
      `SELECT id, nom, telephone, role, cni_recto_url, cni_verso_url, created_at FROM users WHERE cni_statut = 'en_attente'`
    );
    res.json({ users: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

router.post("/admin/cni-review/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { decision } = req.body;
    if (!["verifie", "rejete"].includes(decision)) {
      return res.status(400).json({ error: "Décision invalide." });
    }
    const r = await query(`SELECT * FROM users WHERE id = $1`, [req.params.id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

    await query(`UPDATE users SET cni_statut = $1 WHERE id = $2`, [decision, user.id]);
    await auditLog(req.user.id, "cni_review", { target: user.id, decision });
    await notify(
      user.id,
      decision === "verifie"
        ? "Votre identité a été vérifiée. Vous pouvez publier ou candidater sur IBS."
        : "Votre pièce d'identité a été refusée. Merci d'en soumettre une nouvelle.",
      "in_app"
    );
    res.json({ message: "Décision enregistrée." });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── MODE TEST — à retirer dès qu'une vraie passerelle SMS est branchée ──
router.get("/dev/last-otp", async (req, res) => {
  try {
    if (process.env.DEV_MODE !== "true") return res.status(404).json({ error: "Mode test désactivé." });
    const { telephone, contexte } = req.query;
    if (!telephone) return res.status(400).json({ error: "Téléphone requis." });
    const code = await getLastOtp(telephone, contexte || "connexion");
    res.json({ code });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

module.exports = router;

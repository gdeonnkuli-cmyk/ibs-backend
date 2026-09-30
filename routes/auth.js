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

// ── Exigence de mot de passe ─────────────────────────────────────────────
// Huit caractères au minimum. Elle ne s'applique qu'au moment où un mot de
// passe est *choisi* — inscription, réinitialisation — jamais à la connexion :
// les comptes créés avant continuent de fonctionner avec le leur, comme
// demandé. Le durcir à la connexion enfermerait dehors des gens dont le seul
// tort est de s'être inscrits plus tôt.
//
// Jusqu'ici l'inscription ne vérifiait rien du tout : elle exigeait seulement
// qu'un mot de passe soit présent, fût-il d'un caractère. Le minimum de six
// n'existait que sur la réinitialisation.
const MOT_DE_PASSE_MIN = 8;

function motDePasseInsuffisant(mdp) {
  if (typeof mdp !== "string" || mdp.length < MOT_DE_PASSE_MIN) {
    return `Le mot de passe doit faire au moins ${MOT_DE_PASSE_MIN} caractères.`;
  }
  return null;
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
    const faible = motDePasseInsuffisant(password);
    if (faible) return res.status(400).json({ error: faible });
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
    const tropCourt = motDePasseInsuffisant(nouveau_password);
    if (tropCourt) return res.status(400).json({ error: tropCourt });
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
// ── Mettre à jour ses coordonnées ────────────────────────────────────────
//
// Changer son nom, son numéro ou sa commune, c'est changer ce sur quoi repose
// la vérification d'identité. Un compte gardait pourtant son badge « vérifié »
// quoi qu'on y modifie ensuite : un compte au bon historique pouvait être
// repointé vers quelqu'un d'autre sans que rien ne le signale.
//
// La revérification est donc exigée à chaque changement : pièce d'identité,
// portrait, et pour les professionnels les documents de la structure. Le badge
// retombe en attente jusqu'à ce que l'équipe IBS ait revu le tout.
//
// L'administrateur en est dispensé : c'est lui qui vérifie, il ne peut pas
// s'auto-débloquer, et sa vérification n'a pas le même objet.
const CHAMPS_IDENTITE = ["nom", "telephone", "commune"];

function estProfessionnel(u) {
  return u.role === "intermediaire" || u.est_professionnel === true;
}

router.patch("/me/coordonnees", requireAuth, async (req, res) => {
  try {
    const ur = await query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    const moi = ur.rows[0];
    if (!moi) return res.status(404).json({ error: "Compte introuvable." });

    const {
      nom, telephone, commune,
      cni_recto_url, cni_verso_url, portrait_url,
      nom_agence, agrement_ou_rccm, rccm_document_url,
      id_national, id_national_document_url,
      est_professionnel,
    } = req.body;

    // Ce qui change réellement. Renvoyer les mêmes valeurs ne doit rien exiger
    // ni faire retomber le badge : l'écran renvoie le formulaire entier.
    const vise = { nom, telephone, commune };
    const changes = CHAMPS_IDENTITE.filter(
      (c) => vise[c] !== undefined && String(vise[c] || "").trim() !== String(moi[c] || "")
    );
    const devientPro = est_professionnel === true && !moi.est_professionnel;
    if (!changes.length && !devientPro) {
      return res.status(400).json({ error: "Aucun changement à enregistrer." });
    }

    for (const c of changes) {
      if (!String(vise[c] || "").trim()) return res.status(400).json({ error: `Le champ « ${c} » ne peut pas être vide.` });
    }
    if (changes.includes("telephone")) {
      const autre = await query(`SELECT id FROM users WHERE telephone = $1 AND id <> $2`, [telephone.trim(), moi.id]);
      if (autre.rows.length) return res.status(409).json({ error: "Ce numéro de téléphone est déjà utilisé." });
    }

    // L'administrateur change ses coordonnées sans revérification.
    const dispense = moi.role === "admin";

    if (!dispense) {
      const manquantes = [];
      if (!cni_recto_url) manquantes.push("le recto de votre pièce d'identité");
      if (!cni_verso_url) manquantes.push("le verso de votre pièce d'identité");
      if (!portrait_url) manquantes.push("votre photo portrait");
      if (estProfessionnel({ ...moi, est_professionnel: est_professionnel ?? moi.est_professionnel })) {
        if (!String(nom_agence || moi.nom_agence || "").trim()) manquantes.push("le nom de votre structure");
        if (!String(agrement_ou_rccm || moi.agrement_ou_rccm || "").trim()) manquantes.push("votre numéro RCCM ou d'agrément");
        if (!rccm_document_url && !moi.rccm_document_url) manquantes.push("le document RCCM ou d'agrément");
        if (!id_national && !moi.id_national) manquantes.push("votre identification nationale");
      }
      if (manquantes.length) {
        return res.status(400).json({
          error: `Pour modifier vos coordonnées, IBS doit revérifier votre identité. Il manque : ${manquantes.join(", ")}.`,
          manquantes,
        });
      }
      for (const u of [cni_recto_url, cni_verso_url, portrait_url, rccm_document_url, id_national_document_url]) {
        if (u && !urlDeStockageValide(u)) return res.status(400).json({ error: MESSAGE_URL_INVALIDE });
      }
    }

    // Le numéro n'est plus vérifié dès qu'il change : le code de confirmation
    // doit repartir sur le nouveau, sinon il suffirait de le réécrire.
    const telChange = changes.includes("telephone");

    await query(
      `UPDATE users SET
         nom = coalesce($2, nom), telephone = coalesce($3, telephone), commune = coalesce($4, commune),
         cni_recto_url = coalesce($5, cni_recto_url), cni_verso_url = coalesce($6, cni_verso_url),
         portrait_url = coalesce($7, portrait_url),
         nom_agence = coalesce($8, nom_agence), agrement_ou_rccm = coalesce($9, agrement_ou_rccm),
         rccm_document_url = coalesce($10, rccm_document_url),
         id_national = coalesce($11, id_national), id_national_document_url = coalesce($12, id_national_document_url),
         est_professionnel = coalesce($13, est_professionnel),
         cni_statut = CASE WHEN $14 THEN cni_statut ELSE 'en_attente' END,
         telephone_verifie = CASE WHEN $15 THEN FALSE ELSE telephone_verifie END,
         coordonnees_maj_at = NOW()
       WHERE id = $1`,
      [moi.id,
       nom ? nom.trim() : null, telephone ? telephone.trim() : null, commune ? commune.trim() : null,
       cni_recto_url || null, cni_verso_url || null, portrait_url || null,
       nom_agence || null, agrement_ou_rccm || null, rccm_document_url || null,
       id_national || null, id_national_document_url || null,
       est_professionnel === undefined ? null : !!est_professionnel,
       dispense, telChange]
    );

    if (!dispense) {
      // Ce que l'administrateur devra comparer : l'ancienne valeur et la neuve.
      await query(
        `INSERT INTO changements_identite (user_id, champs) VALUES ($1, $2::jsonb)`,
        [moi.id, JSON.stringify(Object.fromEntries(
          changes.map((c) => [c, { avant: moi[c] || null, apres: String(vise[c]).trim() }])
        ))]
      );
    }
    await auditLog(moi.id, "coordonnees_modifiees", { champs: changes, revrification: !dispense });

    if (telChange) await generateOtp(telephone.trim(), "connexion");

    const r = await query(`SELECT * FROM users WHERE id = $1`, [moi.id]);
    const { password_hash, ...sain } = r.rows[0];
    res.json({
      message: dispense
        ? "Coordonnées mises à jour."
        : "Coordonnées mises à jour. Votre identité sera revérifiée par l'équipe IBS avant que vous puissiez "
          + (isBailleurLike(moi.role) ? "publier une offre" : "candidater") + " de nouveau.",
      reverification: !dispense,
      telephone_a_confirmer: telChange,
      user: sain,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

const isBailleurLike = (role) => role === "bailleur" || role === "intermediaire";

router.get("/admin/cni-pending", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await query(
      `SELECT u.id, u.nom, u.telephone, u.role, u.commune, u.cni_recto_url, u.cni_verso_url,
              u.portrait_url, u.est_professionnel, u.nom_agence, u.agrement_ou_rccm,
              u.rccm_document_url, u.id_national, u.id_national_document_url,
              u.created_at, u.coordonnees_maj_at,
              -- Ce qui a changé depuis la dernière vérification : sans cela,
              -- l'administrateur revoit une pièce sans savoir ce qu'elle doit
              -- confirmer, et une première inscription se confond avec une
              -- modification de coordonnées.
              (SELECT ci.champs FROM changements_identite ci
                WHERE ci.user_id = u.id AND ci.statut = 'en_attente'
                ORDER BY ci.created_at DESC LIMIT 1) AS changement
       FROM users u WHERE u.cni_statut = 'en_attente' ORDER BY u.coordonnees_maj_at DESC NULLS LAST, u.created_at DESC`
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
    // La demande de revérification suit la décision : sans cela, le changement
    // resterait « en attente » pour toujours et reviendrait à chaque écran.
    await query(
      `UPDATE changements_identite SET statut = $1, revu_par = $2, revu_at = NOW()
       WHERE user_id = $3 AND statut = 'en_attente'`,
      [decision, req.user.id, user.id]
    );
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

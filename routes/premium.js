const express = require("express");
const crypto = require("crypto");
const { query } = require("../db");
const { requireAuth, requireRole, agenceIdDe } = require("../auth");
const { auditLog } = require("../audit");

const router = express.Router();

const PRIX_PREMIUM_USD = 20;
const DUREE_JOURS = 30;
const FLW_SECRET = process.env.FLUTTERWAVE_SECRET_KEY || "";
const FLW_WEBHOOK_SECRET = process.env.FLUTTERWAVE_WEBHOOK_SECRET || "";
// URL de retour après paiement : doit pointer vers l'app hébergée (Netlify), pas un fichier local.
const REDIRECT_URL = process.env.FLUTTERWAVE_REDIRECT_URL || "";

function flutterwaveConfigure() {
  if (!FLW_SECRET) return "Paiements Premium non configurés (clé Flutterwave manquante côté serveur).";
  if (!REDIRECT_URL) return "Paiements Premium non configurés (URL de retour manquante côté serveur).";
  return null;
}

// ── Initier un paiement Premium (redirige vers la page de paiement Flutterwave) ──
router.post("/initier", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    const pbm = flutterwaveConfigure();
    if (pbm) return res.status(503).json({ error: pbm });

    const agenceId = agenceIdDe(req.user);
    const u = await query(`SELECT nom, telephone FROM users WHERE id = $1`, [agenceId]);
    const user = u.rows[0];
    const tx_ref = `IBS-PREM-${agenceId}-${Date.now()}`;
    const emailFictif = `${(user.telephone || "user").replace(/\D/g, "")}@ibs-users.cd`;

    const r = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${FLW_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref, amount: PRIX_PREMIUM_USD, currency: "USD",
        redirect_url: REDIRECT_URL,
        customer: { email: emailFictif, phonenumber: user.telephone, name: user.nom },
        customizations: { title: "IBS Premium", description: "Abonnement Premium bailleur — 1 mois" },
      }),
    });
    const data = await r.json();
    if (data.status !== "success" || !data.data?.link) {
      console.error("Flutterwave init error:", data);
      return res.status(502).json({ error: "Impossible de démarrer le paiement pour le moment." });
    }

    await query(
      `INSERT INTO abonnements_premium (bailleur_id, statut, montant_usd, tx_ref) VALUES ($1,'inactif',$2,$3)`,
      [agenceId, PRIX_PREMIUM_USD, tx_ref]
    );
    res.json({ link: data.data.link, tx_ref });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Vérifier un paiement après retour de Flutterwave (appelé par le frontend) ──
router.post("/verifier", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    if (!FLW_SECRET) return res.status(503).json({ error: "Paiements Premium non configurés." });
    const { transaction_id, tx_ref } = req.body;
    if (!transaction_id || !tx_ref) return res.status(400).json({ error: "transaction_id et tx_ref sont requis." });

    const agenceId = agenceIdDe(req.user);
    const abo = await query(`SELECT * FROM abonnements_premium WHERE tx_ref = $1 AND bailleur_id = $2`, [tx_ref, agenceId]);
    if (!abo.rows.length) return res.status(404).json({ error: "Référence de paiement introuvable." });

    const r = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET}` },
    });
    const data = await r.json();
    const tx = data.data;
    const valide = data.status === "success" && tx?.status === "successful" && tx?.tx_ref === tx_ref
      && Number(tx.amount) >= PRIX_PREMIUM_USD && tx.currency === "USD";

    if (!valide) {
      await query(`UPDATE abonnements_premium SET statut = 'expire' WHERE tx_ref = $1`, [tx_ref]);
      return res.status(402).json({ error: "Paiement non confirmé par Flutterwave." });
    }

    const expiration = new Date(Date.now() + DUREE_JOURS * 24 * 60 * 60 * 1000);
    await query(
      `UPDATE abonnements_premium SET statut = 'actif', flutterwave_transaction_id = $1, date_debut = NOW(), date_expiration = $2 WHERE tx_ref = $3`,
      [String(transaction_id), expiration, tx_ref]
    );
    await auditLog(req.user.id, "premium_active", { tx_ref, agence_id: agenceId });
    res.json({ message: "Abonnement Premium activé !", date_expiration: expiration });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Statut de mon abonnement Premium ──
router.get("/statut", requireAuth, requireRole("bailleur", "intermediaire"), async (req, res) => {
  try {
    const agenceId = agenceIdDe(req.user);
    const r = await query(
      `SELECT * FROM abonnements_premium WHERE bailleur_id = $1 AND statut = 'actif' AND date_expiration > NOW()
       ORDER BY date_expiration DESC LIMIT 1`,
      [agenceId]
    );
    if (!r.rows.length) return res.json({ actif: false });
    const abo = r.rows[0];
    const joursRestants = Math.ceil((new Date(abo.date_expiration) - new Date()) / (1000 * 60 * 60 * 24));
    res.json({ actif: true, date_expiration: abo.date_expiration, jours_restants: joursRestants, montant_usd: abo.montant_usd });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

// ── Webhook Flutterwave (optionnel mais recommandé : capture le paiement même si l'utilisateur
//    ferme son navigateur avant la redirection). À configurer dans le dashboard Flutterwave. ──
router.post("/webhook", express.json(), async (req, res) => {
  try {
    if (!FLW_WEBHOOK_SECRET) return res.status(503).end();
    const recu = String(req.headers["verif-hash"] || "");
    const attendu = FLW_WEBHOOK_SECRET;
    if (!recu || recu.length !== attendu.length || !crypto.timingSafeEqual(Buffer.from(recu), Buffer.from(attendu))) {
      return res.status(401).end();
    }

    const tx = req.body?.data;
    if (tx?.status === "successful" && tx?.tx_ref) {
      const expiration = new Date(Date.now() + DUREE_JOURS * 24 * 60 * 60 * 1000);
      await query(
        `UPDATE abonnements_premium SET statut = 'actif', flutterwave_transaction_id = $1, date_debut = NOW(), date_expiration = $2
         WHERE tx_ref = $3 AND statut != 'actif'`,
        [String(tx.id), expiration, tx.tx_ref]
      );
    }
    res.status(200).end();
  } catch (e) { console.error(e); res.status(500).end(); }
});

module.exports = router;

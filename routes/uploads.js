const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../auth");
const { DOSSIERS, stockageActif, signerUpload } = require("../storage");

const router = express.Router();

// Le dossier "cni" est ouvert sans jeton : à l'inscription, le compte n'existe
// pas encore. On limite donc les demandes anonymes par IP pour que la signature
// ne devienne pas un droit d'écriture illimité sur notre espace de stockage.
const FENETRE_MS = 10 * 60 * 1000;
const MAX_ANONYMES = 20;
const compteurs = new Map();

function quotaAnonymeDepasse(ip) {
  const maintenant = Date.now();
  const entree = compteurs.get(ip);
  if (!entree || maintenant - entree.debut > FENETRE_MS) {
    compteurs.set(ip, { debut: maintenant, n: 1 });
    return false;
  }
  entree.n += 1;
  return entree.n > MAX_ANONYMES;
}

// Purge périodique : sans elle, la Map grossit indéfiniment.
setInterval(() => {
  const maintenant = Date.now();
  for (const [ip, e] of compteurs) {
    if (maintenant - e.debut > FENETRE_MS) compteurs.delete(ip);
  }
}, FENETRE_MS).unref();

// ── Signature d'upload : le client téléverse ensuite directement chez l'hébergeur ──
router.post("/signature", async (req, res) => {
  try {
    if (!stockageActif()) {
      return res.status(503).json({
        error: "Stockage de fichiers non configuré sur ce serveur (CLOUDINARY_*).",
      });
    }

    const { dossier } = req.body;
    const conf = DOSSIERS[dossier];
    if (!conf) {
      return res.status(400).json({
        error: `Dossier invalide. Valeurs acceptées : ${Object.keys(DOSSIERS).join(", ")}.`,
      });
    }

    if (conf.authRequise) {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Authentification requise." });
      try {
        jwt.verify(token, JWT_SECRET);
      } catch {
        return res.status(401).json({ error: "Session invalide ou expirée." });
      }
    } else if (quotaAnonymeDepasse(req.ip)) {
      return res.status(429).json({ error: "Trop de demandes. Réessayez dans quelques minutes." });
    }

    res.json(signerUpload(dossier));
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur." }); }
});

module.exports = router;

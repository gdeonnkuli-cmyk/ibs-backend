// auth.js — Authentification JWT + contrôle d'accès par rôle
// Module central utilisé par TOUTES les routes (routes/*.js font `require("../auth")`).
// Ne pas confondre avec routes/auth.js (les endpoints d'inscription/connexion).
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Pas de valeur de repli : un secret par défaut publié dans le dépôt permettrait
  // à n'importe qui de forger un jeton admin. Mieux vaut refuser de démarrer.
  console.error("JWT_SECRET absente — refus de démarrer. Voir .env.example.");
  process.exit(1);
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, nom: user.nom, agence_id: user.agence_id || null }, JWT_SECRET, { expiresIn: "30d" });
}

// ── Sous-comptes agents : un agent rattaché (agence_id renseigné) agit toujours
//    pour le compte de l'agence principale — toutes les données (offres, contrats,
//    revenus...) sont donc rattachées à l'id de l'agence, jamais à celui de l'agent. ──
function agenceIdDe(user) {
  return (user && user.agence_id) || (user && user.id);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "Authentification requise." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session invalide ou expirée." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Accès refusé pour ce rôle." });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole, JWT_SECRET, agenceIdDe };

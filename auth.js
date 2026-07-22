const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "ibs-dev-secret-change-in-production";

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, telephone: user.telephone },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentification requise." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
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

module.exports = { signToken, requireAuth, requireRole, JWT_SECRET };

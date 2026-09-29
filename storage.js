// storage.js — Stockage des pièces justificatives (CNI, titres de propriété, photos).
//
// Le client n'envoie pas ses fichiers à l'API : il demande ici une signature
// d'upload, puis téléverse directement chez Cloudinary. L'API ne relaie jamais
// les octets — pas de limite de taille de requête à gérer, pas de fichier qui
// transite par le conteneur.
//
// Tant que CLOUDINARY_* n'est pas configuré, le stockage est inactif : les URLs
// sont acceptées telles quelles, comme avant. C'est le mode de développement.
const crypto = require("crypto");

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Dossiers autorisés — un client ne choisit pas où il écrit.
const DOSSIERS = {
  cni: { prefixe: "ibs/cni", authRequise: false },
  titres: { prefixe: "ibs/titres", authRequise: true },
  photos: { prefixe: "ibs/photos", authRequise: true },
};

function stockageActif() {
  return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

/**
 * Signe une demande d'upload Cloudinary. La signature est le SHA-1 des
 * paramètres triés par ordre alphabétique, concaténés à l'api_secret — qui ne
 * quitte jamais le serveur.
 */
function signerUpload(dossier) {
  if (!stockageActif()) throw new Error("Stockage non configuré.");
  const conf = DOSSIERS[dossier];
  if (!conf) throw new Error("Dossier inconnu.");

  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder: conf.prefixe, timestamp };
  const aSigner = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const signature = crypto.createHash("sha1").update(aSigner + API_SECRET).digest("hex");

  return {
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    timestamp,
    folder: conf.prefixe,
    signature,
    // Rendue configurable pour que le chemin de téléversement soit exécutable
    // contre un service factice : jusqu'ici il ne l'était qu'en production.
    upload_url: process.env.CLOUDINARY_UPLOAD_URL
      || `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`,
  };
}

/**
 * Une URL de pièce justificative doit pointer vers NOTRE espace de stockage.
 * Sans ce contrôle, n'importe qui déclare "http://x/cni.jpg" et passe pour
 * avoir fourni une pièce d'identité.
 *
 * Stockage inactif (développement) : on accepte, sinon plus rien ne fonctionne
 * en local.
 */
function urlDeStockageValide(url) {
  if (!stockageActif()) return true;
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "res.cloudinary.com" &&
      u.pathname.startsWith(`/${CLOUD_NAME}/`)
    );
  } catch {
    return false;
  }
}

const MESSAGE_URL_INVALIDE =
  "Document invalide : téléversez le fichier via /api/uploads/signature et transmettez l'URL retournée.";

module.exports = {
  DOSSIERS,
  stockageActif,
  signerUpload,
  urlDeStockageValide,
  MESSAGE_URL_INVALIDE,
};

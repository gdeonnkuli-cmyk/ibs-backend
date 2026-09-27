// ratelimit.js — Plafonds d'appel en mémoire.
//
// Sert deux besoins distincts :
//   · le coût — chaque OTP part en SMS facturé par Africa's Talking, une boucle
//     sur /resend-otp vide le crédit ;
//   · la force brute — un code à 6 chiffres ou un mot de passe se devinent si
//     l'on peut essayer sans fin.
//
// Le compteur vit dans le processus : il repart à zéro au redéploiement et
// n'est pas partagé entre plusieurs instances. C'est suffisant pour freiner un
// script, pas pour un attaquant distribué. Le jour où l'API tourne sur
// plusieurs conteneurs, il faudra le déporter (Redis, ou une table).

const limiteurs = [];

/**
 * @param {string} nom            identifiant lisible dans les logs
 * @param {number} max            nombre d'appels tolérés dans la fenêtre
 * @param {number} fenetreMinutes durée de la fenêtre glissante
 */
function creerLimiteur({ nom, max, fenetreMinutes }) {
  const fenetreMs = fenetreMinutes * 60 * 1000;
  const compteurs = new Map();
  const limiteur = {
    nom,
    max,
    fenetreMinutes,

    /** Incrémente et dit si la limite est franchie. */
    depasse(cle) {
      if (!cle) return false;
      const maintenant = Date.now();
      const e = compteurs.get(cle);
      if (!e || maintenant - e.debut > fenetreMs) {
        compteurs.set(cle, { debut: maintenant, n: 1 });
        return false;
      }
      e.n += 1;
      if (e.n > max) {
        console.warn(`[LIMITE] ${nom} dépassée pour ${cle} (${e.n} appels)`);
        return true;
      }
      return false;
    },

    /** Remet le compteur à zéro — après une authentification réussie. */
    reinitialiser(cle) {
      if (cle) compteurs.delete(cle);
    },

    purger(maintenant) {
      for (const [cle, e] of compteurs) {
        if (maintenant - e.debut > fenetreMs) compteurs.delete(cle);
      }
    },
  };
  limiteurs.push(limiteur);
  return limiteur;
}

// Une seule purge pour tous les limiteurs : sans elle, les Map grossissent
// indéfiniment à mesure que des numéros et des IP inconnus se présentent.
setInterval(() => {
  const maintenant = Date.now();
  for (const l of limiteurs) l.purger(maintenant);
}, 10 * 60 * 1000).unref();

/** Message unique, pour ne pas renseigner l'appelant sur le plafond exact. */
const MESSAGE_LIMITE = "Trop de tentatives. Réessayez dans quelques minutes.";

module.exports = { creerLimiteur, MESSAGE_LIMITE };

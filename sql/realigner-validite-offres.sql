-- realigner-validite-offres.sql
--
-- À exécuter UNE SEULE FOIS, après le passage de la validité des annonces de
-- 60 à 45 jours. Les annonces publiées avant ce changement portent encore une
-- échéance calculée sur 60 jours ; ce script les ramène à 45.
--
-- ── Le piège, et la règle retenue ──
--
-- Une annonce publiée il y a 50 jours a déjà dépassé 45. Un réalignement brut
-- la périmerait à la première passe du planificateur : en ligne le matin,
-- disparue le soir, sans que son bailleur ait reçu le moindre avertissement.
--
-- La règle est donc double : on n'avance une échéance que si
--   (a) elle avance réellement — on ne prolonge jamais une annonce ;
--   (b) la nouvelle date laisse encore au moins le préavis de 7 jours.
--
-- Conséquence assumée : une annonce publiée il y a plus de 38 jours (45 − 7)
-- garde son échéance de 60 jours et s'éteindra sur l'ancien calendrier. C'est
-- une exception bornée — au pire 22 jours de visibilité en trop — qui se
-- résorbe d'elle-même, et aucune annonce ne meurt sans préavis.
--
-- Seules les annonces actives sont concernées : suspendues, louées, expirées
-- et archivées ne sont pas en ligne, leur échéance n'a pas d'objet.
--
-- Le script est rejouable sans dégât : un second passage ne touche rien.

-- ── 1. À LIRE D'ABORD : ce que le script ferait, sans rien changer ──
SELECT
  count(*)                                                          AS annonces_actives,
  count(*) FILTER (WHERE publiee_at + INTERVAL '45 days' < expire_le
                     AND publiee_at + INTERVAL '45 days' > NOW() + INTERVAL '7 days')
                                                                    AS a_realigner,
  count(*) FILTER (WHERE publiee_at + INTERVAL '45 days' <= NOW() + INTERVAL '7 days'
                     AND expire_le > NOW())
                                                                    AS laissees_au_regime_60,
  count(*) FILTER (WHERE expire_le <= NOW())                        AS deja_echues,
  min(publiee_at)::date                                             AS plus_ancienne_publication
FROM offres
WHERE statut = 'active' AND publiee_at IS NOT NULL;

-- Lecture des colonnes :
--   a_realigner            → ce que l'UPDATE va modifier.
--   laissees_au_regime_60  → trop anciennes pour être avancées avec préavis ;
--                            intactes, elles expireront sur l'ancienne date.
--   deja_echues            → échéance déjà passée sous le régime 60 ; elles
--                            sont périmées par le planificateur, indépendamment
--                            de ce script, qui ne les ressuscite pas.

-- ── 2. Le détail, annonce par annonce ──
SELECT o.id, p.titre, p.commune,
       o.publiee_at::date                          AS publiee_le,
       o.expire_le::date                           AS echeance_actuelle,
       (o.publiee_at + INTERVAL '45 days')::date    AS echeance_45j,
       CASE
         WHEN o.expire_le <= NOW()                                       THEN 'déjà échue'
         WHEN o.publiee_at + INTERVAL '45 days' >= o.expire_le            THEN 'rien à faire'
         WHEN o.publiee_at + INTERVAL '45 days' <= NOW() + INTERVAL '7 days'
                                                                         THEN 'laissée au régime 60'
         ELSE 'réalignée'
       END                                         AS sort
FROM offres o
JOIN proprietes p ON p.id = o.propriete_id
WHERE o.statut = 'active' AND o.publiee_at IS NOT NULL
ORDER BY o.publiee_at;

-- ── 3. LE RÉALIGNEMENT ──
-- Décommenter et exécuter seulement après avoir lu ce qui précède.
-- BEGIN;
--
-- UPDATE offres
-- SET expire_le = publiee_at + INTERVAL '45 days',
--     -- Le jalon d'avertissement est remis à zéro : une annonce dont
--     -- l'échéance se rapproche doit pouvoir être signalée de nouveau, même si
--     -- elle l'avait déjà été pour l'ancienne date.
--     rappel_expiration_at = NULL
-- WHERE statut = 'active'
--   AND publiee_at IS NOT NULL
--   AND publiee_at + INTERVAL '45 days' < expire_le               -- (a) on n'allonge pas
--   AND publiee_at + INTERVAL '45 days' > NOW() + INTERVAL '7 days'; -- (b) le préavis reste possible
--
-- -- Comparer le nombre de lignes annoncé avec « a_realigner » ci-dessus, puis :
-- COMMIT;
-- -- ou, si le compte surprend :
-- -- ROLLBACK;

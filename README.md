# IBS — Backend V0 (API)

API du périmètre V0 défini dans *IBS_Spec_V0_Publique.docx* : comptes vérifiés, offres, candidatures, contrat + confirmation avant signature + signature électronique OTP, tableau de bord d'adoption.

## Stack

- **Node.js + Express** (au lieu de Laravel — voir note ci-dessous) 
- **PostgreSQL** via le driver `pg` — base persistante, indépendante du conteneur applicatif
- **JWT** pour les sessions, **bcrypt** pour les mots de passe
- OTP SMS **simulé** : les codes sont écrits dans la console et dans la table `notifications` tant qu'aucune passerelle SMS (Africa's Talking, etc.) n'est branchée — voir `notify.js`. Un endpoint temporaire `GET /api/auth/dev/last-otp?telephone=&contexte=` permet de récupérer le dernier code depuis l'app pendant les tests (désactivable avec `DEV_MODE=false`).

> **Pourquoi Node.js et pas Laravel ?** Le choix technique d'origine (Laravel + PostgreSQL) reste valide pour la suite du projet. Ce backend a été écrit en Node.js parce que l'environnement de développement utilisé ici n'a pas accès à Composer/Packagist. Le schéma de données et les routes sont volontairement simples à porter vers Laravel par le développeur qui sera recruté — c'est une implémentation de référence, pas un choix figé.

## Installation

```bash

npm install
cp .env.example .env   # renseigner DATABASE_URL (fourni automatiquement par Railway si le plugin PostgreSQL est ajouté)
npm run seed            # crée les tables + le compte admin
node server.js           # démarre l'API sur http://localhost:3000
```

## Structure

```
server.js          → point d'entrée Express, lance la migration au démarrage
db.js               → connexion PostgreSQL (pool `pg`) + schéma (fonction migrate())
auth.js             → JWT (signature, middleware requireAuth/requireRole)
notify.js           → notifications + OTP (stub SMS) + lecture du dernier code (mode test)
audit.js            → journal d'audit (logs_audit)
routes/
  auth.js           → inscription, vérification téléphone, connexion, vérification CNI (admin), endpoint mode test
  offres.js         → publication, recherche/filtres, vérification titre de propriété (admin)
  demandes.js        → candidature locataire, sélection bailleur
  contrats.js         → préparation → confirmation avant signature → signature OTP → archivage
  stats.js           → tableau de bord admin (entonnoir d'adoption défini dans la spec V0)
smoketest.sh        → scénario de bout en bout (inscription → signature) pour vérifier que tout fonctionne, contre une instance en cours d'exécution (locale ou distante)
```

## Tester le parcours complet

Contre une instance locale (nécessite `DATABASE_URL` valide dans `.env`) :
```bash
node server.js
```
Dans un second terminal :
```bash
bash smoketest.sh
```
Contre l'instance en ligne, changez simplement `BASE` en tête de `smoketest.sh` vers l'URL Railway.

Ce script rejoue tout le parcours V0 : inscription bailleur + locataire → vérification téléphone → vérification CNI par l'admin → publication d'une offre → recherche → candidature → sélection → préparation du contrat → confirmation avant signature (les deux parties) → signature électronique OTP (les deux parties) → contrat archivé avec empreinte SHA-256 → tableau de bord.

## Endpoints principaux

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Inscription (CNI recto/verso obligatoires) |
| POST | `/api/auth/verify-phone` | Vérification du téléphone par OTP |
| POST | `/api/auth/login` | Connexion |
| GET  | `/api/auth/admin/cni-pending` | CNI en attente de vérification (admin) |
| POST | `/api/auth/admin/cni-review/:id` | Valider/rejeter une CNI (admin) |
| POST | `/api/offres` | Publier une offre (bailleur vérifié) |
| GET  | `/api/offres?commune=&budget_max=&type=&chambres=` | Recherche publique |
| POST | `/api/demandes` | Candidater sur une offre (locataire vérifié) |
| POST | `/api/demandes/:id/selectionner` | Sélectionner un candidat → crée le contrat |
| POST | `/api/contrats/:id/preparer` | Durée + réception des loyers |
| POST | `/api/contrats/:id/confirmer` | Confirmation avant signature (par partie) |
| POST | `/api/contrats/:id/signer` | Signature électronique OTP (par partie) |
| GET  | `/api/admin/stats` | Entonnoir d'adoption (comptes → offres → candidatures → contrats signés) |

## Pièces justificatives (CNI, titres, photos)

Les fichiers ne transitent pas par l'API : le client demande une signature, puis
téléverse directement chez Cloudinary.

```
POST /api/uploads/signature   { "dossier": "cni" | "titres" | "photos" }
  → { cloud_name, api_key, timestamp, folder, signature, upload_url }
```

Le client POST ensuite le fichier sur `upload_url` en multipart avec ces champs,
et conserve le `secure_url` renvoyé : c'est lui qu'il transmet à l'API dans
`cni_recto_url`, `titre_propriete_url`, `photos[]`.

`dossier: "cni"` est accessible sans jeton — à l'inscription le compte n'existe
pas encore — mais limité à 20 demandes par IP et par tranche de 10 minutes.
`titres` et `photos` exigent un jeton.

Les URLs enregistrées sont vérifiées : elles doivent pointer vers le cloud
configuré. Sans cela, n'importe qui déclare une URL quelconque et passe pour
avoir fourni une pièce d'identité.

Tant que `CLOUDINARY_*` n'est pas renseigné, le stockage est inactif :
`/api/uploads/signature` rend 503 et les URLs sont acceptées telles quelles.
C'est le mode de développement — à ne pas laisser en production.

## Ce qui n'est volontairement PAS dans ce V0

Conforme à *IBS_Spec_V0_Publique.docx* : pas d'intégration Flutterwave/Mobile Money in-app, pas de RCCM/IDNAT/NIF, pas de cartographie, pas de service déménagement, pas de médiation formalisée. Le champ `reception_loyer` sur le contrat sert de solution transitoire (le loyer et la commission se règlent hors plateforme pour l'instant).

## Prochaines étapes techniques

1. ~~Brancher une vraie passerelle SMS~~ — fait : Africa's Talking dans `notify.js` (repli en mode simulé sans clés)
2. ~~Brancher un stockage de fichiers réel~~ — fait : Cloudinary en upload signé direct (voir plus haut)
3. ~~Générer un vrai PDF du contrat signé~~ — fait : pdfkit dans `contrats.js`, avec filigrane traçable
4. Migrer PostgreSQL en Phase 1 vers une instance managée dédiée (hors Railway) si le volume le justifie
5. Brancher le frontend (les prototypes HTML `IBS_App_Smartphone.html` / `IBS_App_PC.html`) sur cette API à la place des données simulées en JS

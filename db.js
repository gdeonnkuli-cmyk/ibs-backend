// db.js — Connexion + schéma PostgreSQL (V0 IBS)
// Utilise DATABASE_URL, injectée automatiquement par Railway quand un plugin
// PostgreSQL est ajouté au projet. En local, définissez DATABASE_URL dans .env.
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL non définie — voir .env.example. L'API ne pourra pas se connecter à la base.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('bailleur','locataire','admin')),
      nom TEXT NOT NULL,
      telephone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      cni_recto_url TEXT,
      cni_verso_url TEXT,
      cni_statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(cni_statut IN ('en_attente','verifie','rejete')),
      telephone_verifie BOOLEAN NOT NULL DEFAULT FALSE,
      commune TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      telephone TEXT NOT NULL,
      code TEXT NOT NULL,
      contexte TEXT NOT NULL DEFAULT 'connexion',
      contrat_id INTEGER,
      expires_at TIMESTAMPTZ NOT NULL,
      consomme BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proprietes (
      id SERIAL PRIMARY KEY,
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      titre TEXT NOT NULL,
      type TEXT NOT NULL,
      commune TEXT NOT NULL,
      adresse TEXT,
      chambres INTEGER NOT NULL DEFAULT 1,
      loyer_usd REAL NOT NULL,
      description TEXT,
      titre_propriete_url TEXT,
      statut_verification TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut_verification IN ('en_attente','verifie','rejete')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS offres (
      id SERIAL PRIMARY KEY,
      propriete_id INTEGER NOT NULL REFERENCES proprietes(id),
      statut TEXT NOT NULL DEFAULT 'active' CHECK(statut IN ('active','suspendue','louee')),
      vues INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS demandes (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT,
      statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut IN ('en_attente','selectionnee','refusee')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contrats (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      loyer_usd REAL NOT NULL,
      duree_mois INTEGER NOT NULL DEFAULT 12,
      commission_usd REAL NOT NULL,
      reception_loyer TEXT,
      statut TEXT NOT NULL DEFAULT 'brouillon' CHECK(statut IN ('brouillon','en_confirmation','en_signature','signe','annule')),
      confirme_bailleur BOOLEAN NOT NULL DEFAULT FALSE,
      confirme_locataire BOOLEAN NOT NULL DEFAULT FALSE,
      signe_bailleur BOOLEAN NOT NULL DEFAULT FALSE,
      signe_locataire BOOLEAN NOT NULL DEFAULT FALSE,
      contenu_hash TEXT,
      reference_signature TEXT,
      signed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      canal TEXT NOT NULL DEFAULT 'sms',
      message TEXT NOT NULL,
      lu BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      contrat_id INTEGER REFERENCES contrats(id),
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs_audit (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ Schéma PostgreSQL prêt.");

  // ── Migration : ouverture du rôle Intermédiaire / Agence ──
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS agrement_ou_rccm TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nom_agence TEXT;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('bailleur','locataire','admin','intermediaire'));
  `);
  console.log("✅ Rôle Intermédiaire / Agence disponible.");

  // ── Migration : caractéristiques enrichies de l'offre ──
  // (garantie en mois, charges incluses ou non, équipements cochés, disponibilité)
  await pool.query(`
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS garantie_mois INTEGER;
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS charges_incluses BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS equipements TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS disponibilite TEXT NOT NULL DEFAULT 'immediat';
    ALTER TABLE proprietes DROP CONSTRAINT IF EXISTS proprietes_disponibilite_check;
    ALTER TABLE proprietes ADD CONSTRAINT proprietes_disponibilite_check
      CHECK (disponibilite IN ('immediat','sous_7j','sous_30j'));
  `);
  console.log("✅ Champs offre enrichis (garantie, charges, équipements, disponibilité) disponibles.");

  // ── Migration : abonnements locataire → bailleur/agence ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS abonnements (
      id SERIAL PRIMARY KEY,
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(locataire_id, bailleur_id)
    );
  `);
  console.log("✅ Table abonnements prête.");

  // ── Migration : carnet numérique de loyer (historique de paiements par contrat signé) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paiements_loyer (
      id SERIAL PRIMARY KEY,
      contrat_id INTEGER NOT NULL REFERENCES contrats(id),
      mois DATE NOT NULL,
      montant_usd REAL NOT NULL,
      moyen TEXT,
      declare_par INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(contrat_id, mois)
    );
  `);
  console.log("✅ Table paiements_loyer prête.");

  // ── Migration : avis du locataire sur le bailleur/agence après un bail signé ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avis (
      id SERIAL PRIMARY KEY,
      contrat_id INTEGER NOT NULL REFERENCES contrats(id),
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      note INTEGER NOT NULL CHECK (note BETWEEN 1 AND 5),
      commentaire TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(contrat_id, locataire_id)
    );
  `);
  console.log("✅ Table avis prête.");

  // ── Migration : messagerie interne locataire ↔ bailleur, par offre ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      expediteur_id INTEGER NOT NULL REFERENCES users(id),
      contenu TEXT NOT NULL,
      lu BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ Table messages prête.");

  // ── Migration : alertes de recherche (SP8) — notifie le locataire à la publication d'une offre correspondante ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alertes (
      id SERIAL PRIMARY KEY,
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      commune TEXT,
      type TEXT,
      budget_max REAL,
      chambres INTEGER,
      actif BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ Table alertes prête.");

  // ── Migration : favoris (locataire sauvegarde une offre) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS favoris (
      id SERIAL PRIMARY KEY,
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(locataire_id, offre_id)
    );
  `);
  console.log("✅ Table favoris prête.");

  // ── Migration : profil locataire enrichi (accompagne automatiquement chaque candidature) ──
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profession TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS revenu_usd REAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nb_occupants INTEGER;
  `);
  console.log("✅ Profil locataire enrichi (profession, revenu, occupants) disponible.");

  // ── Migration : rappel de fin de bail (anti-spam : un rappel max tous les 7 jours) ──
  await pool.query(`
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS dernier_rappel_echeance TIMESTAMPTZ;
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS dernier_rappel_impaye TIMESTAMPTZ;
  `);
  console.log("✅ Champ rappel de fin de bail disponible sur les contrats.");

  // ── Migration : signalement d'une annonce suspecte ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signalements (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      motif TEXT NOT NULL,
      details TEXT,
      statut TEXT NOT NULL DEFAULT 'en_attente',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE signalements DROP CONSTRAINT IF EXISTS signalements_statut_check;
    ALTER TABLE signalements ADD CONSTRAINT signalements_statut_check
      CHECK (statut IN ('en_attente','traite','rejete'));
  `);
  console.log("✅ Table signalements prête.");

  // ── Migration : avis sur le quartier (commune), réservé à ceux qui y ont eu un bail signé ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avis_quartier (
      id SERIAL PRIMARY KEY,
      commune TEXT NOT NULL,
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      note_securite INTEGER NOT NULL,
      note_services INTEGER NOT NULL,
      note_transport INTEGER NOT NULL,
      commentaire TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(commune, locataire_id)
    );
    ALTER TABLE avis_quartier DROP CONSTRAINT IF EXISTS avis_quartier_note_securite_check;
    ALTER TABLE avis_quartier ADD CONSTRAINT avis_quartier_note_securite_check CHECK (note_securite BETWEEN 1 AND 5);
    ALTER TABLE avis_quartier DROP CONSTRAINT IF EXISTS avis_quartier_note_services_check;
    ALTER TABLE avis_quartier ADD CONSTRAINT avis_quartier_note_services_check CHECK (note_services BETWEEN 1 AND 5);
    ALTER TABLE avis_quartier DROP CONSTRAINT IF EXISTS avis_quartier_note_transport_check;
    ALTER TABLE avis_quartier ADD CONSTRAINT avis_quartier_note_transport_check CHECK (note_transport BETWEEN 1 AND 5);
  `);
  console.log("✅ Table avis_quartier prête.");

  // ── Migration : galerie de photos par offre (URLs hébergées, ex. Cloudinary) ──
  await pool.query(`
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}';
  `);
  console.log("✅ Champ photos disponible sur les offres.");

  // ── Migration : sous-comptes agents (une agence peut créer des agents rattachés) ──
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS agence_id INTEGER REFERENCES users(id);
  `);
  console.log("✅ Champ agence_id disponible (sous-comptes agents).");

  // ── Migration : compte désactivable (utilisé pour retirer l'accès d'un agent sans casser l'historique) ──
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS actif BOOLEAN NOT NULL DEFAULT TRUE;
  `);
  console.log("✅ Champ actif disponible sur les comptes.");

  // ── Migration : multi-mandants (l'agence gère un bien pour le compte d'un propriétaire réel) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mandants (
      id SERIAL PRIMARY KEY,
      intermediaire_id INTEGER NOT NULL REFERENCES users(id),
      nom TEXT NOT NULL,
      telephone TEXT,
      commune TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS mandant_id INTEGER REFERENCES mandants(id);
  `);
  console.log("✅ Table mandants prête.");

  // ── Migration : détection de prix anormal (comparaison au marché du quartier à la publication) ──
  await pool.query(`
    ALTER TABLE proprietes ADD COLUMN IF NOT EXISTS prix_suspect BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  console.log("✅ Champ prix_suspect disponible.");

  // ── Migration : abonnement Premium bailleur (paiement Flutterwave) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS abonnements_premium (
      id SERIAL PRIMARY KEY,
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      statut TEXT NOT NULL DEFAULT 'inactif',
      montant_usd REAL NOT NULL,
      tx_ref TEXT UNIQUE NOT NULL,
      flutterwave_transaction_id TEXT,
      date_debut TIMESTAMPTZ,
      date_expiration TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE abonnements_premium DROP CONSTRAINT IF EXISTS abonnements_premium_statut_check;
    ALTER TABLE abonnements_premium ADD CONSTRAINT abonnements_premium_statut_check
      CHECK (statut IN ('inactif','actif','expire'));
  `);
  console.log("✅ Table abonnements_premium prête.");

  // ── Migration : planification de visite ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visites (
      id SERIAL PRIMARY KEY,
      offre_id INTEGER NOT NULL REFERENCES offres(id),
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      bailleur_id INTEGER NOT NULL REFERENCES users(id),
      date_proposee TIMESTAMPTZ NOT NULL,
      statut TEXT NOT NULL DEFAULT 'en_attente',
      dernier_proposant TEXT NOT NULL DEFAULT 'locataire',
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE visites DROP CONSTRAINT IF EXISTS visites_statut_check;
    ALTER TABLE visites ADD CONSTRAINT visites_statut_check CHECK (statut IN ('en_attente','acceptee','refusee','annulee'));
    ALTER TABLE visites DROP CONSTRAINT IF EXISTS visites_proposant_check;
    ALTER TABLE visites ADD CONSTRAINT visites_proposant_check CHECK (dernier_proposant IN ('locataire','bailleur'));
  `);
  console.log("✅ Table visites prête.");

  // ── Migration : validation des paiements par les deux parties ──
  // Un mois déclaré par le locataire ne vaut plus quittance à lui seul : il
  // attend la confirmation du bailleur. Les lignes créées avant cette
  // migration passent en "confirme" — elles ont été déclarées sous l'ancien
  // régime et il serait faux de les remettre rétroactivement en cause.
  await pool.query(`
    ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS statut TEXT NOT NULL DEFAULT 'confirme';
    ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS confirme_par INTEGER REFERENCES users(id);
    ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS confirme_at TIMESTAMPTZ;
    ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS conteste_par INTEGER REFERENCES users(id);
    ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS conteste_at TIMESTAMPTZ;
    ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS motif_contestation TEXT;
    ALTER TABLE paiements_loyer DROP CONSTRAINT IF EXISTS paiements_statut_check;
    ALTER TABLE paiements_loyer ADD CONSTRAINT paiements_statut_check
      CHECK (statut IN ('en_attente','confirme','conteste'));
  `);
  console.log("✅ Validation des paiements prête.");

  // ── Migration : fin de bail ──
  // Un bail pouvait être créé, signé et renouvelé, mais jamais terminé. La
  // garantie, pourtant stockée au contrat, n'avait aucune trace de
  // restitution — or c'est le premier objet de litige entre bailleur et
  // locataire à Kinshasa.
  await pool.query(`
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS preavis_par INTEGER REFERENCES users(id);
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS preavis_at TIMESTAMPTZ;
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS preavis_motif TEXT;
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS fin_effective DATE;
    ALTER TABLE contrats ADD COLUMN IF NOT EXISTS cloture_at TIMESTAMPTZ;
    ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_statut_check;
    ALTER TABLE contrats ADD CONSTRAINT contrats_statut_check
      CHECK (statut IN ('brouillon','en_confirmation','en_signature','signe','annule','preavis','termine'));

    -- État des lieux : une entrée, une sortie, chacune constatée par une
    -- partie puis acceptée ou contestée par l'autre.
    CREATE TABLE IF NOT EXISTS etats_lieux (
      id SERIAL PRIMARY KEY,
      contrat_id INTEGER NOT NULL REFERENCES contrats(id),
      type TEXT NOT NULL CHECK(type IN ('entree','sortie')),
      observations TEXT,
      photos TEXT[] NOT NULL DEFAULT '{}',
      fait_par INTEGER NOT NULL REFERENCES users(id),
      statut TEXT NOT NULL DEFAULT 'en_attente' CHECK(statut IN ('en_attente','accepte','conteste')),
      valide_par INTEGER REFERENCES users(id),
      valide_at TIMESTAMPTZ,
      motif_contestation TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (contrat_id, type)
    );

    -- Restitution de la garantie : le bailleur annonce ce qu'il rend et ce
    -- qu'il retient, le locataire accepte ou conteste. IBS conserve la trace.
    CREATE TABLE IF NOT EXISTS garanties (
      id SERIAL PRIMARY KEY,
      contrat_id INTEGER NOT NULL REFERENCES contrats(id) UNIQUE,
      montant_initial REAL NOT NULL,
      montant_restitue REAL,
      motif_retenue TEXT,
      statut TEXT NOT NULL DEFAULT 'due' CHECK(statut IN ('due','proposee','acceptee','contestee')),
      declare_par INTEGER REFERENCES users(id),
      declare_at TIMESTAMPTZ,
      valide_par INTEGER REFERENCES users(id),
      valide_at TIMESTAMPTZ,
      motif_contestation TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ Fin de bail prête.");

  // ── Migration : encaissement du loyer par Mobile Money ──────────────────
  // Le compte d'encaissement appartient au bailleur, pas à IBS : les fonds sont
  // reversés directement par la passerelle sur son numéro ou son compte. IBS ne
  // les détient à aucun moment — ce que le reçu de loyer affirme depuis
  // toujours, et qui cesserait d'être vrai si la plateforme encaissait.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comptes_encaissement (
      id SERIAL PRIMARY KEY,
      bailleur_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      type TEXT NOT NULL CHECK (type IN ('mobile_money','banque')),
      operateur TEXT,
      numero TEXT NOT NULL,
      titulaire TEXT NOT NULL,
      flw_subaccount_id TEXT,
      statut TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','suspendu')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
  `);

  // Journal des tentatives de paiement. Séparé de paiements_loyer, qui ne porte
  // qu'une ligne par mois : un locataire qui abandonne puis recommence produit
  // plusieurs tentatives pour un seul mois, et l'historique des échecs a sa
  // valeur quand il faut retrouver où l'argent est passé.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS encaissements (
      id SERIAL PRIMARY KEY,
      contrat_id INTEGER NOT NULL REFERENCES contrats(id),
      mois DATE NOT NULL,
      locataire_id INTEGER NOT NULL REFERENCES users(id),
      montant_usd REAL NOT NULL,
      tx_ref TEXT NOT NULL UNIQUE,
      flw_transaction_id TEXT,
      statut TEXT NOT NULL DEFAULT 'initie' CHECK (statut IN ('initie','reussi','echoue')),
      echec_motif TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirme_at TIMESTAMPTZ
    );
  `);

  // ── Reversement au bailleur ──
  // Les passerelles congolaises (FlexPay, MaxiCash) encaissent sur le compte du
  // marchand : l'argent arrive chez IBS, puis un décaissement le porte au
  // bailleur. Ces colonnes suivent ce second temps — sans elles, un loyer
  // encaissé mais jamais reversé serait invisible.
  await pool.query(`
    ALTER TABLE encaissements ADD COLUMN IF NOT EXISTS reversement_statut TEXT
      CHECK (reversement_statut IN ('non_requis','a_reverser','reverse','echoue'));
    ALTER TABLE encaissements ADD COLUMN IF NOT EXISTS reversement_ref TEXT;
    ALTER TABLE encaissements ADD COLUMN IF NOT EXISTS reversement_at TIMESTAMPTZ;
    ALTER TABLE encaissements ADD COLUMN IF NOT EXISTS reversement_motif TEXT;
    ALTER TABLE encaissements ADD COLUMN IF NOT EXISTS reversement_tentatives INTEGER NOT NULL DEFAULT 0;
  `);

  // La référence de transaction est reportée sur le mois soldé : sans elle, un
  // reçu de paiement Mobile Money ne permettrait pas de remonter au virement.
  await pool.query(`ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS tx_ref TEXT;`);
  // Le reçu doit dire si les fonds ont transité par IBS : la phrase « IBS ne
  // détient jamais ces fonds » cesse d'être vraie en mode transit.
  await pool.query(`ALTER TABLE paiements_loyer ADD COLUMN IF NOT EXISTS encaissement_mode TEXT;`);
  console.log("✅ Encaissement Mobile Money prêt.");

  // ── Migration : dossier de candidature du locataire ────────────────────
  // Une candidature ne portait qu'un message libre. Le bailleur choisissait
  // sur une phrase, quand un locataire qui a déjà loué sur IBS traîne derrière
  // lui un carnet de loyer qui vaut mieux que n'importe quelle promesse.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS employeur TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS type_contrat TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS garant_nom TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS garant_telephone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS garant_lien TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dossier_pieces JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dossier_maj_at TIMESTAMPTZ;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_type_contrat_check;
    ALTER TABLE users ADD CONSTRAINT users_type_contrat_check
      CHECK (type_contrat IS NULL OR type_contrat IN ('cdi','cdd','independant','fonctionnaire','etudiant','autre'));
  `);

  // Le dossier est recopié sur la candidature au moment où elle part. Lire le
  // dossier vivant laisserait un locataire réécrire après coup ce sur quoi le
  // bailleur s'est prononcé — et le bailleur ne saurait plus ce qu'il a jugé.
  await pool.query(`ALTER TABLE demandes ADD COLUMN IF NOT EXISTS dossier JSONB;`);
  console.log("✅ Dossier de candidature prêt.");

  // ── Migration : vérification d'identité à chaque changement de coordonnées ──
  // Un compte vérifié gardait son badge quel que soit ce qu'on y changeait
  // ensuite : nom, téléphone, commune. Or c'est précisément là que l'identité
  // se détourne — un compte au bon historique repointé vers quelqu'un d'autre.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS portrait_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS est_professionnel BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS rccm_document_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS id_national TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS id_national_document_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS coordonnees_maj_at TIMESTAMPTZ;
  `);

  // L'administrateur qui revérifie doit savoir ce qui a changé. Sans cette
  // trace, il revoit une pièce d'identité sans pouvoir la comparer à rien.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS changements_identite (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      champs JSONB NOT NULL,
      statut TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente','verifie','rejete')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revu_par INTEGER REFERENCES users(id),
      revu_at TIMESTAMPTZ
    );
  `);
  console.log("✅ Revérification d'identité prête.");

  // ── Migration : cycle de vie des offres ────────────────────────────────
  // Une offre publiée y restait indéfiniment. Sur un marché où les biens
  // partent en quelques semaines, un catalogue qui ne périme rien finit par
  // faire perdre leur temps aux locataires — et par décrédibiliser la
  // plateforme plus sûrement qu'un catalogue vide.
  await pool.query(`
    ALTER TABLE offres DROP CONSTRAINT IF EXISTS offres_statut_check;
    ALTER TABLE offres ADD CONSTRAINT offres_statut_check
      CHECK (statut IN ('active','suspendue','louee','expiree','archivee'));
    ALTER TABLE offres ADD COLUMN IF NOT EXISTS publiee_at TIMESTAMPTZ;
    ALTER TABLE offres ADD COLUMN IF NOT EXISTS expire_le TIMESTAMPTZ;
    ALTER TABLE offres ADD COLUMN IF NOT EXISTS rappel_expiration_at TIMESTAMPTZ;
    ALTER TABLE offres ADD COLUMN IF NOT EXISTS archivee_at TIMESTAMPTZ;
  `);

  // Les offres déjà en ligne n'ont pas de date de publication : sans ce
  // rattrapage, elles seraient toutes périmées au premier passage. La durée est
  // lue dans regles.js — la recopier ici l'aurait laissée dériver au premier
  // changement, et c'est exactement ce qui s'est produit ailleurs.
  const { VALIDITE_OFFRE_JOURS } = require("./regles");
  await pool.query(`UPDATE offres SET publiee_at = created_at WHERE publiee_at IS NULL`);
  await pool.query(
    `UPDATE offres SET expire_le = publiee_at + ($1 || ' days')::interval
     WHERE expire_le IS NULL AND statut = 'active'`,
    [String(VALIDITE_OFFRE_JOURS)]
  );
  console.log("✅ Cycle de vie des offres prêt.");

  // ── Index ──────────────────────────────────────────────────────────────
  // Créés en dernier : certains portent sur des colonnes ajoutées par les
  // migrations ci-dessus. PostgreSQL indexe déjà les clés primaires et les
  // contraintes UNIQUE (users.telephone, favoris(locataire_id, offre_id)…) —
  // inutile de les redoubler. Ne restent que les colonnes sur lesquelles les
  // routes filtrent et joignent.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_agence ON users(agence_id);
    CREATE INDEX IF NOT EXISTS idx_users_cni_statut ON users(cni_statut);

    CREATE INDEX IF NOT EXISTS idx_otp_recherche ON otp_codes(telephone, contexte, id DESC);

    CREATE INDEX IF NOT EXISTS idx_proprietes_bailleur ON proprietes(bailleur_id);
    CREATE INDEX IF NOT EXISTS idx_proprietes_commune ON proprietes(commune);
    CREATE INDEX IF NOT EXISTS idx_proprietes_verif ON proprietes(statut_verification);

    CREATE INDEX IF NOT EXISTS idx_offres_propriete ON offres(propriete_id);
    CREATE INDEX IF NOT EXISTS idx_offres_statut ON offres(statut);

    CREATE INDEX IF NOT EXISTS idx_demandes_offre ON demandes(offre_id);
    CREATE INDEX IF NOT EXISTS idx_demandes_locataire ON demandes(locataire_id);

    CREATE INDEX IF NOT EXISTS idx_contrats_bailleur ON contrats(bailleur_id);
    CREATE INDEX IF NOT EXISTS idx_contrats_locataire ON contrats(locataire_id);
    CREATE INDEX IF NOT EXISTS idx_contrats_offre ON contrats(offre_id);
    CREATE INDEX IF NOT EXISTS idx_contrats_statut ON contrats(statut);
    CREATE INDEX IF NOT EXISTS idx_etats_lieux_contrat ON etats_lieux(contrat_id);
    CREATE INDEX IF NOT EXISTS idx_garanties_statut ON garanties(statut);

    CREATE INDEX IF NOT EXISTS idx_paiements_contrat ON paiements_loyer(contrat_id);
    CREATE INDEX IF NOT EXISTS idx_paiements_statut ON paiements_loyer(statut);
    CREATE INDEX IF NOT EXISTS idx_documents_contrat ON documents(contrat_id);

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, lu);
    CREATE INDEX IF NOT EXISTS idx_messages_fil ON messages(offre_id, locataire_id);
    CREATE INDEX IF NOT EXISTS idx_avis_bailleur ON avis(bailleur_id);
    CREATE INDEX IF NOT EXISTS idx_alertes_matching ON alertes(commune, actif);
    CREATE INDEX IF NOT EXISTS idx_abonnements_bailleur ON abonnements(bailleur_id);
    CREATE INDEX IF NOT EXISTS idx_mandants_intermediaire ON mandants(intermediaire_id);
    CREATE INDEX IF NOT EXISTS idx_visites_offre ON visites(offre_id);
    CREATE INDEX IF NOT EXISTS idx_visites_locataire ON visites(locataire_id);
    CREATE INDEX IF NOT EXISTS idx_signalements_statut ON signalements(statut);
    CREATE INDEX IF NOT EXISTS idx_avis_quartier_commune ON avis_quartier(commune);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON logs_audit(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_premium_bailleur ON abonnements_premium(bailleur_id);
    CREATE INDEX IF NOT EXISTS idx_encaissements_contrat ON encaissements(contrat_id, mois);
    CREATE INDEX IF NOT EXISTS idx_encaissements_statut ON encaissements(statut, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_changements_identite ON changements_identite(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_offres_expiration ON offres(statut, expire_le);
  `);
  console.log("✅ Index prêts.");

  await ensureAdmin();
}

// Crée automatiquement le compte admin au démarrage s'il n'existe pas encore.
// Évite d'avoir à lancer une commande manuelle (impossible sans accès shell en production).
async function ensureAdmin() {
  const bcrypt = require("bcryptjs");
  const existingAdmin = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existingAdmin.rows.length) {
    console.log("✅ Compte admin déjà présent.");
    return;
  }

  const telephone = process.env.ADMIN_PHONE || "+243800000000";
  const password = process.env.ADMIN_PASSWORD || "admin123";

  const conflict = await pool.query(`SELECT id, role FROM users WHERE telephone = $1`, [telephone]);
  if (conflict.rows.length) {
    console.warn(
      `⚠️  ADMIN_PHONE (${telephone}) est déjà utilisé par un compte ${conflict.rows[0].role} existant. ` +
      `Changez la variable ADMIN_PHONE sur Railway pour un numéro non utilisé, puis redéployez.`
    );
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    `INSERT INTO users (role, nom, telephone, password_hash, cni_statut, telephone_verifie)
     VALUES ('admin', 'Admin IBS', $1, $2, 'verifie', TRUE)`,
    [telephone, hash]
  );
  console.log("✅ Compte admin créé automatiquement :", telephone);
}

module.exports = { pool, query, migrate };

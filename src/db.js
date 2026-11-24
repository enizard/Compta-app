const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const ENTITES = ['SCI E NIZARD', 'BMG', 'LMF', 'Simple and New'];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      nom TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS entites (
      id SERIAL PRIMARY KEY,
      nom TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      nom TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id SERIAL PRIMARY KEY,
      entite_id INTEGER NOT NULL REFERENCES entites(id),
      date_op DATE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('recette','depense')),
      categorie_id INTEGER REFERENCES categories(id),
      libelle TEXT NOT NULL,
      tiers TEXT,
      montant_ttc NUMERIC(12,2) NOT NULL,
      tva NUMERIC(12,2) NOT NULL DEFAULT 0,
      notes TEXT,
      justif_nom TEXT,
      justif_type TEXT,
      justif_data BYTEA,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ops_entite_date ON operations(entite_id, date_op);
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS paiement TEXT;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS carte TEXT;
    CREATE TABLE IF NOT EXISTS lots (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      statut TEXT NOT NULL DEFAULT 'en_cours',
      total_pages INTEGER,
      pages_traitees INTEGER NOT NULL DEFAULT 0,
      erreur TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS depots (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      data BYTEA NOT NULL,
      resultat JSONB,
      erreur TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE depots ADD COLUMN IF NOT EXISTS lot_id INTEGER REFERENCES lots(id) ON DELETE CASCADE;
    ALTER TABLE depots ADD COLUMN IF NOT EXISTS page INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE depots ADD COLUMN IF NOT EXISTS ordre INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE depots ADD COLUMN IF NOT EXISTS statut TEXT NOT NULL DEFAULT 'a_valider';
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS nature TEXT;
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS hash TEXT;
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS data BYTEA;
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS mimetype TEXT;
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE lots ADD COLUMN IF NOT EXISTS info TEXT;
    ALTER TABLE depots ADD COLUMN IF NOT EXISTS operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS emails_recus (
      id SERIAL PRIMARY KEY,
      message_id TEXT UNIQUE NOT NULL,
      de TEXT,
      sujet TEXT,
      recu_le TIMESTAMPTZ,
      statut TEXT NOT NULL,
      nb_pj INTEGER NOT NULL DEFAULT 0,
      lot_ids INTEGER[] NOT NULL DEFAULT '{}',
      info JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lots_hash ON lots(hash);
    CREATE TABLE IF NOT EXISTS comptes (
      id SERIAL PRIMARY KEY,
      banque TEXT NOT NULL,
      nature TEXT NOT NULL CHECK (nature IN ('compte','carte')),
      numero TEXT,
      entite_id INTEGER REFERENCES entites(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS releves (
      id SERIAL PRIMARY KEY,
      lot_id INTEGER REFERENCES lots(id) ON DELETE SET NULL,
      compte_id INTEGER NOT NULL REFERENCES comptes(id),
      nom TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      data BYTEA NOT NULL,
      periode_debut DATE,
      periode_fin DATE,
      solde_debut NUMERIC(12,2),
      solde_fin NUMERIC(12,2),
      nb_doublons INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS lignes (
      id SERIAL PRIMARY KEY,
      releve_id INTEGER NOT NULL REFERENCES releves(id) ON DELETE CASCADE,
      compte_id INTEGER NOT NULL REFERENCES comptes(id),
      page INTEGER,
      date_op DATE NOT NULL,
      libelle TEXT NOT NULL,
      montant NUMERIC(12,2) NOT NULL,
      categorie TEXT,
      total_carte TEXT,
      operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL,
      releve_carte_id INTEGER REFERENCES releves(id) ON DELETE SET NULL,
      ignoree BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_lignes_compte ON lignes(compte_id, date_op);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lignes_operation ON lignes(operation_id) WHERE operation_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS fournisseurs (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      cle TEXT UNIQUE NOT NULL,
      type TEXT CHECK (type IN ('recurrent','ponctuel')),
      en_ligne BOOLEAN,
      url TEXT,
      recuperation TEXT,
      note TEXT,
      classe_le TIMESTAMPTZ,
      modifie_main BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE lignes ADD COLUMN IF NOT EXISTS fournisseur_id INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL;
    ALTER TABLE lignes ADD COLUMN IF NOT EXISTS fournisseur_vu BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE operations ALTER COLUMN entite_id DROP NOT NULL;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS livraison TEXT;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS reglement TEXT;
    ALTER TABLE lignes ADD COLUMN IF NOT EXISTS ecart_accepte BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS fournisseur_id INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS reglements (
      id SERIAL PRIMARY KEY,
      operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      date_reg DATE,
      montant NUMERIC(12,2) NOT NULL,
      paiement TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reglements_op ON reglements(operation_id);
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);

  // Un lot interrompu par un redémarrage du serveur est marqué en erreur.
  await pool.query("UPDATE lots SET statut='interrompu' WHERE statut='en_cours'");
  // Ménage : lots entièrement traités depuis plus de 7 jours.
  await pool.query(`DELETE FROM depots d USING lots l WHERE d.lot_id = l.id AND l.created_at < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (SELECT 1 FROM depots d2 WHERE d2.lot_id = l.id AND d2.statut = 'a_valider')`);
  await pool.query("DELETE FROM depots WHERE lot_id IS NULL");
  await pool.query("UPDATE operations SET paiement='Virement / prélèvement CIC' WHERE paiement='Virement / prélèvement'");
  await pool.query("UPDATE operations SET reglement = CASE reglement WHEN 'Non réglé' THEN 'À régler' WHEN 'Réglé en totalité' THEN 'Déjà réglé' ELSE reglement END WHERE reglement IN ('Non réglé','Réglé en totalité')");
  for (const nom of ENTITES) {
    await pool.query('INSERT INTO entites (nom) VALUES ($1) ON CONFLICT DO NOTHING', [nom]);
  }

  const cats = ['Ventes / honoraires', 'Loyers perçus', 'Achats', 'Sous-traitance', 'Loyers & charges',
    'Honoraires (comptable, avocat…)', 'Assurances', 'Banque & frais', 'Télécom & logiciels',
    'Déplacements', 'Impôts & taxes', 'Salaires & charges sociales', 'Travaux & entretien', 'Divers'];
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
  if (rows[0].n === 0) {
    for (const nom of cats) {
      await pool.query('INSERT INTO categories (nom) VALUES ($1) ON CONFLICT DO NOTHING', [nom]);
    }
  }
}

module.exports = { pool, init };

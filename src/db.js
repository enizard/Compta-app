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
  await pool.query(`DELETE FROM lots l WHERE l.created_at < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (SELECT 1 FROM depots d WHERE d.lot_id = l.id AND d.statut = 'a_valider')`);
  await pool.query("DELETE FROM depots WHERE lot_id IS NULL");
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

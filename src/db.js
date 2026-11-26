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
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS montant_debite NUMERIC(12,2);
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS numero_facture TEXT;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS date_paiement DATE;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS recu_nom TEXT;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS recu_type TEXT;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS recu_data BYTEA;
    CREATE TABLE IF NOT EXISTS cartes (
      numero TEXT PRIMARY KEY,
      paiement TEXT NOT NULL,
      appris_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE lignes ADD COLUMN IF NOT EXISTS ecart_accepte BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS automatise BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS ecriture_auto BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS recup_annuelle BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS justif_attendu BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS mode TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS debut_exercice INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_prefixe TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_prochain INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_tva_intra TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_mention_tva TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_banque TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_conditions TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_penalites TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS facture_pied TEXT;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS logo BYTEA;
    ALTER TABLE entites ADD COLUMN IF NOT EXISTS logo_type TEXT;
    CREATE TABLE IF NOT EXISTS factures_vente (
      id SERIAL PRIMARY KEY,
      entite_id INTEGER NOT NULL REFERENCES entites(id),
      numero TEXT,
      date DATE,
      client_nom TEXT,
      client_adresse TEXT,
      client_tva TEXT,
      bon_commande TEXT,
      lignes JSONB NOT NULL DEFAULT '[]',
      frais JSONB NOT NULL DEFAULT '[]',
      taux_tva NUMERIC(5,2) NOT NULL DEFAULT 20,
      acompte NUMERIC(12,2) NOT NULL DEFAULT 0,
      conditions TEXT,
      statut TEXT NOT NULL DEFAULT 'brouillon',
      operation_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      emise_le TIMESTAMPTZ,
      UNIQUE (entite_id, numero)
    );
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS facture_vente_id INTEGER;
    ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS encaissement_auto BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS fournisseur_id INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS reglements (
      id SERIAL PRIMARY KEY,
      operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      date_reg DATE,
      montant NUMERIC(12,2) NOT NULL,
      paiement TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reglements_op ON reglements(operation_id);
    CREATE TABLE IF NOT EXISTS moyens_entite (
      entite_id INTEGER NOT NULL REFERENCES entites(id) ON DELETE CASCADE,
      paiement TEXT NOT NULL,
      actif BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (entite_id, paiement)
    );
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
  await pool.query("UPDATE operations SET reglement = CASE reglement WHEN 'À régler' THEN 'Non réglé' WHEN 'Déjà réglé' THEN 'Réglé' WHEN 'Réglé en totalité' THEN 'Réglé' ELSE reglement END WHERE reglement IN ('À régler','Déjà réglé','Réglé en totalité')");
  await pool.query(`UPDATE emails_recus SET statut='pas_facture'
    WHERE statut IN ('en_cours','traite') AND (de ILIKE '%@accounts.google.com>%' OR de ILIKE '%mail-noreply@google.com>%')`);
  // Mode de récupération déduit des réglages existants (une seule fois).
  // Simple and New : exercice du 1er octobre au 30 septembre (les autres : année civile).
  await pool.query('CREATE TABLE IF NOT EXISTS app_config (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)');
  if (!(await pool.query("SELECT 1 FROM app_config WHERE cle='exercice_san'")).rows[0]) {
    await pool.query("UPDATE entites SET debut_exercice = 10 WHERE nom = 'Simple and New'");
    await pool.query("INSERT INTO app_config (cle, valeur) VALUES ('exercice_san', '1') ON CONFLICT DO NOTHING");
  }
  // Modèle de facture de vente de Simple and New (d'après les factures F120 à F128) ; numérotation reprise à F129.
  if (!(await pool.query("SELECT 1 FROM app_config WHERE cle='factures_san'")).rows[0]) {
    const fs = require('fs'), path = require('path');
    const logo = fs.readFileSync(path.join(__dirname, 'public', 'logos', 'simple-and-new.png'));
    await pool.query(`UPDATE entites SET facture_prefixe = 'F', facture_prochain = 129,
        facture_tva_intra = 'FR 79 539377705', facture_mention_tva = 'TVA collectée sur les encaissements',
        facture_banque = $1, facture_conditions = '30 jours date de facture', facture_penalites = $2, facture_pied = $3,
        logo = $4, logo_type = 'image/png'
      WHERE nom = 'Simple and New'`,
      ['CIC - Paris Les Ternes\n(FR 76) 30066 – 10181 – 00020140901 - 80',
        "En cas de retard de paiement, les pénalités seront calculées sur la base de 1,5 fois et demi le taux d'intérêt légal, par jour de retard.\nEn outre, une pénalité forfaitaire de 40 euros sera due au titre des frais de recouvrement.",
        'SIMPLE AND NEW - SAS au capital de 10 000 euros - 539 377 705 RCS NANTERRE\nSIRET : 539 377 705 00022; N°TVA intracommunautaire : FR79539377705\n16 rue Tony Garnier – 92100 Boulogne-Billancourt\nIBAN : FR76 3006 6101 8100 0201 4090 180',
        logo]);
    await pool.query(`UPDATE entites SET facture_prefixe = COALESCE(facture_prefixe, CASE nom WHEN 'SCI E NIZARD' THEN 'SCI-' ELSE nom || '-' END)
      WHERE nom <> 'Simple and New'`);
    await pool.query("INSERT INTO app_config (cle, valeur) VALUES ('factures_san', '1') ON CONFLICT DO NOTHING");
  }
  // Virements Stripe reçus : comptés en revenus automatiquement.
  await pool.query(`UPDATE fournisseurs SET encaissement_auto = TRUE WHERE cle ~ '(^| )stripe( |$)' AND NOT encaissement_auto`);
  // « Sans facture » fusionné dans « Rien à faire ».
  await pool.query(`UPDATE fournisseurs SET mode = 'rien' WHERE mode = 'auto'`);
  await pool.query(`UPDATE fournisseurs SET mode = CASE WHEN ecriture_auto THEN 'rien' WHEN recup_annuelle THEN 'session'
    WHEN automatise THEN 'email' END WHERE mode IS NULL AND (ecriture_auto OR recup_annuelle OR automatise)`);
  // Organismes sans facture : leurs prélèvements deviennent des écritures automatiques.
  await pool.query(`UPDATE fournisseurs SET ecriture_auto = TRUE, mode = COALESCE(mode, 'rien')
    WHERE NOT ecriture_auto AND NOT modifie_main AND cle ~ '(^| )(urssaf|dgfip|sie|impots|tresor public)( |$)'`);
  for (const nom of ENTITES) {
    await pool.query('INSERT INTO entites (nom) VALUES ($1) ON CONFLICT DO NOTHING', [nom]);
  }
  // Moyens de paiement par société (modifiables dans Administration). AMEX : Simple and New uniquement par défaut.
  await pool.query(`INSERT INTO moyens_entite (entite_id, paiement, actif)
    SELECT e.id, p.p, NOT (p.p = 'AMEX' AND e.nom <> 'Simple and New')
    FROM entites e CROSS JOIN unnest($1::text[]) AS p(p)
    ON CONFLICT DO NOTHING`, [['CB CIC', 'AMEX', 'Avance CC', 'Virement / prélèvement CIC', 'Autre']]);

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

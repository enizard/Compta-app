const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const { pool, init } = require('./db');
const LIVRAISONS = ['Non livré', 'Partiellement livré', 'Livré en totalité'];
const REGLEMENTS = ['Réglé', 'Partiellement réglé', 'Non réglé'];
const { analyser, classer, extraireLignes, decouperPdf, PAIEMENTS } = require('./analyse');
const releves = require('./releves');
const fournisseurs = require('./fournisseurs');
const boite = require('./boite');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));

async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  await pool.query('CREATE TABLE IF NOT EXISTS app_config (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)');
  await pool.query('INSERT INTO app_config (cle, valeur) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    ['session_secret', crypto.randomBytes(48).toString('hex')]);
  const { rows } = await pool.query("SELECT valeur FROM app_config WHERE cle = 'session_secret'");
  return rows[0].valeur;
}

function setupSession(secret) {
  app.use(session({
    store: new PgStore({ pool, tableName: 'session' }),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 7 },
  }));
}

function registerRoutes() {
// ---------- helpers ----------
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toNum = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  return Number(String(v).replace(/\s/g, '').replace(',', '.'));
};

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.fmt = fmt;
  res.locals.PAIEMENTS = PAIEMENTS;
  res.locals.libPaiement = libPaiement;
  res.locals.LIVRAISONS = LIVRAISONS;
  res.locals.REGLEMENTS = REGLEMENTS;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// Libellé d'un moyen de paiement selon la société : « CB CIC LMF », « Virement / prélèvement CIC LMF »…
const COURT = { 'Simple and New': 'SAN', 'SCI E NIZARD': 'SCI' };
function libPaiement(p, entite) {
  if (!p) return '';
  if (!entite || ['Avance CC', 'Autre'].includes(p)) return p;
  return `${p} ${COURT[entite] || entite}`;
}
async function moyensParEntite() {
  const { rows } = await pool.query('SELECT entite_id, paiement FROM moyens_entite WHERE actif');
  const m = {};
  for (const r of rows) (m[r.entite_id] = m[r.entite_id] || []).push(r.paiement);
  return m;
}

function flash(req, msg, type = 'ok') { req.session.flash = { msg, type }; }

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Accès réservé aux administrateurs');
  next();
}

async function countUsers() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n;
}

async function refs() {
  const [e, c] = await Promise.all([
    pool.query('SELECT * FROM entites ORDER BY nom'),
    pool.query('SELECT * FROM categories ORDER BY nom'),
  ]);
  return { entites: e.rows, categories: c.rows, moyens: await moyensParEntite() };
}

function buildFilters(q) {
  const where = [];
  const params = [];
  if (q.entite === 'inconnue') where.push('o.entite_id IS NULL');
  else if (q.entite) { params.push(Number(q.entite)); where.push(`o.entite_id = $${params.length}`); }
  if (q.annee) { params.push(Number(q.annee)); where.push(`EXTRACT(YEAR FROM o.date_op) = $${params.length}`); }
  if (q.mois) { params.push(Number(q.mois)); where.push(`EXTRACT(MONTH FROM o.date_op) = $${params.length}`); }
  if (q.type === 'recette' || q.type === 'depense') { params.push(q.type); where.push(`o.type = $${params.length}`); }
  if (q.categorie) { params.push(Number(q.categorie)); where.push(`o.categorie_id = $${params.length}`); }
  if (q.q) { params.push(`%${q.q}%`); where.push(`(o.libelle ILIKE $${params.length} OR o.tiers ILIKE $${params.length} OR o.numero_facture ILIKE $${params.length})`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const OPS_SELECT = `
  SELECT o.id, o.date_op, o.type, o.libelle, o.tiers, o.montant_ttc, o.tva, o.notes,
         o.justif_nom, o.entite_id, o.categorie_id, o.paiement, o.carte, o.livraison, o.reglement, o.montant_debite, o.numero_facture, to_char(o.date_paiement, 'YYYY-MM-DD') AS date_paiement, o.recu_nom,
         e.nom AS entite, c.nom AS categorie, u.nom AS auteur,
         EXISTS (SELECT 1 FROM lignes x WHERE x.operation_id = o.id) AS rapprochee
  FROM operations o
  LEFT JOIN entites e ON e.id = o.entite_id
  LEFT JOIN categories c ON c.id = o.categorie_id
  LEFT JOIN users u ON u.id = o.created_by`;

// ---------- setup & auth ----------
app.get('/setup', async (req, res) => {
  if (await countUsers() > 0) return res.redirect('/login');
  res.render('setup', { error: null });
});

app.post('/setup', async (req, res) => {
  if (await countUsers() > 0) return res.redirect('/login');
  const { nom, email, password } = req.body;
  if (!nom || !email || !password || password.length < 8) {
    return res.render('setup', { error: 'Tous les champs sont requis (mot de passe : 8 caractères minimum).' });
  }
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    'INSERT INTO users (nom, email, password_hash, is_admin) VALUES ($1, lower($2), $3, TRUE) RETURNING id, nom, email, is_admin',
    [nom, email, hash]);
  req.session.user = rows[0];
  res.redirect('/');
});

app.get('/login', async (req, res) => {
  if (await countUsers() === 0) return res.redirect('/setup');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = lower($1)', [email || '']);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) {
    return res.render('login', { error: 'Email ou mot de passe incorrect.' });
  }
  req.session.regenerate(() => {
    req.session.user = { id: u.id, nom: u.nom, email: u.email, is_admin: u.is_admin };
    res.redirect('/');
  });
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------- opérations ----------
app.get('/', requireAuth, (req, res) => res.redirect('/operations'));

// Relevé : on extrait les lignes page par page (dans l'ordre, pour suivre les sections),
// on range le détail de carte d'un extrait de compte dans le compte « carte », puis on rapproche.
async function traiterReleve(lotId, fichier, pages, info, cats, userId) {
  const { entites } = await refs();
  const ent = entites.find((e) => e.nom === info.societe_nom);
  const entiteId = ent ? ent.id : null;
  const compteId = await releves.trouverCompte(info, entiteId);
  const { rows: cpt } = await pool.query('SELECT nature FROM comptes WHERE id=$1', [compteId]);
  const estCarte = cpt[0].nature === 'carte';
  const nouveauReleve = async (cId, periode) => (await pool.query(
    `INSERT INTO releves (lot_id, compte_id, nom, mimetype, data, periode_debut, periode_fin, solde_debut, solde_fin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [lotId, cId, fichier.originalname, fichier.mimetype, fichier.buffer,
      periode ? info.periode_debut || null : null, periode ? info.periode_fin || null : null,
      periode ? info.solde_debut ?? null : null, periode ? info.solde_fin ?? null : null])).rows[0].id;
  const releveId = await nouveauReleve(compteId, true);
  const relevesCarte = {}; // n° de carte → { releveId, compteId }

  const erreurs = [];
  let ctx = { ...info, sectionPrecedente: estCarte ? 'carte' : 'compte', carteNumero: null };
  for (const p of pages) {
    try {
      const { lignes, finSection } = await extraireLignes(p.buf, p.type, ctx, cats);
      const duCompte = [];
      const parCarte = {};
      for (const l of lignes) {
        if (estCarte || l.section !== 'carte') { duCompte.push(l); continue; }
        const num = l.carte_numero || ctx.carteNumero || 'carte';
        (parCarte[num] = parCarte[num] || []).push(l);
        ctx.carteNumero = l.carte_numero || ctx.carteNumero;
      }
      await releves.insererLignes(releveId, compteId, p.page, duCompte);
      for (const [num, ls] of Object.entries(parCarte)) {
        if (!relevesCarte[num]) {
          const cId = await releves.trouverCompte(
            { banque: info.banque === 'AMEX' ? 'AMEX' : 'CIC', nature: 'releve_carte', numero: num === 'carte' ? null : num }, entiteId);
          relevesCarte[num] = { compteId: cId, releveId: await nouveauReleve(cId, false) };
        }
        await releves.insererLignes(relevesCarte[num].releveId, relevesCarte[num].compteId, p.page, ls);
      }
      ctx = { ...ctx, sectionPrecedente: finSection };
    } catch (e) {
      console.error(`Relevé ${releveId} page ${p.page} :`, e.message);
      erreurs.push(`page ${p.page}`);
    }
    await pool.query('UPDATE lots SET pages_traitees = pages_traitees + 1 WHERE id=$1', [lotId]);
  }
  // Période des détails de carte = dates extrêmes de leurs lignes.
  for (const { releveId: rId } of Object.values(relevesCarte)) {
    await pool.query(`UPDATE releves r SET periode_debut = x.d1, periode_fin = x.d2
      FROM (SELECT MIN(date_op) d1, MAX(date_op) d2 FROM lignes WHERE releve_id = $1) x WHERE r.id = $1`, [rId]);
  }
  await releves.rapprocher();
  await pool.query("UPDATE lots SET statut='termine', erreur=$1 WHERE id=$2",
    [erreurs.length ? `Lecture impossible : ${erreurs.join(', ')}` : null, lotId]);
  fournisseurs.mettreAJour(); // en arrière-plan
}

// Traitement en arrière-plan d'un lot (évite la limite de 30 s des requêtes Heroku).
async function traiterLot(lotId, fichier, userId) {
  try {
    const { categories } = await refs();
    const cats = categories.map((c) => c.nom);
    let pages;
    if (fichier.mimetype === 'application/pdf') {
      pages = (await decouperPdf(fichier.buffer)).map((buf, i) => ({ buf, type: 'application/pdf', page: i + 1 }));
    } else {
      pages = [{ buf: fichier.buffer, type: fichier.mimetype, page: 1 }];
    }
    await pool.query('UPDATE lots SET total_pages=$1 WHERE id=$2', [pages.length, lotId]);

    // Relevé bancaire / de carte, ou tickets ? On regarde la première page.
    let info = { nature: 'tickets' };
    if (process.env.ANTHROPIC_API_KEY) {
      try { info = await classer(pages[0].buf, pages[0].type); } catch (e) { console.error(`Lot ${lotId} classement :`, e.message); }
    }
    await pool.query('UPDATE lots SET nature=$1 WHERE id=$2', [info.nature, lotId]);
    if (info.nature !== 'tickets') return await traiterReleve(lotId, fichier, pages, info, cats, userId);

    const base = fichier.originalname.replace(/\.[^.]+$/, '');
    const ext = fichier.mimetype === 'application/pdf' ? '.pdf' : (fichier.originalname.match(/\.[^.]+$/) || ['.jpg'])[0];
    let suivant = 0;
    async function travailleur() {
      while (suivant < pages.length) {
        const p = pages[suivant++];
        const nom = pages.length > 1 ? `${base} - page ${p.page}${ext}` : fichier.originalname;
        try {
          const docs = process.env.ANTHROPIC_API_KEY ? await analyser(p.buf, p.type, cats) : [{}];
          for (let k = 0; k < docs.length; k++) {
            await pool.query(
              `INSERT INTO depots (lot_id, page, ordre, nom, mimetype, data, resultat, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [lotId, p.page, k, nom, p.type, p.buf, docs[k], userId]);
          }
        } catch (e) {
          console.error(`Lot ${lotId} page ${p.page} :`, e.message);
          await pool.query(
            `INSERT INTO depots (lot_id, page, ordre, nom, mimetype, data, erreur, created_by)
             VALUES ($1,$2,0,$3,$4,$5,$6,$7)`, [lotId, p.page, nom, p.type, p.buf, e.message, userId]);
        }
        await pool.query('UPDATE lots SET pages_traitees = pages_traitees + 1 WHERE id=$1', [lotId]);
      }
    }
    await Promise.all([travailleur(), travailleur(), travailleur()]);
    await pool.query("UPDATE lots SET statut='termine' WHERE id=$1", [lotId]);
  } catch (e) {
    console.error(`Lot ${lotId} échoué :`, e);
    await pool.query("UPDATE lots SET statut='erreur', erreur=$1 WHERE id=$2", [e.message, lotId]);
  }
}

// File d'attente : les fichiers déposés sont traités l'un après l'autre en arrière-plan.
let fileAttente = Promise.resolve();
function mettreEnFile(lotId, f, userId) {
  fileAttente = fileAttente.then(() => traiterLot(lotId, f, userId)).catch((e) => console.error('File :', e))
    .then(() => creerOperationsAuto(lotId)).catch((e) => console.error('Auto :', e))
    .then(() => pool.query('UPDATE lots SET data=NULL WHERE id=$1', [lotId]).catch(() => {}));
}

// Factures reçues par e-mail : l'opération est créée sans validation. Société et paiement inconnus
// sont déterminés au rapprochement bancaire. Les doublons probables restent à valider.
// ---------- reçus de paiement ----------
// Facture déjà saisie que ce reçu règle : même n° de facture, sinon même fournisseur + montant + date proche.
async function factureDuRecu(r) {
  if (r.numero_facture) {
    const { rows } = await pool.query(
      "SELECT id FROM operations WHERE regexp_replace(lower(numero_facture), '[^a-z0-9]', '', 'g') = regexp_replace(lower($1), '[^a-z0-9]', '', 'g') ORDER BY id DESC LIMIT 1",
      [r.numero_facture]);
    if (rows[0]) return rows[0].id;
  }
  const paye = r.montant_paye || r.montant_ttc;
  if (!paye) return null;
  const { rows } = await pool.query(`
    SELECT o.id, o.tiers, f.cle FROM operations o LEFT JOIN fournisseurs f ON f.id = o.fournisseur_id
    WHERE o.type = 'depense' AND o.recu_nom IS NULL
      AND (ABS(o.montant_ttc - $1) < 0.01 OR ABS(COALESCE(o.montant_debite, -1) - $1) < 0.01 OR ABS(o.montant_ttc - $2) < 0.01)
      AND ($3::date IS NULL OR ABS(o.date_op - $3::date) <= 60)
    ORDER BY ABS(o.date_op - COALESCE($3::date, o.date_op)), o.id DESC`, [paye, r.montant_ttc || paye, r.date || null]);
  const k = fournisseurs.cle(r.fournisseur || '');
  const memes = rows.filter((o) => k && (o.cle === k || fournisseurs.cle(o.tiers || '') === k));
  return memes.length ? memes[0].id : null;
}

// Rattache un reçu à sa facture : date et moyen de paiement, carte, montant débité, reçu joint.
async function rattacherRecu(opId, r, fichier) {
  const paye = r.montant_paye || r.montant_ttc;
  await pool.query(`UPDATE operations SET
      date_paiement = COALESCE($1::date, date_paiement),
      paiement = COALESCE($2, paiement), carte = COALESCE($3, carte),
      montant_debite = CASE WHEN $4::numeric IS NOT NULL AND ABS(montant_ttc - $4::numeric) > 0.01 THEN $4::numeric ELSE montant_debite END,
      reglement = COALESCE(reglement, 'Réglé'),
      recu_nom = COALESCE($5, recu_nom), recu_type = COALESCE($6, recu_type), recu_data = COALESCE($7, recu_data),
      updated_at = NOW()
    WHERE id = $8`,
  [r.date || null, await releves.paiementDepuisDocument(r), r.carte || null, paye || null,
    fichier ? fichier.nom : null, fichier ? fichier.mimetype : null, fichier ? fichier.data : null, opId]);
  await releves.rapprocher();
}

async function creerOperationsAuto(lotId) {
  const { rows: l } = await pool.query('SELECT auto, info, created_by FROM lots WHERE id=$1', [lotId]);
  if (!l[0] || !l[0].auto) return;
  const { entites, categories } = await refs();
  const { rows: deps } = await pool.query(
    "SELECT id, nom, mimetype, data, resultat FROM depots WHERE lot_id=$1 AND statut='a_valider' AND erreur IS NULL ORDER BY page, ordre", [lotId]);
  let crees = 0;
  // Autres documents du même e-mail (facture + reçu d'un même paiement).
  const { rows: frere } = await pool.query(
    `SELECT d.id, d.statut, d.operation_id, d.resultat FROM depots d JOIN emails_recus m ON d.lot_id = ANY(m.lot_ids)
     WHERE $1 = ANY(m.lot_ids) AND d.lot_id <> $1`, [lotId]);
  const memeFourn = (a, b) => fournisseurs.cle(a.fournisseur || '') === fournisseurs.cle(b.fournisseur || '')
    || (a.numero_facture && a.numero_facture === b.numero_facture);
  for (const d of deps) {
    const r = d.resultat || {};
    if (!r.montant_ttc || !r.date) continue;
    // Un reçu accompagné de sa facture dans le même e-mail : on ne garde que la facture.
    const facture = r.type_document === 'recu' && frere.find((f) => f.resultat && f.resultat.type_document === 'facture' && memeFourn(f.resultat, r));
    if (facture) {
      await pool.query("UPDATE depots SET statut='ignore' WHERE id=$1", [d.id]);
      // Montant réellement débité (après crédit) : utile au rapprochement bancaire.
      const paye = r.montant_paye || r.montant_ttc;
      if (facture.operation_id && paye) {
        await pool.query('UPDATE operations SET montant_debite=$1 WHERE id=$2 AND ABS(montant_ttc - $1) > 0.01', [paye, facture.operation_id]);
      }
      // Le moyen et la date de paiement ne sont souvent indiqués que sur le reçu : on les reporte sur la facture.
      if (facture.operation_id) await rattacherRecu(facture.operation_id, r, { nom: d.nom, mimetype: d.mimetype, data: d.data });
      continue;
    }
    // Opération créée en attente du justificatif (session annuelle) : on la complète au lieu d'en créer une autre.
    const attendu = await releves.completerAttendu(r, { nom: d.nom, mimetype: d.mimetype, data: d.data });
    if (attendu) {
      await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [d.id, attendu]);
      crees++;
      continue;
    }
    const preuvePaiement = r.type_document === 'recu' || r.type_document === 'facturette';
    // Deuxième reçu identique dans le même e-mail : ignoré.
    if (preuvePaiement && frere.some((f) => f.operation_id && f.resultat && ['recu', 'facturette'].includes(f.resultat.type_document) && memeFourn(f.resultat, r))) {
      await pool.query("UPDATE depots SET statut='ignore' WHERE id=$1", [d.id]);
      continue;
    }
    if (preuvePaiement) {
      const opFact = await factureDuRecu(r);
      if (opFact) {
        await rattacherRecu(opFact, r, { nom: d.nom, mimetype: d.mimetype, data: d.data });
        await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [d.id, opFact]);
        crees++;
        continue;
      }
    }
    if (r.type_document === 'facture') {
      const recu = frere.find((f) => f.operation_id && f.resultat && f.resultat.type_document === 'recu' && memeFourn(f.resultat, r));
      if (recu) {
        // Le reçu a été enregistré avant la facture : l'opération reprend les données et le justificatif de la facture.
        await pool.query(`UPDATE operations SET montant_debite = CASE WHEN ABS(montant_ttc - $1) > 0.01 THEN montant_ttc ELSE montant_debite END,
          montant_ttc=$1, tva=$2, date_op=$3, justif_nom=$4, justif_type=$5, justif_data=$6, updated_at=NOW()
          WHERE id=$7`, [r.montant_ttc, r.tva || 0, r.date, d.nom, d.mimetype, d.data, recu.operation_id]);
        await pool.query("UPDATE depots SET statut='ignore', operation_id=NULL WHERE id=$1", [recu.id]);
        await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [d.id, recu.operation_id]);
        crees++;
        continue;
      }
    }
    const { rows: dbl } = await pool.query(`
      SELECT EXISTS (SELECT 1 FROM depots d2 JOIN emails_recus m ON d2.lot_id = ANY(m.lot_ids) AND $3 = ANY(m.lot_ids)
                     WHERE d2.operation_id = o.id) AS meme_email
      FROM operations o WHERE o.montant_ttc=$1 AND o.date_op=$2 LIMIT 1`, [r.montant_ttc, r.date, lotId]);
    if (dbl[0]) {
      // Facture + reçu du même paiement dans le même e-mail : le second document est simplement ignoré.
      if (dbl[0].meme_email) await pool.query("UPDATE depots SET statut='ignore' WHERE id=$1", [d.id]);
      continue;
    }
    // Facture de vente déjà enregistrée (même société, même numéro, autre version du document) : reste à valider.
    if (r.sens === 'vente' && r.numero_facture) {
      const { rows: memeNum } = await pool.query(`SELECT 1 FROM operations o JOIN entites e ON e.id = o.entite_id
        WHERE o.type = 'recette' AND e.nom = $1 AND lower(o.numero_facture) = lower($2) LIMIT 1`, [r.societe_nom, r.numero_facture]);
      if (memeNum[0]) continue;
    }
    const ent = entites.find((e) => e.nom === r.societe_nom);
    // Facture de vente émise par l'une de nos sociétés : recette « Ventes / honoraires », non réglée jusqu'au rapprochement.
    const vente = r.sens === 'vente';
    const cat = categories.find((c) => c.nom === (vente && !/ventes|loyers per/i.test(r.categorie || '') ? 'Ventes / honoraires' : r.categorie));
    const { rows: ins } = await pool.query(
      `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes, paiement, carte,
         justif_nom, justif_type, justif_data, created_by, montant_debite, numero_facture, date_paiement, reglement)
       VALUES ($1,$2,$18,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$19) RETURNING id`,
      [ent ? ent.id : null, r.date, cat ? cat.id : null, r.libelle || `Facture ${r.fournisseur || ''}`.trim(), r.fournisseur || null,
        r.montant_ttc, r.tva || 0,
        l[0].info + (r.montant_paye && Math.abs(r.montant_paye - r.montant_ttc) > 0.01 ? ` — montant débité : ${r.montant_paye} € (crédit ou avoir appliqué)` : ''),
        await releves.paiementDepuisDocument(r), r.carte || null,
        d.nom, d.mimetype, d.data, l[0].created_by,
        r.montant_paye && Math.abs(r.montant_paye - r.montant_ttc) > 0.01 ? r.montant_paye : null,
        r.numero_facture || null, ['recu', 'facturette'].includes(r.type_document) ? r.date : null,
        vente ? 'recette' : 'depense', vente ? 'Non réglé' : null]);
    if (!vente) await fournisseurs.lierOperation(ins[0].id, r.fournisseur);
    await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [d.id, ins[0].id]);
    crees++;
  }
  if (crees) {
    await releves.rapprocher();
    fournisseurs.mettreAJour();
  }
  // Fournisseurs dont les factures arrivent par e-mail : marqués « Automatisé ».
  await pool.query(`UPDATE fournisseurs f SET automatise = TRUE
    FROM depots d JOIN operations o ON o.id = d.operation_id
    WHERE d.lot_id = $1 AND o.fournisseur_id = f.id AND NOT f.automatise`, [lotId]);
  // Statut de l'e-mail d'origine, sur l'ensemble de ses pièces jointes.
  await pool.query(`UPDATE emails_recus m SET statut = CASE
      WHEN EXISTS (SELECT 1 FROM lots l WHERE l.id = ANY(m.lot_ids) AND l.statut = 'en_cours') THEN 'en_cours'
      WHEN EXISTS (SELECT 1 FROM depots d WHERE d.lot_id = ANY(m.lot_ids) AND d.statut = 'a_valider') THEN 'a_valider'
      WHEN EXISTS (SELECT 1 FROM depots d WHERE d.lot_id = ANY(m.lot_ids) AND d.statut = 'enregistre') THEN 'traite'
      ELSE 'pas_facture' END
    WHERE $1 = ANY(m.lot_ids) AND m.statut IN ('en_cours','a_valider','traite','pas_facture')`, [lotId]);
}

app.post('/depot', requireAuth, upload.array('fichier', 50), async (req, res) => {
  const fichiers = req.files || [];
  if (!fichiers.length) { flash(req, 'Aucun fichier reçu.', 'err'); return res.redirect('/operations'); }
  const refuses = fichiers.filter((f) => !/^image\/|^application\/pdf$/.test(f.mimetype));
  const ids = [];
  const dejaMis = [];
  const vus = new Set();
  for (const f of fichiers.filter((x) => !refuses.includes(x))) {
    const hash = crypto.createHash('sha256').update(f.buffer).digest('hex');
    if (vus.has(hash)) { dejaMis.push(`${f.originalname} (en double dans ce dépôt)`); continue; }
    vus.add(hash);
    const { rows: ex } = await pool.query(`
      SELECT l.id, l.nom, l.created_at, l.statut,
        EXISTS (SELECT 1 FROM depots d WHERE d.lot_id = l.id AND d.statut = 'enregistre')
          OR EXISTS (SELECT 1 FROM releves r WHERE r.lot_id = l.id) AS enregistre,
        EXISTS (SELECT 1 FROM depots d WHERE d.lot_id = l.id AND d.statut = 'a_valider') AS a_valider
      FROM lots l WHERE l.hash=$1 AND l.statut NOT IN ('erreur','interrompu') ORDER BY l.id DESC LIMIT 1`, [hash]);
    // Même fichier pas encore validé (ou en cours de lecture) : on rouvre sa fenêtre au lieu de le refuser.
    if (ex[0] && !ex[0].enregistre && (ex[0].a_valider || ex[0].statut === 'en_cours')) { ids.push(ex[0].id); continue; }
    // Déposé mais jamais enregistré (tout ignoré) : on le relit.
    if (ex[0] && !ex[0].enregistre) { await pool.query('UPDATE lots SET hash=NULL WHERE id=$1', [ex[0].id]); ex.length = 0; }
    if (ex[0]) {
      const quand = ex[0].created_at.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
      dejaMis.push(`${f.originalname} (déjà déposé le ${quand}${ex[0].nom !== f.originalname ? ` sous le nom ${ex[0].nom}` : ''})`);
      continue;
    }
    // Session annuelle ou dépôt de plusieurs fichiers : documents lus l'un après l'autre (file d'attente), enregistrés et
    // rapprochés automatiquement, sans fenêtre de validation ; seuls les cas douteux restent à valider.
    const auto = req.body.session === '1' || req.body.groupe === '1';
    const info = req.body.session === '1' ? 'Session annuelle de téléchargement' : auto ? 'Dépôt groupé' : null;
    const { rows } = await pool.query('INSERT INTO lots (nom, created_by, hash, data, mimetype, auto, info) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [f.originalname, req.session.user.id, hash, f.buffer, f.mimetype, auto, info]);
    ids.push(rows[0].id);
    mettreEnFile(rows[0].id, f, req.session.user.id);
  }
  const msgs = [];
  if (dejaMis.length) msgs.push(`Déjà mis, non retraité : ${dejaMis.join(' ; ')}.`);
  if (refuses.length) msgs.push(`Format non pris en charge (PDF ou photo) : ${refuses.map((f) => f.originalname).join(', ')}.`);
  // Appel depuis la zone de dépôt : on renvoie les lots, la fenêtre s'ouvre côté navigateur.
  if (req.body.session === '1') {
    flash(req, `${ids.length} justificatif(s) reçu(s) : lecture et rattachement en cours.${msgs.length ? ' ' + msgs.join(' ') : ''}`);
    return res.redirect(`/session-annuelle/${Number(req.body.fournisseur) || ''}`);
  }
  if ((req.get('Accept') || '').includes('application/json')) return res.json({ lots: ids, message: msgs.join(' ') });
  if (msgs.length) flash(req, msgs.join(' '), 'err');
  res.redirect(ids.length ? `/lot/${ids[0]}` : '/operations');
});

app.get('/lot/:id/fichier', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT nom, mimetype, data FROM lots WHERE id=$1', [req.params.id]);
  if (!rows[0] || !rows[0].data) return res.status(404).send('');
  res.set('Content-Type', rows[0].mimetype);
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].nom)}`);
  res.send(rows[0].data);
});

app.get('/lots/etat.json', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE statut = 'en_cours')::int AS n,
      COUNT(*) FILTER (WHERE statut = 'en_cours' AND info = 'Dépôt groupé')::int AS groupe FROM lots`);
  res.json({ en_cours: rows[0].n, groupe: rows[0].groupe });
});

async function listeComptes() {
  const { rows } = await pool.query(`
    SELECT c.*, e.nom AS entite,
      COUNT(l.id) FILTER (WHERE l.operation_id IS NULL AND l.releve_carte_id IS NULL AND NOT l.ignoree)::int AS a_rapprocher
    FROM comptes c LEFT JOIN entites e ON e.id = c.entite_id LEFT JOIN lignes l ON l.compte_id = c.id
    GROUP BY c.id, e.nom ORDER BY e.nom NULLS LAST, c.banque, c.nature`);
  return rows.map((c) => ({ ...c, libelle: nomCompte(c) }));
}
function nomCompte(c) {
  const type = c.banque === 'AMEX' ? 'Carte AMEX' : c.nature === 'carte' ? `Carte ${c.banque}` : `Compte ${c.banque}`;
  return `${type}${c.numero ? ' …' + c.numero : ''} — ${c.entite || 'société à préciser'}`;
}
async function libelleCompte(id) {
  const { rows } = await pool.query('SELECT c.*, e.nom AS entite FROM comptes c LEFT JOIN entites e ON e.id = c.entite_id WHERE c.id=$1', [id]);
  return rows[0] ? { ...rows[0], libelle: nomCompte(rows[0]) } : null;
}

async function etatLot(id) {
  const { rows } = await pool.query('SELECT * FROM lots WHERE id=$1', [id]);
  if (!rows[0]) return null;
  const { rows: depots } = await pool.query(
    `SELECT id, page, ordre, statut, erreur, resultat->>'fournisseur' AS fournisseur,
       resultat->>'montant_ttc' AS montant_ttc, resultat->>'date' AS date,
       EXISTS (SELECT 1 FROM operations o WHERE o.montant_ttc = (d.resultat->>'montant_ttc')::numeric
         AND o.date_op = (d.resultat->>'date')::date) AS doublon
     FROM depots d WHERE lot_id=$1 ORDER BY page, ordre`, [id]);
  const { rows: rel } = await pool.query(`
    SELECT r.id, r.compte_id, r.periode_debut, r.periode_fin, r.nb_doublons,
      COUNT(l.id)::int AS nb_lignes,
      COUNT(l.id) FILTER (WHERE l.operation_id IS NOT NULL OR l.releve_carte_id IS NOT NULL)::int AS nb_rapprochees
    FROM releves r LEFT JOIN lignes l ON l.releve_id = r.id
    WHERE r.lot_id = $1 GROUP BY r.id ORDER BY r.id`, [id]);
  for (const r of rel) r.compte = await libelleCompte(r.compte_id);
  const releve = rel[0] || null;
  return { lot: rows[0], depots, releve, relevesLot: rel };
}

app.get('/lot/:id', requireAuth, async (req, res) => {
  const e = await etatLot(req.params.id);
  if (!e) return res.redirect('/');
  const aValider = e.depots.filter((d) => d.statut === 'a_valider');
  if (!req.query.liste) {
    // Dès qu'un ticket est lu, on ouvre son formulaire.
    if (aValider.length) return res.redirect(`/depot/${aValider[0].id}`);
    // Lot de tickets entièrement traité : on passe au dépôt suivant, ou on revient aux opérations.
    if (e.lot.statut === 'termine' && !e.releve) return res.redirect(await prochainLot());
  }
  res.render('lot', { ...e, aValider });
});

app.get('/lot/:id/etat.json', requireAuth, async (req, res) => {
  const e = await etatLot(req.params.id);
  if (!e) return res.status(404).json({});
  res.json({ statut: e.lot.statut, total: e.lot.total_pages, faites: e.lot.pages_traitees,
    tickets: e.releve ? e.releve.nb_lignes : e.depots.length,
    a_valider: e.depots.filter((d) => d.statut === 'a_valider').length });
});

app.get('/depot/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, lot_id, page, nom, mimetype, resultat, erreur, statut FROM depots WHERE id=$1', [req.params.id]);
  const d = rows[0];
  if (!d) return res.redirect('/operations');
  if (d.statut !== 'a_valider') return res.redirect(d.lot_id ? `/lot/${d.lot_id}?liste=1` : '/operations');
  const r = d.resultat || {};
  const { entites, categories } = await refs();
  const ent = entites.find((e) => e.nom === r.societe_nom);
  const vente = r.sens === 'vente';
  const cat = categories.find((c) => c.nom === (vente && !/ventes|loyers per/i.test(r.categorie || '') ? 'Ventes / honoraires' : r.categorie));
  const op = {
    date_op: r.date || new Date().toISOString().slice(0, 10),
    type: vente ? 'recette' : 'depense',
    reglement: vente ? 'Non réglé' : undefined,
    entite_id: ent ? ent.id : null,
    categorie_id: cat ? cat.id : null,
    libelle: r.libelle || (r.fournisseur ? `${vente ? 'Facture' : 'Achat'} ${r.fournisseur}` : ''),
    tiers: r.fournisseur || '',
    montant_ttc: r.montant_ttc,
    tva: r.tva,
    paiement: (await releves.paiementDepuisDocument(r)) || '',
    carte: r.carte || '',
    notes: r.mentions_manuscrites ? `Manuscrit : ${r.mentions_manuscrites}` : '',
  };
  let position = null;
  if (d.lot_id) {
    const { rows: tous } = await pool.query(
      'SELECT id, statut FROM depots WHERE lot_id=$1 ORDER BY page, ordre', [d.lot_id]);
    position = { rang: tous.findIndex((x) => x.id === d.id) + 1, total: tous.length,
      restants: tous.filter((x) => x.statut === 'a_valider').length };
  }
  // Doublon probable : une opération déjà saisie avec le même montant et la même date.
  let doublons = [];
  if (r.montant_ttc && r.date) {
    ({ rows: doublons } = await pool.query(
      `SELECT o.id, o.date_op, o.tiers, o.libelle, o.montant_ttc, e.nom AS entite FROM operations o
       LEFT JOIN entites e ON e.id = o.entite_id
       WHERE o.montant_ttc = $1 AND o.date_op = $2 ORDER BY o.id`, [r.montant_ttc, r.date]));
  }
  // Reçu de paiement : on propose de le rattacher à la facture déjà saisie.
  let factureRecu = null;
  if (r.type_document === 'recu' || r.type_document === 'facturette') {
    const id = await factureDuRecu(r);
    if (id) {
      const { rows: fr } = await pool.query(
        'SELECT o.id, o.date_op, o.tiers, o.libelle, o.montant_ttc, e.nom AS entite FROM operations o LEFT JOIN entites e ON e.id = o.entite_id WHERE o.id=$1', [id]);
      factureRecu = fr[0] || null;
    }
  }
  op.numero_facture = r.numero_facture || '';
  res.render('operation_form', { op, depot: d, position, doublons, factureRecu, entites, categories, moyens: await moyensParEntite() });
});

app.get('/depot/:id/fichier', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT nom, mimetype, data FROM depots WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Introuvable');
  res.set('Content-Type', rows[0].mimetype);
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].nom)}`);
  res.send(rows[0].data);
});

// Après un ticket : le suivant du même dépôt, sinon on attend la suite de sa lecture,
// sinon le dépôt suivant en attente, sinon retour aux opérations.
async function prochainDepot(depotId) {
  const { rows } = await pool.query(
    `SELECT d2.id, d1.lot_id, l.statut FROM depots d1 JOIN lots l ON l.id = d1.lot_id
     LEFT JOIN depots d2 ON d2.lot_id = d1.lot_id AND d2.statut = 'a_valider'
     WHERE d1.id = $1 ORDER BY d2.page, d2.ordre LIMIT 1`, [depotId]);
  if (!rows[0]) return prochainLot();
  if (rows[0].id) return `/depot/${rows[0].id}`;
  if (rows[0].statut === 'en_cours') return `/lot/${rows[0].lot_id}`;
  return prochainLot();
}

async function prochainLot() {
  const { rows } = await pool.query(`
    SELECT l.id FROM lots l
    WHERE l.created_at > NOW() - INTERVAL '1 day' AND NOT EXISTS (SELECT 1 FROM releves r WHERE r.lot_id = l.id)
      AND ((l.statut = 'en_cours' AND NOT l.auto) OR EXISTS (SELECT 1 FROM depots d WHERE d.lot_id = l.id AND d.statut = 'a_valider'))
    ORDER BY l.id LIMIT 1`);
  return rows[0] ? `/lot/${rows[0].id}` : '/operations?fini=1';
}

app.post('/depot/:id/rattacher', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, nom, mimetype, data, resultat FROM depots WHERE id=$1', [req.params.id]);
  const d = rows[0];
  if (!d) return res.redirect('/operations');
  const opId = Number(req.body.operation_id);
  await rattacherRecu(opId, d.resultat || {}, { nom: d.nom, mimetype: d.mimetype, data: d.data });
  await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [d.id, opId]);
  flash(req, 'Reçu rattaché à la facture : date et moyen de paiement enregistrés.');
  res.redirect(await prochainDepot(d.id));
});

app.get('/operations/:id/recu', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT recu_nom, recu_type, recu_data FROM operations WHERE id=$1', [req.params.id]);
  const r = rows[0];
  if (!r || !r.recu_data) return res.status(404).send('Pas de reçu');
  res.set('Content-Type', r.recu_type || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.recu_nom)}`);
  res.send(r.recu_data);
});

app.post('/depot/:id/ignorer', requireAuth, async (req, res) => {
  await pool.query("UPDATE depots SET statut='ignore' WHERE id=$1", [req.params.id]);
  flash(req, 'Ticket ignoré.');
  res.redirect(await prochainDepot(req.params.id));
});

app.get('/operations', requireAuth, async (req, res) => {
  const q = { annee: String(new Date().getFullYear()), ...req.query };
  if (req.query.annee === '') q.annee = '';
  const { sql, params } = buildFilters(q);
  const { rows } = await pool.query(`${OPS_SELECT} ${sql} ORDER BY o.date_op DESC, o.id DESC`, params);
  const tot = rows.reduce((a, r) => {
    const m = Number(r.montant_ttc);
    if (r.type === 'recette') a.recettes += m; else a.depenses += m;
    return a;
  }, { recettes: 0, depenses: 0 });
  const { rows: annees } = await pool.query(
    'SELECT DISTINCT EXTRACT(YEAR FROM date_op)::int AS a FROM operations ORDER BY a DESC');
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  // Dépôts pas encore validés (tickets lus en attente, lectures en cours).
  const { rows: enAttente } = await pool.query(`
    SELECT l.id, l.nom, l.statut, COUNT(d.id) FILTER (WHERE d.statut = 'a_valider')::int AS restants
    FROM lots l LEFT JOIN depots d ON d.lot_id = l.id
    WHERE NOT EXISTS (SELECT 1 FROM releves r WHERE r.lot_id = l.id)
    GROUP BY l.id
    HAVING (l.statut = 'en_cours' AND NOT l.auto AND l.created_at > NOW() - INTERVAL '1 day') OR COUNT(d.id) FILTER (WHERE d.statut = 'a_valider') > 0
    ORDER BY l.id`);
  res.render('operations', { ops: rows, tot, q, qs, annees: annees.map((x) => x.a), enAttente,
    iaActive: !!process.env.ANTHROPIC_API_KEY, ...(await refs()) });
});

app.get('/operations/new', requireAuth, async (req, res) => {
  const r = await refs();
  let op = { date_op: new Date().toISOString().slice(0, 10), type: 'depense', entite_id: Number(req.query.entite) || null };
  let ligne = null;
  if (req.query.ligne) {
    const { rows } = await pool.query(
      `SELECT l.*, c.entite_id, c.nature, c.banque, f.nom AS fournisseur FROM lignes l JOIN comptes c ON c.id = l.compte_id
       LEFT JOIN fournisseurs f ON f.id = l.fournisseur_id WHERE l.id=$1`, [req.query.ligne]);
    ligne = rows[0] || null;
    if (ligne) {
      const cat = r.categories.find((c) => c.nom === ligne.categorie);
      const d = ligne.date_op;
      op = {
        date_op: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        type: Number(ligne.montant) < 0 ? 'depense' : 'recette', entite_id: ligne.entite_id,
        categorie_id: cat ? cat.id : null, libelle: ligne.libelle, montant_ttc: Math.abs(Number(ligne.montant)),
        tiers: ligne.fournisseur || '',
        paiement: ligne.nature === 'carte' ? (ligne.banque === 'AMEX' ? 'AMEX' : 'CB CIC') : 'Virement / prélèvement CIC',
      };
    }
  }
  res.render('operation_form', { op, ligne, ...r });
});

// Règlement en plusieurs fois : enregistre les échéances et en déduit le statut de règlement.
async function enregistrerReglements(opId, b, montantTtc) {
  await pool.query('DELETE FROM reglements WHERE operation_id=$1', [opId]);
  if (!b.plusieurs_fois) return;
  const arr = (x) => [].concat(x === undefined ? [] : x);
  const dates = arr(b['reg_date[]'] ?? b.reg_date), montants = arr(b['reg_montant[]'] ?? b.reg_montant), modes = arr(b['reg_paiement[]'] ?? b.reg_paiement);
  let total = 0;
  for (let i = 0; i < montants.length; i++) {
    const m = toNum(montants[i]);
    if (!m || Number.isNaN(m)) continue;
    total += m;
    await pool.query('INSERT INTO reglements (operation_id, date_reg, montant, paiement) VALUES ($1,$2,$3,$4)',
      [opId, dates[i] || null, m, PAIEMENTS.includes(modes[i]) ? modes[i] : null]);
  }
  const statut = total <= 0 ? 'Non réglé' : total + 0.005 >= montantTtc ? 'Réglé' : 'Partiellement réglé';
  await pool.query('UPDATE operations SET reglement=$1 WHERE id=$2', [statut, opId]);
}

// Carte saisie avec son moyen de paiement (« •••• 1001 » + AMEX) : retenue pour les prochains documents.
async function apprendreCarte(carte, paiement) {
  const m = carte && String(carte).match(/(\d{4})\D*$/);
  if (!m || !['CB CIC', 'AMEX'].includes(paiement)) return;
  await pool.query('INSERT INTO cartes (numero, paiement) VALUES ($1,$2) ON CONFLICT (numero) DO UPDATE SET paiement=EXCLUDED.paiement', [m[1], paiement]);
  await releves.appliquerCartes();
}

function opValues(b) {
  return [
    b.entite_id === 'inconnue' ? null : Number(b.entite_id), b.date_op, b.type === 'recette' ? 'recette' : 'depense',
    b.categorie_id ? Number(b.categorie_id) : null, (b.libelle || '').trim(), (b.tiers || '').trim() || null,
    toNum(b.montant_ttc), toNum(b.tva), (b.notes || '').trim() || null,
    PAIEMENTS.includes(b.paiement) ? b.paiement : null, (b.carte || '').trim() || null,
    LIVRAISONS.includes(b.livraison) ? b.livraison : null,
    REGLEMENTS.includes(b.reglement) ? b.reglement : null,
    b.montant_debite ? toNum(b.montant_debite) : null,
    (b.numero_facture || '').trim() || null,
    b.date_paiement || null,
  ];
}

function validOp(v) {
  return (v[0] || v[0] === null) && v[1] && v[4] && !Number.isNaN(v[6]) && !Number.isNaN(v[7]);
}

app.post('/operations', requireAuth, upload.single('justificatif'), async (req, res) => {
  const v = opValues(req.body);
  if (!validOp(v)) {
    flash(req, 'Champs obligatoires manquants ou montant invalide.', 'err');
    return res.redirect(req.body.depot_id ? `/depot/${Number(req.body.depot_id)}` : '/operations/new');
  }
  let f = req.file ? { nom: req.file.originalname, type: req.file.mimetype, data: req.file.buffer } : null;
  const depotId = Number(req.body.depot_id) || null;
  if (!f && depotId) {
    const { rows } = await pool.query('SELECT nom, mimetype, data FROM depots WHERE id=$1', [depotId]);
    if (rows[0]) f = { nom: rows[0].nom, type: rows[0].mimetype, data: rows[0].data };
  }
  // Justificatif d'un débit déjà enregistré d'office depuis le relevé (session annuelle, rien à faire) : on complète
  // cette opération plutôt que d'en créer une seconde.
  const provisoire = f && !req.body.ligne_id
    ? await releves.trouverProvisoire([v[6], v[13]].filter(Boolean), v[1], v[5]) : null;
  if (provisoire) {
    await pool.query(`UPDATE operations SET entite_id=COALESCE($1, entite_id), date_op=$2, type=$3, categorie_id=COALESCE($4, categorie_id),
        libelle=$5, tiers=COALESCE($6, tiers), tva=$7, notes=$8, carte=COALESCE($9, carte), livraison=$10,
        numero_facture=COALESCE($11, numero_facture), justif_nom=$12, justif_type=$13, justif_data=$14, justif_attendu=FALSE, updated_at=NOW()
      WHERE id=$15`,
      [v[0], v[1], v[2], v[3], v[4], v[5], v[7], v[8] || 'Justificatif déposé et rattaché à l\'opération du relevé', v[10], v[11], v[14],
        f.nom, f.type, f.data, provisoire]);
    if (v[2] === 'depense') await fournisseurs.lierOperation(provisoire, v[5]);
    flash(req, 'Justificatif rattaché à l\'opération déjà présente sur le relevé.');
    if (depotId) {
      await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [depotId, provisoire]);
      return res.redirect(await prochainDepot(depotId));
    }
    return res.redirect('/operations');
  }
  const { rows: ins } = await pool.query(
    `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes,
       paiement, carte, livraison, reglement, montant_debite, numero_facture, date_paiement, justif_nom, justif_type, justif_data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [...v, f ? f.nom : null, f ? f.type : null, f ? f.data : null, req.session.user.id]);
  const opId = ins[0].id;
  if (v[2] === 'depense') await fournisseurs.lierOperation(opId, v[5]);
  await apprendreCarte(v[10], v[9]);
  await enregistrerReglements(opId, req.body, v[6]);
  if (req.body.ligne_id) {
    await pool.query('UPDATE lignes SET operation_id=$1 WHERE id=$2 AND operation_id IS NULL',
      [opId, Number(req.body.ligne_id)]).catch(() => {});
    await releves.attribuerSocietes();
  } else {
    releves.rapprocher().catch((e) => console.error('Rapprochement :', e.message));
  }
  fournisseurs.mettreAJour();
  flash(req, 'Opération enregistrée.');
  if (req.body.ligne_id) {
    const { rows } = await pool.query('SELECT compte_id FROM lignes WHERE id=$1', [Number(req.body.ligne_id)]);
    return res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}`);
  }
  if (depotId) {
    await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [depotId, opId]);
    return res.redirect(await prochainDepot(depotId));
  }
  res.redirect(req.body.encore ? `/operations/new?entite=${v[0]}` : '/operations');
});

app.get('/operations/:id/edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`${OPS_SELECT} WHERE o.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).send('Introuvable');
  const op = rows[0];
  op.date_op = new Date(op.date_op.getTime() - op.date_op.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const { rows: regs } = await pool.query(
    "SELECT to_char(date_reg, 'YYYY-MM-DD') AS date_reg, montant, paiement FROM reglements WHERE operation_id=$1 ORDER BY date_reg NULLS LAST, id", [op.id]);
  op.reglements = regs;
  res.render('operation_form', { op, ...(await refs()) });
});

app.post('/operations/:id', requireAuth, upload.single('justificatif'), async (req, res) => {
  const v = opValues(req.body);
  if (!validOp(v)) { flash(req, 'Champs obligatoires manquants ou montant invalide.', 'err'); return res.redirect(`/operations/${req.params.id}/edit`); }
  await pool.query(
    `UPDATE operations SET entite_id=$1, date_op=$2, type=$3, categorie_id=$4, libelle=$5, tiers=$6,
       montant_ttc=$7, tva=$8, notes=$9, paiement=$10, carte=$11, livraison=$12, reglement=$13, montant_debite=$14, numero_facture=$15, date_paiement=$16, updated_at=NOW() WHERE id=$17`, [...v, req.params.id]);
  if (v[5] && v[2] === 'depense') await fournisseurs.lierOperation(req.params.id, v[5]);
  await apprendreCarte(v[10], v[9]);
  await enregistrerReglements(req.params.id, req.body, v[6]);
  if (req.file) {
    await pool.query('UPDATE operations SET justif_nom=$1, justif_type=$2, justif_data=$3 WHERE id=$4',
      [req.file.originalname, req.file.mimetype, req.file.buffer, req.params.id]);
  } else if (req.body.suppr_justif) {
    await pool.query('UPDATE operations SET justif_nom=NULL, justif_type=NULL, justif_data=NULL WHERE id=$1', [req.params.id]);
  }
  flash(req, 'Opération mise à jour.');
  res.redirect('/operations');
});

app.post('/operations/:id/delete', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM operations WHERE id=$1', [req.params.id]);
  flash(req, 'Opération supprimée.');
  res.redirect('/operations');
});

app.get('/operations/:id/justificatif', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT justif_nom, justif_type, justif_data FROM operations WHERE id=$1', [req.params.id]);
  const r = rows[0];
  if (!r || !r.justif_data) return res.status(404).send('Pas de justificatif');
  res.set('Content-Type', r.justif_type || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.justif_nom)}`);
  res.send(r.justif_data);
});

// ---------- rapprochement ----------
app.get('/rapprochement', requireAuth, async (req, res) => {
  const comptes = await listeComptes();
  if (!comptes.length) return res.render('rapprochement', { comptes, compte: null, lignes: [], releves: [], filtre: 'a_faire', ...(await refs()) });
  // Filtre par société : seuls les comptes de cette société sont proposés.
  const societe = req.query.societe || '';
  const visibles = societe ? comptes.filter((c) => String(c.entite_id || '') === (societe === 'aucune' ? '' : societe)) : comptes;
  const compte = visibles.find((c) => String(c.id) === String(req.query.compte)) || visibles.find((c) => c.a_rapprocher) || visibles[0];
  if (!compte) return res.redirect('/rapprochement');
  // Filtre de statut : à rapprocher (par défaut), rapproché, rapprochement non nécessaire, toutes, incohérences.
  const filtre = ['tout', 'ecarts', 'rapproche', 'non_necessaire'].includes(req.query.filtre) ? req.query.filtre : 'a_faire';
  const moisFiltre = /^\d{4}-\d{2}$/.test(req.query.mois || '') ? req.query.mois : '';
  // Statut d'une ligne : non nécessaire = ignorée, ou couverte par une écriture automatique sans justificatif
  // (rien à faire, session annuelle, encaissement automatique) ; rapproché = opération ou relevé de carte ; sinon à rapprocher.
  const { rows: lignes } = await pool.query(`
    SELECT * FROM (
      SELECT l.*, o.libelle AS op_libelle, o.tiers AS op_tiers, o.date_op AS op_date, o.justif_nom AS op_justif,
        o.entite_id AS op_entite_id, o.paiement AS op_paiement,
        r.periode_debut AS rc_debut, r.periode_fin AS rc_fin,
        (SELECT COUNT(*) FROM lignes x WHERE x.releve_id = r.id)::int AS rc_nb,
        CASE WHEN l.ignoree OR (o.id IS NOT NULL AND o.justif_data IS NULL AND (o.justif_attendu
               OR o.notes LIKE 'Écriture automatique%' OR o.notes LIKE 'Encaissement automatique%')) THEN 'non_necessaire'
             WHEN l.operation_id IS NOT NULL OR l.releve_carte_id IS NOT NULL THEN 'rapproche'
             ELSE 'a_rapprocher' END AS statut
      FROM lignes l
      LEFT JOIN operations o ON o.id = l.operation_id
      LEFT JOIN releves r ON r.id = l.releve_carte_id
      WHERE l.compte_id = $1 AND ($2 = '' OR to_char(l.date_op, 'YYYY-MM') = $2)
    ) x
    WHERE ${filtre === 'a_faire' ? "statut = 'a_rapprocher'" : filtre === 'rapproche' ? "statut = 'rapproche'"
      : filtre === 'non_necessaire' ? "statut = 'non_necessaire'" : filtre === 'ecarts' ? 'operation_id IS NOT NULL AND NOT ecart_accepte' : 'TRUE'}
    ORDER BY date_op DESC, id DESC`, [compte.id, moisFiltre]);
  const { rows: moisDispo } = await pool.query(`SELECT DISTINCT to_char(date_op, 'YYYY-MM') AS m FROM lignes WHERE compte_id = $1 ORDER BY m DESC`, [compte.id]);
  const nomsEntites = Object.fromEntries((await refs()).entites.map((e) => [e.id, e.nom]));
  for (const l of lignes) {
    if (!l.operation_id && !l.total_carte && !l.ignoree) {
      // Suggestions (même montant, ±45 jours), y compris celles dont la société ou le paiement saisis diffèrent.
      const ctx = { ...l, nature: compte.nature, banque: compte.banque, entite_id: compte.entite_id };
      l.suggestions = (await releves.candidats(ctx, 45, false)).map((o) => ({ ...o, ecarts: releves.ecarts(o, compte, nomsEntites) }))
        .sort((x, y) => x.ecarts.length - y.ecarts.length || x.ecart - y.ecart);
    } else if (l.operation_id && !l.ecart_accepte) {
      l.ecarts = releves.ecarts({ entite_id: l.op_entite_id, paiement: l.op_paiement }, compte, nomsEntites);
    }
  }
  const { rows: rels } = await pool.query(
    `SELECT r.id, r.nom, r.periode_debut, r.periode_fin, r.created_at,
       (SELECT COUNT(*) FROM lignes WHERE releve_id = r.id)::int AS nb,
       (SELECT COALESCE(SUM(montant),0) FROM lignes WHERE releve_id = r.id) AS total
     FROM releves r WHERE r.compte_id = $1 ORDER BY r.periode_debut DESC NULLS LAST, r.id DESC`, [compte.id]);
  const lignesAffichees = filtre === 'ecarts' ? lignes.filter((l) => l.ecarts && l.ecarts.length) : lignes;
  // Couverture : pour chaque compte, mois couverts par un relevé chargé (plus de la moitié du mois), du premier relevé au mois dernier.
  const { rows: per } = await pool.query('SELECT compte_id, periode_debut, periode_fin FROM releves WHERE periode_debut IS NOT NULL AND periode_fin IS NOT NULL');
  const jour = 86400000, auj = new Date();
  const finMois = new Date(Date.UTC(auj.getUTCFullYear(), auj.getUTCMonth(), 0));
  let debutMois = per.length ? new Date(Math.min(...per.map((p) => p.periode_debut.getTime()))) : finMois;
  debutMois = new Date(Date.UTC(debutMois.getUTCFullYear(), debutMois.getUTCMonth(), 1));
  const mois = [];
  for (let d = new Date(debutMois); d <= finMois; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) mois.push(d);
  const couverture = comptes.map((c) => {
    const ps = per.filter((p) => p.compte_id === c.id);
    const etat = mois.map((m) => {
      const fin = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
      const nbJours = Math.round((fin - m) / jour) + 1;
      let couverts = 0;
      for (let t = m.getTime(); t <= fin.getTime(); t += jour) {
        if (ps.some((p) => p.periode_debut.getTime() <= t && t <= p.periode_fin.getTime())) couverts++;
      }
      return couverts * 2 > nbJours ? 'ok' : couverts ? 'partiel' : 'manque';
    });
    // Avant le premier relevé de ce compte : sans objet (compte peut-être ouvert plus tard).
    const premier = ps.length ? Math.min(...ps.map((p) => p.periode_debut.getTime())) : Infinity;
    return { ...c, etat: etat.map((e, i) => (mois[i].getTime() + 31 * jour < premier && e === 'manque' ? 'avant' : e)) };
  });
  // Nombre d'incohérences par compte (pour les onglets).
  for (const c of comptes) {
    const { rows: rr } = await pool.query(`SELECT o.entite_id, o.paiement FROM lignes l JOIN operations o ON o.id = l.operation_id
      WHERE l.compte_id = $1 AND NOT l.ecart_accepte`, [c.id]);
    c.nb_ecarts = rr.filter((o) => releves.ecarts(o, c, nomsEntites).length).length;
  }
  res.render('rapprochement', { visibles, societe, mois, couverture, moisFiltre, moisDispo: moisDispo.map((x) => x.m), comptes, compte, lignes: lignesAffichees, releves: rels, filtre, ...(await refs()) });
});

app.post('/rapprochement/auto', requireAuth, async (req, res) => {
  const n = await releves.rapprocher();
  flash(req, `${n} rapprochement(s) automatique(s) effectué(s).`);
  res.redirect(`/rapprochement?compte=${Number(req.body.compte) || ''}`);
});

app.post('/lignes/:id/associer', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT compte_id FROM lignes WHERE id=$1', [req.params.id]);
  try {
    await pool.query('UPDATE lignes SET operation_id=$1 WHERE id=$2', [Number(req.body.operation_id), req.params.id]);
    if (req.body.corriger) await releves.corrigerDepuisLigne(req.params.id);
    await releves.attribuerSocietes();
    flash(req, req.body.corriger ? 'Ligne rapprochée et opération corrigée.' : 'Ligne rapprochée.');
  } catch (e) {
    flash(req, 'Cette opération est déjà rapprochée d\'une autre ligne.', 'err');
  }
  res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}`);
});

app.post('/lignes/:id/corriger', requireAuth, async (req, res) => {
  await releves.corrigerDepuisLigne(req.params.id);
  const { rows } = await pool.query('SELECT compte_id FROM lignes WHERE id=$1', [req.params.id]);
  flash(req, 'Opération corrigée d\'après le relevé.');
  res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}&filtre=${req.body.filtre || 'tout'}`);
});

app.post('/lignes/:id/garder', requireAuth, async (req, res) => {
  const { rows } = await pool.query('UPDATE lignes SET ecart_accepte=TRUE WHERE id=$1 RETURNING compte_id', [req.params.id]);
  flash(req, 'Saisie conservée telle quelle.');
  res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}&filtre=${req.body.filtre || 'tout'}`);
});

app.post('/lignes/:id/defaire', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE lignes SET operation_id=NULL, releve_carte_id=NULL, ignoree=FALSE, ecart_accepte=FALSE WHERE id=$1 RETURNING compte_id', [req.params.id]);
  flash(req, 'Rapprochement annulé.');
  res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}&filtre=tout`);
});

app.post('/lignes/:id/ignorer', requireAuth, async (req, res) => {
  const { rows } = await pool.query('UPDATE lignes SET ignoree=TRUE WHERE id=$1 RETURNING compte_id', [req.params.id]);
  res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}`);
});

// Crée les écritures pour les lignes cochées (sans ticket ni facture : frais, virements, prélèvements…).
app.post('/lignes/creer', requireAuth, async (req, res) => {
  const ids = [].concat(req.body.ligne || []).map(Number).filter(Boolean);
  let n = 0;
  let compteId = Number(req.body.compte) || null;
  for (const id of ids) {
    const { rows } = await pool.query(
      `SELECT l.*, c.entite_id, c.nature, c.banque FROM lignes l JOIN comptes c ON c.id = l.compte_id
       WHERE l.id=$1 AND l.operation_id IS NULL AND l.total_carte IS NULL`, [id]);
    const l = rows[0];
    if (!l || !l.entite_id) continue;
    const cat = l.categorie ? (await pool.query('SELECT id FROM categories WHERE nom=$1', [l.categorie])).rows[0] : null;
    const paiement = l.nature === 'carte' ? (l.banque === 'AMEX' ? 'AMEX' : 'CB CIC') : 'Virement / prélèvement CIC';
    const op = await pool.query(
      `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, montant_ttc, tva, paiement, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8) RETURNING id`,
      [l.entite_id, l.date_op, Number(l.montant) < 0 ? 'depense' : 'recette', cat ? cat.id : null, l.libelle,
        Math.abs(Number(l.montant)), paiement, req.session.user.id]);
    await pool.query('UPDATE lignes SET operation_id=$1 WHERE id=$2', [op.rows[0].id, id]);
    if (l.fournisseur_id) {
      await pool.query(`UPDATE operations SET fournisseur_id=$1, tiers=COALESCE(tiers, (SELECT nom FROM fournisseurs WHERE id=$1)) WHERE id=$2`,
        [l.fournisseur_id, op.rows[0].id]);
    }
    n++;
  }
  flash(req, n ? `${n} écriture(s) créée(s).` : 'Aucune écriture créée (société du compte à préciser ?).', n ? 'ok' : 'err');
  res.redirect(`/rapprochement?compte=${compteId || ''}`);
});

app.post('/comptes/:id', requireAuth, async (req, res) => {
  const entite = Number(req.body.entite_id) || null;
  await pool.query('UPDATE comptes SET entite_id=$1 WHERE id=$2', [entite, req.params.id]);
  // Opérations créées depuis les lignes de ce compte, sans justificatif (rien à faire, session annuelle, écriture créée
  // depuis le relevé) : elles prennent la société titulaire du compte.
  if (entite) {
    const { rowCount } = await pool.query(`UPDATE operations o SET entite_id=$1, updated_at=NOW()
      FROM lignes l WHERE l.operation_id = o.id AND l.compte_id = $2 AND o.justif_data IS NULL AND o.entite_id IS DISTINCT FROM $1`,
      [entite, req.params.id]);
    if (rowCount) flash(req, `${rowCount} opération(s) créée(s) depuis ce relevé passée(s) à la nouvelle société.`);
  }
  await releves.rapprocher();
  res.redirect(req.body.retour === 'admin' ? '/admin#comptes' : `/rapprochement?compte=${req.params.id}`);
});

app.get('/releves/:id/fichier', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT nom, mimetype, data FROM releves WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Introuvable');
  res.set('Content-Type', rows[0].mimetype);
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].nom)}`);
  res.send(rows[0].data);
});

app.post('/releves/:id/relire', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT lot_id, nom, mimetype, data FROM releves WHERE id=$1', [req.params.id]);
  const r = rows[0];
  if (!r) return res.redirect('/rapprochement');
  // On supprime toutes les lignes issues de ce fichier (compte + détail carte) ; les opérations saisies sont conservées.
  if (r.lot_id) {
    await pool.query('DELETE FROM releves WHERE lot_id=$1', [r.lot_id]);
    await pool.query('UPDATE lots SET hash=NULL WHERE id=$1', [r.lot_id]);
  } else {
    await pool.query('DELETE FROM releves WHERE id=$1', [req.params.id]);
  }
  const hash = crypto.createHash('sha256').update(r.data).digest('hex');
  const lot = await pool.query('INSERT INTO lots (nom, created_by, hash) VALUES ($1,$2,$3) RETURNING id',
    [r.nom, req.session.user.id, hash]);
  mettreEnFile(lot.rows[0].id, { originalname: r.nom, mimetype: r.mimetype, buffer: r.data }, req.session.user.id);
  res.redirect(`/lot/${lot.rows[0].id}`);
});

app.post('/releves/:id/supprimer', requireAuth, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM releves WHERE id=$1 RETURNING compte_id', [req.params.id]);
  flash(req, 'Relevé et ses lignes supprimés.');
  res.redirect(`/rapprochement?compte=${rows[0] ? rows[0].compte_id : ''}`);
});

// ---------- fournisseurs ----------
app.get('/fournisseurs', requireAuth, async (req, res) => {
  await pool.query(`UPDATE fournisseurs f SET automatise = TRUE
    FROM depots d JOIN lots l ON l.id = d.lot_id AND l.source = 'email' JOIN operations o ON o.id = d.operation_id
    WHERE o.fournisseur_id = f.id AND NOT f.automatise AND NOT f.modifie_main`);
  const { rows } = await pool.query(`
    WITH mvts AS (
      SELECT fournisseur_id, date_op, ABS(montant) AS m, id AS ligne_id, operation_id
        FROM lignes WHERE fournisseur_id IS NOT NULL AND total_carte IS NULL AND NOT ignoree AND montant < 0
      UNION ALL
      SELECT o.fournisseur_id, o.date_op, o.montant_ttc, NULL, o.id
        FROM operations o WHERE o.fournisseur_id IS NOT NULL AND o.type = 'depense'
          AND NOT EXISTS (SELECT 1 FROM lignes x WHERE x.operation_id = o.id)
    )
    SELECT f.*,
      COUNT(m.date_op)::int AS nb,
      COUNT(DISTINCT date_trunc('month', m.date_op))::int AS mois,
      COALESCE(SUM(m.m), 0) AS total,
      MAX(m.date_op) AS dernier,
      -- débits du relevé sans facture jointe
      COUNT(m.ligne_id) FILTER (WHERE m.operation_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = m.operation_id AND o.justif_nom IS NOT NULL))::int AS manquantes,
      (SELECT string_agg(DISTINCT e.nom, ', ') FROM lignes l JOIN comptes c ON c.id = l.compte_id JOIN entites e ON e.id = c.entite_id
        WHERE l.fournisseur_id = f.id) AS societes
    FROM fournisseurs f LEFT JOIN mvts m ON m.fournisseur_id = f.id
    GROUP BY f.id
    HAVING COUNT(m.date_op) > 0
    ORDER BY COALESCE(SUM(m.m), 0) DESC`);
  for (const f of rows) {
    // Récurrent si l'utilisateur l'a dit, ou constaté sur plusieurs mois, ou d'après l'analyse.
    f.recurrent = f.modifie_main ? f.type === 'recurrent' : (f.mois >= 2 || f.type === 'recurrent');
  }
  const groupes = {
    enLigne: rows.filter((f) => f.recurrent && f.en_ligne),
    recurrents: rows.filter((f) => f.recurrent && !f.en_ligne),
    ponctuelsEnLigne: rows.filter((f) => !f.recurrent && f.en_ligne),
    ponctuels: rows.filter((f) => !f.recurrent && !f.en_ligne),
  };
  const { rows: att } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM lignes WHERE NOT fournisseur_vu)::int AS lignes,
            (SELECT COUNT(*) FROM fournisseurs WHERE classe_le IS NULL AND NOT modifie_main)::int AS fourn`);
  res.render('fournisseurs', { groupes, enAttente: att[0], iaActive: !!process.env.ANTHROPIC_API_KEY });
});

app.post('/fournisseurs/analyser', requireAuth, async (req, res) => {
  fournisseurs.mettreAJour();
  flash(req, 'Analyse des fournisseurs lancée — la page se mettra à jour d\'ici quelques instants.');
  res.redirect('/fournisseurs');
});

app.post('/fournisseurs/:id', requireAuth, async (req, res) => {
  const b = req.body;
  let id = Number(req.params.id);
  const url = b.url && /^https?:\/\//.test(b.url.trim()) ? b.url.trim() : null;
  // Renommage : si le nouveau nom correspond à un fournisseur existant, on fusionne.
  const nom = (b.nom || '').trim();
  if (nom) {
    const k = fournisseurs.cle(nom);
    const { rows: ex } = await pool.query('SELECT id FROM fournisseurs WHERE cle=$1 AND id<>$2', [k, id]);
    if (ex[0]) {
      await pool.query('UPDATE lignes SET fournisseur_id=$1 WHERE fournisseur_id=$2', [ex[0].id, id]);
      await pool.query('UPDATE operations SET fournisseur_id=$1 WHERE fournisseur_id=$2', [ex[0].id, id]);
      await pool.query('DELETE FROM fournisseurs WHERE id=$1', [id]);
      id = ex[0].id;
    } else if (k) {
      await pool.query('UPDATE fournisseurs SET nom=$1, cle=$2 WHERE id=$3', [nom.slice(0, 80), k, id]);
    }
  }
  await pool.query(
    `UPDATE fournisseurs SET type=$1, en_ligne=$2, url=$3, recuperation=$4, note=$5, automatise=$6, modifie_main=TRUE WHERE id=$7`,
    [b.type === 'recurrent' ? 'recurrent' : 'ponctuel', b.en_ligne === '1',
      url, ['email', 'api', 'portail', 'non'].includes(b.recuperation) ? b.recuperation : null,
      (b.note || '').trim() || null, b.automatise === '1', id]);
  flash(req, 'Fournisseur mis à jour.');
  res.redirect('/fournisseurs');
});

// Mode de récupération des factures, choisi par boutons dans la liste des fournisseurs.
const MODES = ['email', 'automatique', 'session', 'scan', 'rien'];
app.post('/fournisseurs/:id/mode', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const mode = MODES.includes((req.body || {}).mode) ? req.body.mode : null;
  await pool.query(`UPDATE fournisseurs SET mode=$1, recup_annuelle = COALESCE($1 = 'session', FALSE), ecriture_auto = COALESCE($1 = 'rien', FALSE),
      automatise = CASE WHEN $1 IN ('email', 'automatique') THEN TRUE ELSE automatise END, modifie_main=TRUE WHERE id=$2`, [mode, id]);
  // Opérations créées d'office (session annuelle sans justificatif, écriture sans facture) qui ne correspondent plus au mode :
  // elles redeviennent des débits à rapprocher.
  const { rows } = await pool.query(`SELECT id FROM operations WHERE fournisseur_id=$1 AND justif_data IS NULL AND (
      (justif_attendu AND $2 IS DISTINCT FROM 'session')
      OR (notes LIKE 'Écriture automatique%' AND $2 IS DISTINCT FROM 'rien'))`, [id, mode]);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await pool.query('UPDATE lignes SET operation_id=NULL WHERE operation_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM reglements WHERE operation_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM operations WHERE id = ANY($1)', [ids]);
  }
  if (['session', 'rien'].includes(mode)) await releves.rapprocher();
  if ((req.get('Accept') || '').includes('application/json')) return res.json({ ok: true, mode });
  res.redirect('/fournisseurs');
});

// ---------- rien à faire (URSSAF, impôts, salaires…) : simple consultation ----------
app.get('/rien-a-faire', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT f.id, f.nom, f.note, COUNT(o.id)::int AS nb, COALESCE(SUM(o.montant_ttc), 0) AS total, MAX(o.date_op) AS dernier,
      string_agg(DISTINCT e.nom, ', ') AS societes
    FROM fournisseurs f LEFT JOIN operations o ON o.fournisseur_id = f.id LEFT JOIN entites e ON e.id = o.entite_id
    WHERE f.mode = 'rien' GROUP BY f.id ORDER BY COALESCE(SUM(o.montant_ttc), 0) DESC, f.nom`);
  res.render('rien_a_faire', { liste: rows });
});

// ---------- à scanner : débits du relevé dont le ticket n'a pas encore été déposé ----------
app.get('/a-scanner', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT l.id, l.date_op, l.libelle, l.montant, f.nom AS fournisseur, e.nom AS entite, c.banque, c.nature, c.id AS compte_id
    FROM lignes l JOIN fournisseurs f ON f.id = l.fournisseur_id JOIN comptes c ON c.id = l.compte_id
      LEFT JOIN entites e ON e.id = c.entite_id
    WHERE f.mode = 'scan' AND l.operation_id IS NULL AND l.total_carte IS NULL AND NOT l.ignoree AND l.montant < 0
    ORDER BY l.date_op DESC, l.id`);
  res.render('a_scanner', { lignes: rows });
});

// ---------- session annuelle de téléchargement (sites avec identifiant) ----------
app.get('/session-annuelle', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT f.id, f.nom, f.url,
      COUNT(o.id) FILTER (WHERE o.justif_attendu)::int AS attendus,
      COALESCE(SUM(o.montant_ttc) FILTER (WHERE o.justif_attendu), 0) AS total,
      string_agg(DISTINCT to_char(o.date_op, 'YYYY'), ', ') FILTER (WHERE o.justif_attendu) AS exercices,
      MIN(o.date_op) FILTER (WHERE o.justif_attendu) AS plus_ancien
    FROM fournisseurs f LEFT JOIN operations o ON o.fournisseur_id = f.id
    WHERE f.recup_annuelle GROUP BY f.id ORDER BY COUNT(o.id) FILTER (WHERE o.justif_attendu) DESC, f.nom`);
  res.render('session_annuelle', { liste: rows, f: null, ops: [] });
});

app.get('/session-annuelle/:id', requireAuth, async (req, res) => {
  const { rows: f } = await pool.query('SELECT id, nom, url FROM fournisseurs WHERE id=$1', [req.params.id]);
  if (!f[0]) return res.redirect('/session-annuelle');
  const { rows: ops } = await pool.query(`
    SELECT o.id, o.date_op, o.montant_ttc, o.libelle, e.nom AS entite, o.justif_attendu
    FROM operations o LEFT JOIN entites e ON e.id = o.entite_id
    WHERE o.fournisseur_id = $1 AND (o.justif_attendu OR o.notes = 'Justificatif récupéré lors de la session annuelle')
    ORDER BY o.justif_attendu DESC, o.date_op`, [f[0].id]);
  const { rows: enCours } = await pool.query("SELECT COUNT(*)::int AS n FROM lots WHERE auto AND info = 'Session annuelle de téléchargement' AND statut = 'en_cours'");
  res.render('session_annuelle', { liste: null, f: f[0], ops, enCours: enCours[0].n });
});

// ---------- boîte factures (e-mails) ----------
app.get('/boite', requireAuth, async (req, res) => {
  const { rows: mails } = await pool.query(`
    SELECT m.*,
      (SELECT json_agg(json_build_object('id', o.id, 'tiers', o.tiers, 'libelle', o.libelle, 'montant', o.montant_ttc))
         FROM depots d JOIN operations o ON o.id = d.operation_id
         WHERE d.lot_id = ANY(m.lot_ids)) AS ops,
      (SELECT MIN(d.id) FROM depots d WHERE d.lot_id = ANY(m.lot_ids) AND d.statut = 'a_valider') AS a_valider
    FROM emails_recus m ORDER BY m.recu_le DESC NULLS LAST, m.id DESC LIMIT 200`);
  // Fournisseurs en mode « Email → factures@ » : ceux dont une facture est déjà arrivée par la boîte, et ceux à basculer.
  const { rows: fourn } = await pool.query(`
    SELECT f.id, f.nom,
      (SELECT MAX(l.created_at) FROM operations o JOIN depots d ON d.operation_id = o.id JOIN lots l ON l.id = d.lot_id
        WHERE o.fournisseur_id = f.id AND l.source = 'email') AS derniere
    FROM fournisseurs f WHERE f.mode = 'email' ORDER BY f.nom`);
  res.render('boite', { mails, etat: boite.etat(), active: boite.active(),
    recus: fourn.filter((f) => f.derniere), aBasculer: fourn.filter((f) => !f.derniere) });
});

app.post('/boite/relever', requireAuth, async (req, res) => {
  const r = await boite.relever({ mettreEnFile });
  flash(req, r.erreur ? `Connexion à la boîte impossible : ${r.erreur}` : `${r.nouveaux} nouvel(s) e-mail(s) relevé(s).`, r.erreur ? 'err' : 'ok');
  res.redirect('/boite');
});

// ---------- export CSV (pour l'expert-comptable) ----------
app.get('/export.csv', requireAuth, async (req, res) => {
  const { sql, params } = buildFilters(req.query);
  const { rows } = await pool.query(`${OPS_SELECT} ${sql} ORDER BY e.nom NULLS LAST, o.date_op, o.id`, params);
  const esc = (s) => {
    const t = s === null || s === undefined ? '' : String(s);
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const num = (n) => Number(n).toFixed(2).replace('.', ',');
  const lines = [['Société', 'Date', 'Type', 'Catégorie', 'Libellé', 'Tiers', 'N° facture', 'Montant TTC', 'TVA', 'Montant HT', 'Paiement', 'Carte', 'Livraison', 'Règlement', 'Justificatif', 'Notes'].join(';')];
  for (const r of rows) {
    const d = r.date_op;
    const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    lines.push([r.entite || 'À déterminer', date, r.type === 'recette' ? 'Recette' : 'Dépense', r.categorie, r.libelle, r.tiers, r.numero_facture,
      num(r.montant_ttc), num(r.tva), num(r.montant_ttc - r.tva), r.paiement, r.carte, r.livraison, r.reglement, r.justif_nom ? 'oui' : 'non', r.notes].map(esc).join(';'));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="export-compta.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// ---------- synthèse ----------
app.get('/synthese', requireAuth, async (req, res) => {
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const { rows } = await pool.query(`
    SELECT e.nom AS entite, EXTRACT(MONTH FROM o.date_op)::int AS mois,
      SUM(CASE WHEN o.type='recette' THEN o.montant_ttc ELSE 0 END) AS recettes,
      SUM(CASE WHEN o.type='depense' THEN o.montant_ttc ELSE 0 END) AS depenses
    FROM entites e LEFT JOIN operations o ON o.entite_id = e.id AND EXTRACT(YEAR FROM o.date_op) = $1
    GROUP BY e.nom, mois ORDER BY e.nom, mois`, [annee]);
  const parEntite = {};
  for (const r of rows) {
    parEntite[r.entite] = parEntite[r.entite] || { mois: {}, recettes: 0, depenses: 0 };
    if (r.mois) {
      parEntite[r.entite].mois[r.mois] = { recettes: Number(r.recettes), depenses: Number(r.depenses) };
      parEntite[r.entite].recettes += Number(r.recettes);
      parEntite[r.entite].depenses += Number(r.depenses);
    }
  }
  const { rows: annees } = await pool.query(
    'SELECT DISTINCT EXTRACT(YEAR FROM date_op)::int AS a FROM operations ORDER BY a DESC');
  res.render('synthese', { annee, parEntite, annees: annees.map((x) => x.a) });
});

// ---------- compte de résultat simplifié (HT, par société et par catégorie) ----------
// Réglages d'une société : exercice comptable et modèle de facture de vente.
app.post('/admin/entites/:id', requireAdmin, upload.single('logo'), async (req, res) => {
  const b = req.body, t = (x) => (x || '').trim() || null;
  await pool.query(`UPDATE entites SET debut_exercice=$1, facture_prefixe=$2, facture_prochain=$3, facture_tva_intra=$4, facture_mention_tva=$5,
      facture_banque=$6, facture_conditions=$7, facture_penalites=$8, facture_pied=$9 WHERE id=$10`,
    [Math.min(12, Math.max(1, Number(b.debut_exercice) || 1)), b.facture_prefixe ?? '', Math.max(1, Number(b.facture_prochain) || 1),
      t(b.facture_tva_intra), t(b.facture_mention_tva), t(b.facture_banque), t(b.facture_conditions), t(b.facture_penalites), t(b.facture_pied),
      req.params.id]);
  if (req.file && /^image\//.test(req.file.mimetype)) {
    await pool.query('UPDATE entites SET logo=$1, logo_type=$2 WHERE id=$3', [req.file.buffer, req.file.mimetype, req.params.id]);
  }
  flash(req, 'Réglages de la société enregistrés.');
  res.redirect('/admin#societes');
});

// ---------- factures de vente (numérotation propre à chaque société) ----------
const num = (x) => { const n = parseFloat(String(x ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
function totauxFacture(f) {
  const r2 = (x) => Math.round(x * 100) / 100;
  const ht = r2((f.lignes || []).reduce((s, l) => s + num(l.montant), 0));
  const tva = r2(ht * num(f.taux_tva) / 100);
  const frais = r2((f.frais || []).reduce((s, l) => s + num(l.montant), 0));
  const ttc = r2(ht + tva + frais);
  return { ht, tva, ttcPrestation: r2(ht + tva), frais, ttc, acompte: num(f.acompte), aPayer: r2(ttc - num(f.acompte)) };
}
function factureDepuisForm(b) {
  const tab = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
  const paires = (d, m) => tab(d).map((x, i) => ({ designation: String(x || '').trim(), montant: num(tab(m)[i]) }))
    .filter((l) => l.designation || l.montant);
  return { entite_id: Number(b.entite_id), date: b.date || null, client_nom: (b.client_nom || '').trim(), client_adresse: (b.client_adresse || '').trim(),
    client_tva: (b.client_tva || '').trim() || null, bon_commande: (b.bon_commande || '').trim() || null,
    lignes: paires(b.l_designation, b.l_montant), frais: paires(b.f_designation, b.f_montant),
    taux_tva: num(b.taux_tva), acompte: num(b.acompte), conditions: (b.conditions || '').trim() || null };
}

app.get('/factures-vente', requireAuth, async (req, res) => {
  const { rows: entites } = await pool.query('SELECT id, nom, facture_prefixe, facture_prochain FROM entites ORDER BY nom');
  const societe = Number(req.query.societe) || null;
  const { rows: factures } = await pool.query(`
    SELECT f.*, e.nom AS entite, o.reglement FROM factures_vente f JOIN entites e ON e.id = f.entite_id
      LEFT JOIN operations o ON o.id = f.operation_id
    WHERE ($1::int IS NULL OR f.entite_id = $1)
    ORDER BY f.statut = 'brouillon' DESC, f.date DESC NULLS FIRST, f.id DESC`, [societe]);
  factures.forEach((f) => { f.totaux = totauxFacture(f); });
  res.render('factures_vente', { entites, factures, societe });
});

async function clientsConnus() {
  const { rows } = await pool.query(`SELECT DISTINCT ON (lower(client_nom)) client_nom, client_adresse, client_tva
    FROM factures_vente WHERE client_nom <> '' ORDER BY lower(client_nom), id DESC`);
  return rows;
}

app.get('/factures-vente/nouvelle', requireAuth, async (req, res) => {
  const { rows: e } = await pool.query('SELECT * FROM entites WHERE id=$1', [req.query.entite]);
  if (!e[0]) return res.redirect('/factures-vente');
  const f = { entite_id: e[0].id, date: new Date().toISOString().slice(0, 10), lignes: [{}], frais: [], taux_tva: 20, acompte: 0,
    conditions: e[0].facture_conditions || '' };
  res.render('facture_vente_form', { f, entite: e[0], clients: await clientsConnus() });
});

app.post('/factures-vente', requireAuth, async (req, res) => {
  const f = factureDepuisForm(req.body);
  const { rows } = await pool.query(`INSERT INTO factures_vente (entite_id, date, client_nom, client_adresse, client_tva, bon_commande,
      lignes, frais, taux_tva, acompte, conditions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [f.entite_id, f.date, f.client_nom, f.client_adresse, f.client_tva, f.bon_commande, JSON.stringify(f.lignes), JSON.stringify(f.frais),
      f.taux_tva, f.acompte, f.conditions]);
  flash(req, 'Brouillon enregistré. Vérifiez-le puis cliquez sur « Émettre » pour lui attribuer son numéro.');
  res.redirect(`/factures-vente/${rows[0].id}`);
});

async function factureVente(id) {
  const { rows } = await pool.query(`SELECT f.*, e.nom AS entite, e.facture_tva_intra, e.facture_mention_tva, e.facture_banque,
      e.facture_penalites, e.facture_pied, e.facture_prefixe, e.facture_prochain, (e.logo IS NOT NULL) AS a_logo, o.reglement
    FROM factures_vente f JOIN entites e ON e.id = f.entite_id LEFT JOIN operations o ON o.id = f.operation_id WHERE f.id=$1`, [id]);
  if (rows[0]) rows[0].totaux = totauxFacture(rows[0]);
  return rows[0];
}

app.get('/factures-vente/:id', requireAuth, async (req, res) => {
  const f = await factureVente(req.params.id);
  if (!f) return res.redirect('/factures-vente');
  res.render('facture_vente', { f, impression: req.query.imprimer === '1' });
});

app.get('/factures-vente/:id/modifier', requireAuth, async (req, res) => {
  const f = await factureVente(req.params.id);
  if (!f || f.statut !== 'brouillon') return res.redirect(`/factures-vente/${req.params.id}`);
  const { rows: e } = await pool.query('SELECT * FROM entites WHERE id=$1', [f.entite_id]);
  res.render('facture_vente_form', { f, entite: e[0], clients: await clientsConnus() });
});

app.post('/factures-vente/:id', requireAuth, async (req, res) => {
  const f = factureDepuisForm(req.body);
  await pool.query(`UPDATE factures_vente SET date=$1, client_nom=$2, client_adresse=$3, client_tva=$4, bon_commande=$5, lignes=$6, frais=$7,
      taux_tva=$8, acompte=$9, conditions=$10 WHERE id=$11 AND statut='brouillon'`,
    [f.date, f.client_nom, f.client_adresse, f.client_tva, f.bon_commande, JSON.stringify(f.lignes), JSON.stringify(f.frais),
      f.taux_tva, f.acompte, f.conditions, req.params.id]);
  res.redirect(`/factures-vente/${req.params.id}`);
});

app.post('/factures-vente/:id/supprimer', requireAuth, async (req, res) => {
  await pool.query("DELETE FROM factures_vente WHERE id=$1 AND statut='brouillon'", [req.params.id]);
  flash(req, 'Brouillon supprimé.');
  res.redirect('/factures-vente');
});

// Émission : numéro suivant de la société (attribué une seule fois, sans trou), puis recette « Ventes / honoraires » non réglée,
// qui sera rapprochée de l'encaissement sur le relevé.
app.post('/factures-vente/:id/emettre', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: fr } = await client.query("SELECT * FROM factures_vente WHERE id=$1 AND statut='brouillon' FOR UPDATE", [req.params.id]);
    const f = fr[0];
    if (!f) { await client.query('ROLLBACK'); return res.redirect(`/factures-vente/${req.params.id}`); }
    const t = totauxFacture(f);
    if (!f.client_nom || !t.ht) {
      await client.query('ROLLBACK');
      flash(req, 'Client et au moins une ligne de prestation sont nécessaires pour émettre la facture.', 'err');
      return res.redirect(`/factures-vente/${f.id}/modifier`);
    }
    const { rows: e } = await client.query(
      'UPDATE entites SET facture_prochain = facture_prochain + 1 WHERE id=$1 RETURNING facture_prefixe, facture_prochain - 1 AS n', [f.entite_id]);
    const numero = `${e[0].facture_prefixe || ''}${e[0].n}`;
    const date = f.date || new Date().toISOString().slice(0, 10);
    const { rows: cat } = await client.query("SELECT id FROM categories WHERE nom='Ventes / honoraires'");
    const { rows: op } = await client.query(`INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva,
        notes, numero_facture, reglement, facture_vente_id, created_by)
      VALUES ($1,$2,'recette',$3,$4,$5,$6,$7,'Facture de vente émise depuis le logiciel',$8,'Non réglé',$9,$10) RETURNING id`,
      [f.entite_id, date, cat[0] ? cat[0].id : null, (f.lignes[0] && f.lignes[0].designation) || `Facture ${numero}`, f.client_nom,
        t.ttc, t.tva, numero, f.id, req.session.user.id]);
    await client.query("UPDATE factures_vente SET numero=$1, date=$2, statut='emise', emise_le=NOW(), operation_id=$3 WHERE id=$4",
      [numero, date, op[0].id, f.id]);
    await client.query('COMMIT');
    flash(req, `Facture ${numero} émise et enregistrée en recette.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await releves.rapprocher();
  res.redirect(`/factures-vente/${req.params.id}`);
});

app.get('/entites/:id/logo', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT logo, logo_type FROM entites WHERE id=$1', [req.params.id]);
  if (!rows[0] || !rows[0].logo) return res.status(404).send('');
  res.set('Content-Type', rows[0].logo_type || 'image/png');
  res.send(rows[0].logo);
});

// Période d'un exercice clos en `annee` pour une société commençant au mois `debut` (1 = année civile).
function periodeExercice(debut, annee) {
  const d = Number(debut) || 1;
  const pad = (n) => String(n).padStart(2, '0');
  if (d === 1) return { debut: `${annee}-01-01`, fin: `${annee}-12-31` };
  const finMois = d - 1;
  const dernier = new Date(Date.UTC(annee, finMois, 0)).getUTCDate();
  return { debut: `${annee - 1}-${pad(d)}-01`, fin: `${annee}-${pad(finMois)}-${pad(dernier)}` };
}
const frDate = (iso) => iso.split('-').reverse().join('/');

app.get('/resultat', requireAuth, async (req, res) => {
  const { rows: entites } = await pool.query('SELECT id, nom, debut_exercice FROM entites ORDER BY nom');
  // Exercices proposés : clos l'année de chaque opération (ou l'année suivante pour les exercices décalés).
  const { rows: ans } = await pool.query(`SELECT DISTINCT a FROM (
      SELECT EXTRACT(YEAR FROM o.date_op)::int + CASE WHEN COALESCE(e.debut_exercice, 1) > 1
        AND EXTRACT(MONTH FROM o.date_op) >= e.debut_exercice THEN 1 ELSE 0 END AS a
      FROM operations o LEFT JOIN entites e ON e.id = o.entite_id) x ORDER BY a DESC`);
  const annees = ans.map((x) => x.a);
  const annee = Number(req.query.annee) || annees[0] || new Date().getFullYear();
  const periodes = entites.map((e) => ({ id: e.id, ...periodeExercice(e.debut_exercice, annee) }));
  periodes.push({ id: 0, ...periodeExercice(1, annee) });
  for (const e of entites) {
    const p = periodes.find((x) => x.id === e.id);
    e.periode = `${frDate(p.debut)} – ${frDate(p.fin)}`;
    e.exercice = e.debut_exercice > 1 ? `${annee - 1}-${annee}` : String(annee);
  }
  const P = [periodes.map((p) => p.id), periodes.map((p) => p.debut), periodes.map((p) => p.fin)];
  const cte = `WITH p AS (SELECT * FROM unnest($1::int[], $2::date[], $3::date[]) AS t(id, debut, fin))`;
  const { rows } = await pool.query(`${cte}
    SELECT o.type, COALESCE(c.nom, 'Non classé') AS categorie, o.entite_id,
      SUM(o.montant_ttc - COALESCE(o.tva, 0)) AS ht
    FROM operations o LEFT JOIN categories c ON c.id = o.categorie_id
      JOIN p ON p.id = COALESCE(o.entite_id, 0) AND o.date_op BETWEEN p.debut AND p.fin
    GROUP BY 1, 2, 3`, P);
  // Mouvements bancaires de l'exercice sans opération (pas encore rapprochés) : non compris, signalés à part.
  const { rows: nr } = await pool.query(`${cte}
    SELECT c.entite_id, SUM(l.montant) FILTER (WHERE l.montant > 0) AS entrees, SUM(-l.montant) FILTER (WHERE l.montant < 0) AS sorties
    FROM lignes l JOIN comptes c ON c.id = l.compte_id JOIN p ON p.id = COALESCE(c.entite_id, 0) AND l.date_op BETWEEN p.debut AND p.fin
    WHERE l.operation_id IS NULL AND l.releve_carte_id IS NULL AND l.total_carte IS NULL AND NOT l.ignoree
    GROUP BY 1`, P);
  const bloc = (type) => {
    const cats = {};
    for (const r of rows.filter((x) => x.type === type)) {
      cats[r.categorie] = cats[r.categorie] || {};
      cats[r.categorie][r.entite_id || 0] = Number(r.ht);
    }
    return Object.entries(cats).map(([nom, v]) => ({ nom, v })).sort((a, b) =>
      Object.values(b.v).reduce((s, x) => s + x, 0) - Object.values(a.v).reduce((s, x) => s + x, 0));
  };
  // Dus de trésorerie : dépense d'une société payée depuis le compte d'une autre (ou recette encaissée sur le compte d'une
  // autre) → la première doit le montant à la seconde. Avance CC : la société doit à l'associé. Cumul à la fin de l'exercice.
  const finMax = periodes.map((p) => p.fin).sort().pop();
  const { rows: dus } = await pool.query(`
    SELECT o.entite_id AS doit, c.entite_id AS a, SUM(CASE WHEN o.type = 'depense' THEN o.montant_ttc ELSE -o.montant_ttc END) AS montant
    FROM operations o JOIN lignes l ON l.operation_id = o.id JOIN comptes c ON c.id = l.compte_id
    WHERE o.entite_id IS NOT NULL AND c.entite_id IS NOT NULL AND o.entite_id <> c.entite_id AND o.date_op <= $1::date
    GROUP BY 1, 2
    UNION ALL
    SELECT o.entite_id, -1, SUM(o.montant_ttc) FROM operations o
    WHERE o.paiement LIKE 'Avance CC%' AND o.type = 'depense' AND o.entite_id IS NOT NULL AND o.date_op <= $1::date
    GROUP BY 1`, [finMax]);
  // Solde net par paire : positif = la société de la colonne est créancière de la contrepartie.
  const soldes = {};
  for (const d of dus) {
    const m = Number(d.montant);
    soldes[d.doit] = soldes[d.doit] || {}; soldes[d.doit][d.a] = (soldes[d.doit][d.a] || 0) - m;
    if (d.a !== -1) { soldes[d.a] = soldes[d.a] || {}; soldes[d.a][d.doit] = (soldes[d.a][d.doit] || 0) + m; }
  }
  res.render('resultat', { annee, soldes, annees, entites, finMax: frDate(finMax), revenus: bloc('recette'), couts: bloc('depense'),
    nonRappro: Object.fromEntries(nr.map((x) => [x.entite_id || 0, { entrees: Number(x.entrees || 0), sorties: Number(x.sorties || 0) }])) });
});

// ---------- administration ----------
app.get('/admin', requireAdmin, async (req, res) => {
  const { rows: users } = await pool.query('SELECT id, nom, email, is_admin, created_at FROM users ORDER BY nom');
  const { rows: societes } = await pool.query(`SELECT id, nom, debut_exercice, facture_prefixe, facture_prochain, facture_tva_intra,
      facture_mention_tva, facture_banque, facture_conditions, facture_penalites, facture_pied, (logo IS NOT NULL) AS a_logo,
      EXISTS (SELECT 1 FROM factures_vente f WHERE f.entite_id = entites.id AND f.statut = 'emise') AS a_factures
    FROM entites ORDER BY nom`);
  res.render('admin', { users, societes, comptes: await listeComptes(), ...(await refs()) });
});

app.post('/admin/users', requireAdmin, async (req, res) => {
  const { nom, email, password, is_admin } = req.body;
  if (!nom || !email || !password || password.length < 8) {
    flash(req, 'Nom, email et mot de passe (8 caractères min.) requis.', 'err');
    return res.redirect('/admin');
  }
  try {
    await pool.query('INSERT INTO users (nom, email, password_hash, is_admin) VALUES ($1, lower($2), $3, $4)',
      [nom, email, await bcrypt.hash(password, 12), !!is_admin]);
    flash(req, `Utilisateur ${nom} créé.`);
  } catch (e) {
    flash(req, 'Cet email existe déjà.', 'err');
  }
  res.redirect('/admin');
});

app.post('/admin/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) { flash(req, 'Mot de passe : 8 caractères minimum.', 'err'); return res.redirect('/admin'); }
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 12), req.params.id]);
  flash(req, 'Mot de passe modifié.');
  res.redirect('/admin');
});

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) { flash(req, 'Vous ne pouvez pas supprimer votre propre compte.', 'err'); return res.redirect('/admin'); }
  await pool.query('UPDATE operations SET created_by=NULL WHERE created_by=$1', [req.params.id]);
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  flash(req, 'Utilisateur supprimé.');
  res.redirect('/admin');
});

app.post('/admin/entites', requireAdmin, async (req, res) => {
  if (req.body.nom) await pool.query('INSERT INTO entites (nom) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.nom.trim()]);
  res.redirect('/admin');
});

app.post('/admin/moyens', requireAdmin, async (req, res) => {
  const coches = new Set([].concat(req.body.m || []));
  const { rows } = await pool.query('SELECT entite_id, paiement FROM moyens_entite');
  for (const r of rows) {
    await pool.query('UPDATE moyens_entite SET actif=$1 WHERE entite_id=$2 AND paiement=$3',
      [coches.has(`${r.entite_id}|${r.paiement}`), r.entite_id, r.paiement]);
  }
  flash(req, 'Moyens de paiement mis à jour.');
  res.redirect('/admin');
});

app.post('/admin/categories', requireAdmin, async (req, res) => {
  if (req.body.nom) await pool.query('INSERT INTO categories (nom) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.nom.trim()]);
  res.redirect('/admin');
});

// ---------- compte ----------
app.post('/compte/password', requireAuth, async (req, res) => {
  const { actuel, nouveau } = req.body;
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.session.user.id]);
  if (!rows[0] || !(await bcrypt.compare(actuel || '', rows[0].password_hash))) {
    flash(req, 'Mot de passe actuel incorrect.', 'err');
  } else if (!nouveau || nouveau.length < 8) {
    flash(req, 'Nouveau mot de passe : 8 caractères minimum.', 'err');
  } else {
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(nouveau, 12), req.session.user.id]);
    flash(req, 'Mot de passe modifié.');
  }
  res.redirect('/compte');
});
app.get('/compte', requireAuth, (req, res) => res.render('compte'));

boite.demarrer({ mettreEnFile });

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Erreur serveur');
});

}

const port = process.env.PORT || 3000;
init().then(sessionSecret).then((secret) => {
  setupSession(secret);
  registerRoutes();
  app.listen(port, () => console.log(`compta-app sur le port ${port}`));
})
  .catch((e) => { console.error('Init DB échouée', e); process.exit(1); });

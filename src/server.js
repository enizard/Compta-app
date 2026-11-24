const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const { pool, init } = require('./db');
const LIVRAISONS = ['Non livré', 'Partiellement livré', 'Livré en totalité'];
const REGLEMENTS = ['À régler', 'Partiellement réglé', 'Déjà réglé'];
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
  res.locals.LIVRAISONS = LIVRAISONS;
  res.locals.REGLEMENTS = REGLEMENTS;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

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
  return { entites: e.rows, categories: c.rows };
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
  if (q.q) { params.push(`%${q.q}%`); where.push(`(o.libelle ILIKE $${params.length} OR o.tiers ILIKE $${params.length})`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const OPS_SELECT = `
  SELECT o.id, o.date_op, o.type, o.libelle, o.tiers, o.montant_ttc, o.tva, o.notes,
         o.justif_nom, o.entite_id, o.categorie_id, o.paiement, o.carte, o.livraison, o.reglement,
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
async function creerOperationsAuto(lotId) {
  const { rows: l } = await pool.query('SELECT auto, info, created_by FROM lots WHERE id=$1', [lotId]);
  if (!l[0] || !l[0].auto) return;
  const { entites, categories } = await refs();
  const { rows: deps } = await pool.query(
    "SELECT id, nom, mimetype, data, resultat FROM depots WHERE lot_id=$1 AND statut='a_valider' AND erreur IS NULL ORDER BY page, ordre", [lotId]);
  let crees = 0;
  for (const d of deps) {
    const r = d.resultat || {};
    if (!r.montant_ttc || !r.date) continue;
    const { rows: dbl } = await pool.query('SELECT 1 FROM operations WHERE montant_ttc=$1 AND date_op=$2 LIMIT 1', [r.montant_ttc, r.date]);
    if (dbl[0]) continue;
    const ent = entites.find((e) => e.nom === r.societe_nom);
    const cat = categories.find((c) => c.nom === r.categorie);
    const { rows: ins } = await pool.query(
      `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes, paiement, carte,
         justif_nom, justif_type, justif_data, created_by)
       VALUES ($1,$2,'depense',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [ent ? ent.id : null, r.date, cat ? cat.id : null, r.libelle || `Facture ${r.fournisseur || ''}`.trim(), r.fournisseur || null,
        r.montant_ttc, r.tva || 0, l[0].info, PAIEMENTS.includes(r.paiement) ? r.paiement : null, r.carte || null,
        d.nom, d.mimetype, d.data, l[0].created_by]);
    await fournisseurs.lierOperation(ins[0].id, r.fournisseur);
    await pool.query("UPDATE depots SET statut='enregistre', operation_id=$2 WHERE id=$1", [d.id, ins[0].id]);
    crees++;
  }
  if (crees) {
    await releves.rapprocher();
    fournisseurs.mettreAJour();
  }
  // Statut de l'e-mail d'origine.
  const { rows: reste } = await pool.query("SELECT COUNT(*)::int AS n FROM depots WHERE lot_id=$1 AND statut='a_valider'", [lotId]);
  await pool.query(`UPDATE emails_recus SET statut = CASE WHEN $2 > 0 THEN 'a_valider' ELSE 'traite' END
    WHERE $1 = ANY(lot_ids) AND statut IN ('en_cours','a_valider','traite')`, [lotId, reste[0].n]);
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
    const { rows: ex } = await pool.query(
      "SELECT nom, created_at FROM lots WHERE hash=$1 AND statut NOT IN ('erreur','interrompu') ORDER BY id LIMIT 1", [hash]);
    if (ex[0]) {
      const quand = ex[0].created_at.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
      dejaMis.push(`${f.originalname} (déjà déposé le ${quand}${ex[0].nom !== f.originalname ? ` sous le nom ${ex[0].nom}` : ''})`);
      continue;
    }
    const { rows } = await pool.query('INSERT INTO lots (nom, created_by, hash, data, mimetype) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [f.originalname, req.session.user.id, hash, f.buffer, f.mimetype]);
    ids.push(rows[0].id);
    mettreEnFile(rows[0].id, f, req.session.user.id);
  }
  const msgs = [];
  if (dejaMis.length) msgs.push(`Déjà mis, non retraité : ${dejaMis.join(' ; ')}.`);
  if (refuses.length) msgs.push(`Format non pris en charge (PDF ou photo) : ${refuses.map((f) => f.originalname).join(', ')}.`);
  // Appel depuis la zone de dépôt : on renvoie les lots, la fenêtre s'ouvre côté navigateur.
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
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM lots WHERE statut = 'en_cours'");
  res.json({ en_cours: rows[0].n });
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
  const cat = categories.find((c) => c.nom === r.categorie);
  const op = {
    date_op: r.date || new Date().toISOString().slice(0, 10),
    type: 'depense',
    entite_id: ent ? ent.id : null,
    categorie_id: cat ? cat.id : null,
    libelle: r.libelle || (r.fournisseur ? `Achat ${r.fournisseur}` : ''),
    tiers: r.fournisseur || '',
    montant_ttc: r.montant_ttc,
    tva: r.tva,
    paiement: r.paiement || '',
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
  res.render('operation_form', { op, depot: d, position, doublons, entites, categories });
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
  const statut = total <= 0 ? 'À régler' : total + 0.005 >= montantTtc ? 'Déjà réglé' : 'Partiellement réglé';
  await pool.query('UPDATE operations SET reglement=$1 WHERE id=$2', [statut, opId]);
}

function opValues(b) {
  return [
    b.entite_id === 'inconnue' ? null : Number(b.entite_id), b.date_op, b.type === 'recette' ? 'recette' : 'depense',
    b.categorie_id ? Number(b.categorie_id) : null, (b.libelle || '').trim(), (b.tiers || '').trim() || null,
    toNum(b.montant_ttc), toNum(b.tva), (b.notes || '').trim() || null,
    PAIEMENTS.includes(b.paiement) ? b.paiement : null, (b.carte || '').trim() || null,
    LIVRAISONS.includes(b.livraison) ? b.livraison : null,
    REGLEMENTS.includes(b.reglement) ? b.reglement : null,
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
  const { rows: ins } = await pool.query(
    `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes,
       paiement, carte, livraison, reglement, justif_nom, justif_type, justif_data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [...v, f ? f.nom : null, f ? f.type : null, f ? f.data : null, req.session.user.id]);
  const opId = ins[0].id;
  await fournisseurs.lierOperation(opId, v[5]);
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
       montant_ttc=$7, tva=$8, notes=$9, paiement=$10, carte=$11, livraison=$12, reglement=$13, updated_at=NOW() WHERE id=$14`, [...v, req.params.id]);
  if (v[5]) await fournisseurs.lierOperation(req.params.id, v[5]);
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
  const compte = comptes.find((c) => String(c.id) === String(req.query.compte)) || comptes.find((c) => c.a_rapprocher) || comptes[0];
  const filtre = ['tout', 'ecarts'].includes(req.query.filtre) ? req.query.filtre : 'a_faire';
  const { rows: lignes } = await pool.query(`
    SELECT l.*, o.libelle AS op_libelle, o.tiers AS op_tiers, o.date_op AS op_date, o.justif_nom AS op_justif,
      o.entite_id AS op_entite_id, o.paiement AS op_paiement,
      r.periode_debut AS rc_debut, r.periode_fin AS rc_fin,
      (SELECT COUNT(*) FROM lignes x WHERE x.releve_id = r.id)::int AS rc_nb
    FROM lignes l
    LEFT JOIN operations o ON o.id = l.operation_id
    LEFT JOIN releves r ON r.id = l.releve_carte_id
    WHERE l.compte_id = $1 ${filtre === 'a_faire' ? 'AND l.operation_id IS NULL AND l.releve_carte_id IS NULL AND NOT l.ignoree' : ''}
      ${filtre === 'ecarts' ? 'AND l.operation_id IS NOT NULL AND NOT l.ecart_accepte' : ''}
    ORDER BY l.date_op DESC, l.id DESC`, [compte.id]);
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
  // Nombre d'incohérences par compte (pour les onglets).
  for (const c of comptes) {
    const { rows: rr } = await pool.query(`SELECT o.entite_id, o.paiement FROM lignes l JOIN operations o ON o.id = l.operation_id
      WHERE l.compte_id = $1 AND NOT l.ecart_accepte`, [c.id]);
    c.nb_ecarts = rr.filter((o) => releves.ecarts(o, c, nomsEntites).length).length;
  }
  res.render('rapprochement', { comptes, compte, lignes: lignesAffichees, releves: rels, filtre, ...(await refs()) });
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
  await pool.query('UPDATE comptes SET entite_id=$1 WHERE id=$2', [Number(req.body.entite_id) || null, req.params.id]);
  await releves.rapprocher();
  res.redirect(`/rapprochement?compte=${req.params.id}`);
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
    `UPDATE fournisseurs SET type=$1, en_ligne=$2, url=$3, recuperation=$4, note=$5, modifie_main=TRUE WHERE id=$6`,
    [b.type === 'recurrent' ? 'recurrent' : 'ponctuel', b.en_ligne === '1',
      url, ['email', 'api', 'portail', 'non'].includes(b.recuperation) ? b.recuperation : null,
      (b.note || '').trim() || null, id]);
  flash(req, 'Fournisseur mis à jour.');
  res.redirect('/fournisseurs');
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
  res.render('boite', { mails, etat: boite.etat(), active: boite.active() });
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
  const lines = [['Société', 'Date', 'Type', 'Catégorie', 'Libellé', 'Tiers', 'Montant TTC', 'TVA', 'Montant HT', 'Paiement', 'Carte', 'Livraison', 'Règlement', 'Justificatif', 'Notes'].join(';')];
  for (const r of rows) {
    const d = r.date_op;
    const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    lines.push([r.entite || 'À déterminer', date, r.type === 'recette' ? 'Recette' : 'Dépense', r.categorie, r.libelle, r.tiers,
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

// ---------- administration ----------
app.get('/admin', requireAdmin, async (req, res) => {
  const { rows: users } = await pool.query('SELECT id, nom, email, is_admin, created_at FROM users ORDER BY nom');
  res.render('admin', { users, ...(await refs()) });
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

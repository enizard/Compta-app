const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const { pool, init } = require('./db');
const { analyser, decouperPdf, PAIEMENTS } = require('./analyse');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'public')));

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
  if (q.entite) { params.push(Number(q.entite)); where.push(`o.entite_id = $${params.length}`); }
  if (q.annee) { params.push(Number(q.annee)); where.push(`EXTRACT(YEAR FROM o.date_op) = $${params.length}`); }
  if (q.mois) { params.push(Number(q.mois)); where.push(`EXTRACT(MONTH FROM o.date_op) = $${params.length}`); }
  if (q.type === 'recette' || q.type === 'depense') { params.push(q.type); where.push(`o.type = $${params.length}`); }
  if (q.categorie) { params.push(Number(q.categorie)); where.push(`o.categorie_id = $${params.length}`); }
  if (q.q) { params.push(`%${q.q}%`); where.push(`(o.libelle ILIKE $${params.length} OR o.tiers ILIKE $${params.length})`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const OPS_SELECT = `
  SELECT o.id, o.date_op, o.type, o.libelle, o.tiers, o.montant_ttc, o.tva, o.notes,
         o.justif_nom, o.entite_id, o.categorie_id, o.paiement, o.carte,
         e.nom AS entite, c.nom AS categorie, u.nom AS auteur
  FROM operations o
  JOIN entites e ON e.id = o.entite_id
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
app.get('/', requireAuth, async (req, res) => {
  const { rows: lots } = await pool.query(`
    SELECT l.id, l.nom, l.statut, l.created_at,
      COUNT(d.id) FILTER (WHERE d.statut = 'a_valider')::int AS restants
    FROM lots l LEFT JOIN depots d ON d.lot_id = l.id
    GROUP BY l.id HAVING l.statut = 'en_cours' OR COUNT(d.id) FILTER (WHERE d.statut = 'a_valider') > 0
    ORDER BY l.id DESC`);
  res.render('depot', { iaActive: !!process.env.ANTHROPIC_API_KEY, lots });
});

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

app.post('/depot', requireAuth, upload.single('fichier'), async (req, res) => {
  const f = req.file;
  if (!f) { flash(req, 'Aucun fichier reçu.', 'err'); return res.redirect('/'); }
  if (!/^image\/|^application\/pdf$/.test(f.mimetype)) { flash(req, 'Format non pris en charge (PDF ou photo).', 'err'); return res.redirect('/'); }
  const { rows } = await pool.query('INSERT INTO lots (nom, created_by) VALUES ($1,$2) RETURNING id',
    [f.originalname, req.session.user.id]);
  traiterLot(rows[0].id, f, req.session.user.id); // sans await : tourne en arrière-plan
  res.redirect(`/lot/${rows[0].id}`);
});

async function etatLot(id) {
  const { rows } = await pool.query('SELECT * FROM lots WHERE id=$1', [id]);
  if (!rows[0]) return null;
  const { rows: depots } = await pool.query(
    `SELECT id, page, ordre, statut, erreur, resultat->>'fournisseur' AS fournisseur,
       resultat->>'montant_ttc' AS montant_ttc, resultat->>'date' AS date
     FROM depots WHERE lot_id=$1 ORDER BY page, ordre`, [id]);
  return { lot: rows[0], depots };
}

app.get('/lot/:id', requireAuth, async (req, res) => {
  const e = await etatLot(req.params.id);
  if (!e) return res.redirect('/');
  const aValider = e.depots.filter((d) => d.statut === 'a_valider');
  // Un seul ticket et traitement terminé : on va directement au formulaire.
  if (e.lot.statut === 'termine' && e.depots.length === 1 && aValider.length === 1 && !req.query.liste) {
    return res.redirect(`/depot/${aValider[0].id}`);
  }
  res.render('lot', { ...e, aValider });
});

app.get('/lot/:id/etat.json', requireAuth, async (req, res) => {
  const e = await etatLot(req.params.id);
  if (!e) return res.status(404).json({});
  res.json({ statut: e.lot.statut, total: e.lot.total_pages, faites: e.lot.pages_traitees, tickets: e.depots.length });
});

app.get('/depot/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, lot_id, page, nom, mimetype, resultat, erreur, statut FROM depots WHERE id=$1', [req.params.id]);
  const d = rows[0];
  if (!d) return res.redirect('/');
  if (d.statut !== 'a_valider') return res.redirect(d.lot_id ? `/lot/${d.lot_id}?liste=1` : '/');
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
  res.render('operation_form', { op, depot: d, position, entites, categories });
});

app.get('/depot/:id/fichier', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT nom, mimetype, data FROM depots WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Introuvable');
  res.set('Content-Type', rows[0].mimetype);
  res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].nom)}`);
  res.send(rows[0].data);
});

async function prochainDepot(depotId) {
  const { rows } = await pool.query(
    `SELECT d2.id, d1.lot_id FROM depots d1
     LEFT JOIN depots d2 ON d2.lot_id = d1.lot_id AND d2.statut = 'a_valider'
     WHERE d1.id = $1 ORDER BY d2.page, d2.ordre LIMIT 1`, [depotId]);
  if (!rows[0] || !rows[0].lot_id) return '/';
  return rows[0].id ? `/depot/${rows[0].id}` : `/lot/${rows[0].lot_id}?liste=1`;
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
  res.render('operations', { ops: rows, tot, q, qs, annees: annees.map((x) => x.a), ...(await refs()) });
});

app.get('/operations/new', requireAuth, async (req, res) => {
  res.render('operation_form', {
    op: { date_op: new Date().toISOString().slice(0, 10), type: 'depense', entite_id: Number(req.query.entite) || null },
    ...(await refs()),
  });
});

function opValues(b) {
  return [
    Number(b.entite_id), b.date_op, b.type === 'recette' ? 'recette' : 'depense',
    b.categorie_id ? Number(b.categorie_id) : null, (b.libelle || '').trim(), (b.tiers || '').trim() || null,
    toNum(b.montant_ttc), toNum(b.tva), (b.notes || '').trim() || null,
    PAIEMENTS.includes(b.paiement) ? b.paiement : null, (b.carte || '').trim() || null,
  ];
}

function validOp(v) {
  return v[0] && v[1] && v[4] && !Number.isNaN(v[6]) && !Number.isNaN(v[7]);
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
  await pool.query(
    `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes,
       paiement, carte, justif_nom, justif_type, justif_data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [...v, f ? f.nom : null, f ? f.type : null, f ? f.data : null, req.session.user.id]);
  flash(req, 'Opération enregistrée.');
  if (depotId) {
    await pool.query("UPDATE depots SET statut='enregistre' WHERE id=$1", [depotId]);
    return res.redirect(await prochainDepot(depotId));
  }
  res.redirect(req.body.encore ? `/operations/new?entite=${v[0]}` : '/operations');
});

app.get('/operations/:id/edit', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`${OPS_SELECT} WHERE o.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).send('Introuvable');
  const op = rows[0];
  op.date_op = new Date(op.date_op.getTime() - op.date_op.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  res.render('operation_form', { op, ...(await refs()) });
});

app.post('/operations/:id', requireAuth, upload.single('justificatif'), async (req, res) => {
  const v = opValues(req.body);
  if (!validOp(v)) { flash(req, 'Champs obligatoires manquants ou montant invalide.', 'err'); return res.redirect(`/operations/${req.params.id}/edit`); }
  await pool.query(
    `UPDATE operations SET entite_id=$1, date_op=$2, type=$3, categorie_id=$4, libelle=$5, tiers=$6,
       montant_ttc=$7, tva=$8, notes=$9, paiement=$10, carte=$11, updated_at=NOW() WHERE id=$12`, [...v, req.params.id]);
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

// ---------- export CSV (pour l'expert-comptable) ----------
app.get('/export.csv', requireAuth, async (req, res) => {
  const { sql, params } = buildFilters(req.query);
  const { rows } = await pool.query(`${OPS_SELECT} ${sql} ORDER BY e.nom, o.date_op, o.id`, params);
  const esc = (s) => {
    const t = s === null || s === undefined ? '' : String(s);
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const num = (n) => Number(n).toFixed(2).replace('.', ',');
  const lines = [['Société', 'Date', 'Type', 'Catégorie', 'Libellé', 'Tiers', 'Montant TTC', 'TVA', 'Montant HT', 'Paiement', 'Carte', 'Justificatif', 'Notes'].join(';')];
  for (const r of rows) {
    const d = r.date_op;
    const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    lines.push([r.entite, date, r.type === 'recette' ? 'Recette' : 'Dépense', r.categorie, r.libelle, r.tiers,
      num(r.montant_ttc), num(r.tva), num(r.montant_ttc - r.tva), r.paiement, r.carte, r.justif_nom ? 'oui' : 'non', r.notes].map(esc).join(';'));
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

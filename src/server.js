const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool, init } = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-a-changer',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

// ---------- helpers ----------
const fmt = (n) => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toNum = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  return Number(String(v).replace(/\s/g, '').replace(',', '.'));
};

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.fmt = fmt;
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
         o.justif_nom, o.entite_id, o.categorie_id,
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
app.get('/', requireAuth, (req, res) => res.redirect('/operations'));

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
  ];
}

function validOp(v) {
  return v[0] && v[1] && v[4] && !Number.isNaN(v[6]) && !Number.isNaN(v[7]);
}

app.post('/operations', requireAuth, upload.single('justificatif'), async (req, res) => {
  const v = opValues(req.body);
  if (!validOp(v)) { flash(req, 'Champs obligatoires manquants ou montant invalide.', 'err'); return res.redirect('/operations/new'); }
  const f = req.file;
  await pool.query(
    `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes,
       justif_nom, justif_type, justif_data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [...v, f ? f.originalname : null, f ? f.mimetype : null, f ? f.buffer : null, req.session.user.id]);
  flash(req, 'Opération enregistrée.');
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
       montant_ttc=$7, tva=$8, notes=$9, updated_at=NOW() WHERE id=$10`, [...v, req.params.id]);
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
  const lines = [['Société', 'Date', 'Type', 'Catégorie', 'Libellé', 'Tiers', 'Montant TTC', 'TVA', 'Montant HT', 'Justificatif', 'Notes'].join(';')];
  for (const r of rows) {
    const d = r.date_op;
    const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    lines.push([r.entite, date, r.type === 'recette' ? 'Recette' : 'Dépense', r.categorie, r.libelle, r.tiers,
      num(r.montant_ttc), num(r.tva), num(r.montant_ttc - r.tva), r.justif_nom ? 'oui' : 'non', r.notes].map(esc).join(';'));
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

const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log(`compta-app sur le port ${port}`)))
  .catch((e) => { console.error('Init DB échouée', e); process.exit(1); });

// Relève automatique de la boîte « factures » (IMAP) : chaque e-mail reçu devient un dépôt,
// traité et enregistré automatiquement.
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { pool } = require('./db');

const config = () => ({
  host: process.env.FACTURES_IMAP_HOST || 'imap.gmail.com',
  port: Number(process.env.FACTURES_IMAP_PORT) || 993,
  secure: process.env.FACTURES_IMAP_SECURE !== 'non',
  user: process.env.FACTURES_IMAP_USER,
  pass: process.env.FACTURES_IMAP_PASSWORD,
});
const active = () => !!(config().user && config().pass);

let enCours = false;
let dernier = { quand: null, erreur: null, nouveaux: 0 };

// E-mail de confirmation de transfert Gmail : on extrait le code et le lien pour les afficher.
function confirmationGmail(mail) {
  const sujet = mail.subject || '';
  if (!/forwarding confirmation|confirmation de transfert|transfert gmail/i.test(sujet + ' ' + (mail.text || '').slice(0, 300))) return null;
  const code = (sujet.match(/#(\d{6,})/) || (mail.text || '').match(/(?:code|confirmation)[^\d]{0,40}(\d{6,})/i) || [])[1] || null;
  const lien = ((mail.text || '').match(/https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s<>"]+/) || [])[0] || null;
  return { code, lien };
}

async function relever(deps) {
  if (!active() || enCours) return dernier;
  enCours = true;
  let nouveaux = 0;
  const client = new ImapFlow({ host: config().host, port: config().port, secure: config().secure, auth: { user: config().user, pass: config().pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const depuis = new Date(Date.now() - 45 * 24 * 3600 * 1000);
      const uids = await client.search({ since: depuis }, { uid: true });
      for (const uid of uids || []) {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const mid = mail.messageId || `uid-${uid}-${crypto.createHash('sha1').update(msg.source).digest('hex')}`;
        const { rows: deja } = await pool.query('SELECT 1 FROM emails_recus WHERE message_id=$1', [mid]);
        if (deja[0]) continue;
        nouveaux++;
        await traiterMail(mail, mid, deps);
      }
    } finally {
      lock.release();
    }
    await client.logout();
    dernier = { quand: new Date(), erreur: null, nouveaux };
  } catch (e) {
    console.error('Boîte factures :', e.message);
    dernier = { quand: new Date(), erreur: e.message, nouveaux };
    try { await client.logout(); } catch (_) { /* rien */ }
  } finally {
    enCours = false;
  }
  return dernier;
}

async function traiterMail(mail, mid, deps) {
  const de = mail.from ? mail.from.text : '';
  const sujet = mail.subject || '(sans objet)';
  const recu = mail.date || new Date();
  const conf = confirmationGmail(mail);
  if (conf) {
    await pool.query(
      `INSERT INTO emails_recus (message_id, de, sujet, recu_le, statut, info) VALUES ($1,$2,$3,$4,'confirmation',$5)`,
      [mid, de, sujet, recu, JSON.stringify(conf)]);
    return;
  }
  // Pièces jointes exploitables (PDF, images). Sinon, le contenu de l'e-mail lui-même sert de facture.
  const pj = (mail.attachments || []).filter((a) => /^application\/pdf$|^image\/(jpeg|png|webp|heic)/i.test(a.contentType)
    && !(a.contentDisposition === 'inline' && /^image\//.test(a.contentType) && a.size < 30000));
  const fichiers = pj.length ? pj.map((a) => ({ originalname: a.filename || 'piece-jointe', mimetype: a.contentType.toLowerCase(), buffer: a.content }))
    : [{ originalname: `${sujet.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.html`, mimetype: 'text/html',
      buffer: Buffer.from(`<!DOCTYPE html><meta charset="utf-8"><p><b>De :</b> ${escape(de)}<br><b>Objet :</b> ${escape(sujet)}<br><b>Date :</b> ${recu.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</p><hr>${mail.html || `<pre>${escape(mail.text || '')}</pre>`}`) }];
  const lots = [];
  for (const f of fichiers) {
    const hash = crypto.createHash('sha256').update(f.buffer).digest('hex');
    const { rows: ex } = await pool.query("SELECT id FROM lots WHERE hash=$1 AND statut NOT IN ('erreur','interrompu') LIMIT 1", [hash]);
    if (ex[0]) continue;
    const { rows } = await pool.query(
      `INSERT INTO lots (nom, created_by, hash, data, mimetype, source, auto, info)
       VALUES ($1, (SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1), $2, $3, $4, 'email', TRUE, $5) RETURNING id, created_by`,
      [f.originalname, hash, f.buffer, f.mimetype, `Reçue par e-mail de ${de} : « ${sujet} »`]);
    lots.push(rows[0].id);
    deps.mettreEnFile(rows[0].id, f, rows[0].created_by);
  }
  await pool.query(
    `INSERT INTO emails_recus (message_id, de, sujet, recu_le, statut, nb_pj, lot_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [mid, de, sujet, recu, lots.length ? 'en_cours' : 'deja_mis', pj.length, lots]);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function demarrer(deps) {
  if (!active()) return;
  const tour = () => relever(deps).catch((e) => console.error('Boîte factures :', e.message));
  setTimeout(tour, 15 * 1000);
  setInterval(tour, 10 * 60 * 1000);
}

module.exports = { relever, demarrer, active, etat: () => ({ ...dernier, enCours, adresse: config().user }) };

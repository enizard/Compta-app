// Analyse de factures / tickets de caisse via l'API Claude (vision + écriture manuscrite).
// Un document peut contenir plusieurs tickets (scan multi-pages, plusieurs tickets par page).
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SOCIETES = { LMF: 'LMF', SAN: 'Simple and New', BMG: 'BMG', SCI: 'SCI E NIZARD' };
const PAIEMENTS = ['CB CIC', 'AMEX', 'Avance CC', 'Autre'];

function prompt(categories) {
  return `Cette image (ou page PDF) contient une ou plusieurs factures d'achat ou tickets de caisse français.
Pour CHAQUE facture ou ticket distinct visible, extrais les informations. Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{ "documents": [
  {
    "fournisseur": string|null,        // nom du commerçant / fournisseur
    "date": "AAAA-MM-JJ"|null,         // date de la facture ou du ticket
    "montant_ttc": number|null,        // total TTC payé
    "tva": number|null,                // montant total de TVA (somme des taux)
    "montant_ht": number|null,         // total HT
    "carte": string|null,              // carte utilisée telle qu'imprimée (ex. "VISA **** 1234", "AMEX"), sinon null
    "societe": "LMF"|"SAN"|"BMG"|"SCI"|null,
    "paiement": "CB CIC"|"AMEX"|"Avance CC"|"Autre"|null,
    "categorie": string|null,          // une valeur EXACTE de cette liste : ${JSON.stringify(categories)}
    "libelle": string|null,            // description courte de l'achat (ex. "Fournitures de bureau")
    "position": string|null,           // où se trouve ce ticket sur la page s'il y en a plusieurs (ex. "en haut à gauche")
    "mentions_manuscrites": string|null, // tout texte écrit à la main sur ce ticket, recopié tel quel
    "confiance": "haute"|"moyenne"|"basse"
  }
] }
Si la page est vide ou ne contient aucun ticket/facture, renvoie { "documents": [] }.
Une facture de plusieurs pages ne compte qu'une fois (ne renvoie rien pour une page de suite sans total).
Règles pour les mentions MANUSCRITES (écrites au stylo sur le ticket) :
- Société : "LMF" → "LMF" ; "SAN" ou "Simple and New" → "SAN" ; "BMG" → "BMG" ; "SCI" ou "SCI E NIZARD" ou "Nizard" → "SCI".
- Paiement : "Avance CC" ou "CC" (avance en compte courant) → "Avance CC" ; "CB CIC" ou "CIC" → "CB CIC" ; "AMEX" → "AMEX".
- Si aucune mention manuscrite de paiement : déduis-le de la carte imprimée (American Express → "AMEX"), sinon null.
Montants : nombres décimaux avec un point (ex. 12.5). Si HT ou TVA manquent mais que l'autre et le TTC sont connus, calcule-les.`;
}

async function toContentBlock(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  // Photos : on réduit (limite API ~5 Mo) et on redresse selon l'EXIF.
  const jpeg = await sharp(buffer).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse illisible');
  return JSON.parse(m[0]);
}

function normaliser(r, categories) {
  const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  r.montant_ttc = n(r.montant_ttc); r.tva = n(r.tva); r.montant_ht = n(r.montant_ht);
  if (r.montant_ttc !== null && r.tva === null && r.montant_ht !== null) r.tva = +(r.montant_ttc - r.montant_ht).toFixed(2);
  if (r.montant_ttc !== null && r.montant_ht === null && r.tva !== null) r.montant_ht = +(r.montant_ttc - r.tva).toFixed(2);
  r.societe_nom = r.societe ? SOCIETES[r.societe] || null : null;
  if (!PAIEMENTS.includes(r.paiement)) r.paiement = null;
  if (r.categorie && !categories.includes(r.categorie)) r.categorie = null;
  return r;
}

// Analyse une image ou une page PDF ; renvoie la liste des tickets trouvés.
async function analyser(buffer, mimetype, categories) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Clé ANTHROPIC_API_KEY non configurée');
  const block = await toContentBlock(buffer, mimetype);
  let res;
  for (let essai = 0; essai < 3; essai++) {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: [block, { type: 'text', text: prompt(categories) }] }],
      }),
    });
    if (res.ok || ![429, 500, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 3000 * (essai + 1)));
  }
  if (!res.ok) throw new Error(`API Claude ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const out = parseJson(text);
  const docs = Array.isArray(out.documents) ? out.documents : [out];
  return docs.map((d) => normaliser(d, categories));
}

// Découpe un PDF en pages individuelles (chaque page devient un PDF d'une page).
async function decouperPdf(buffer) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pages = [];
  for (let i = 0; i < src.getPageCount(); i++) {
    const doc = await PDFDocument.create();
    const [p] = await doc.copyPages(src, [i]);
    doc.addPage(p);
    pages.push(Buffer.from(await doc.save()));
  }
  return pages;
}

module.exports = { analyser, decouperPdf, PAIEMENTS };

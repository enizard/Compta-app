// Analyse d'une facture / ticket de caisse via l'API Claude (vision + écriture manuscrite).
const sharp = require('sharp');

const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SOCIETES = { LMF: 'LMF', SAN: 'Simple and New', BMG: 'BMG', SCI: 'SCI E NIZARD' };
const PAIEMENTS = ['CB CIC', 'AMEX', 'Avance CC', 'Autre'];

function prompt(categories) {
  return `Tu analyses une facture d'achat ou un ticket de caisse français (photo ou PDF).
Extrais les informations et réponds UNIQUEMENT avec un objet JSON, sans texte autour :
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
  "mentions_manuscrites": string|null, // tout texte écrit à la main, recopié tel quel
  "confiance": "haute"|"moyenne"|"basse"
}
Règles pour les mentions MANUSCRITES (écrites au stylo sur le document) :
- Société : "LMF" → "LMF" ; "SAN" ou "Simple and New" → "SAN" ; "BMG" → "BMG" ; "SCI" ou "SCI E NIZARD" ou "Nizard" → "SCI".
- Paiement : "Avance CC" ou "CC" (avance en compte courant) → "Avance CC" ; "CB CIC" ou "CIC" → "CB CIC" ; "AMEX" → "AMEX".
- Si aucune mention manuscrite de paiement : déduis-le de la carte imprimée (American Express → "AMEX"), sinon null.
Montants : nombres décimaux avec un point (ex. 12.5). Si HT ou TVA manquent mais que l'autre et le TTC sont connus, calcule-les.`;
}

async function toContentBlock(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  // Photos de téléphone : on réduit (limite API ~5 Mo) et on redresse selon l'EXIF.
  const jpeg = await sharp(buffer).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse illisible');
  return JSON.parse(m[0]);
}

async function analyser(buffer, mimetype, categories) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Clé ANTHROPIC_API_KEY non configurée');
  const block = await toContentBlock(buffer, mimetype);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: [block, { type: 'text', text: prompt(categories) }] }],
    }),
  });
  if (!res.ok) throw new Error(`API Claude ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const r = parseJson(text);

  const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  r.montant_ttc = n(r.montant_ttc); r.tva = n(r.tva); r.montant_ht = n(r.montant_ht);
  if (r.montant_ttc !== null && r.tva === null && r.montant_ht !== null) r.tva = +(r.montant_ttc - r.montant_ht).toFixed(2);
  if (r.montant_ttc !== null && r.montant_ht === null && r.tva !== null) r.montant_ht = +(r.montant_ttc - r.tva).toFixed(2);
  r.societe_nom = r.societe ? SOCIETES[r.societe] || null : null;
  if (!PAIEMENTS.includes(r.paiement)) r.paiement = null;
  if (r.categorie && !categories.includes(r.categorie)) r.categorie = null;
  return r;
}

module.exports = { analyser, PAIEMENTS };

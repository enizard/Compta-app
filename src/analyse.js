// Analyse de factures / tickets de caisse via l'API Claude (vision + écriture manuscrite).
// Un document peut contenir plusieurs tickets (scan multi-pages, plusieurs tickets par page).
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SOCIETES = { LMF: 'LMF', SAN: 'Simple and New', BMG: 'BMG', SCI: 'SCI E NIZARD' };
const PAIEMENTS = ['CB CIC', 'AMEX', 'Avance CC', 'Virement / prélèvement', 'Autre'];

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

async function appel(block, texte, maxTokens = 4096) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Clé ANTHROPIC_API_KEY non configurée');
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
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [block, { type: 'text', text: texte }] }],
      }),
    });
    if (res.ok || ![429, 500, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 3000 * (essai + 1)));
  }
  if (!res.ok) throw new Error(`API Claude ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return parseJson((data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
}

// Analyse une image ou une page PDF ; renvoie la liste des tickets trouvés.
async function analyser(buffer, mimetype, categories) {
  const out = await appel(await toContentBlock(buffer, mimetype), prompt(categories));
  const docs = Array.isArray(out.documents) ? out.documents : [out];
  return docs.map((d) => normaliser(d, categories));
}

// ---------- Relevés bancaires / de carte ----------

const PROMPT_CLASSER = `Regarde ce document (première page) et dis de quoi il s'agit. Réponds UNIQUEMENT en JSON :
{
  "nature": "tickets" | "releve_compte" | "releve_carte",
  "banque": "CIC" | "AMEX" | "AUTRE" | null,
  "societe": "LMF" | "SAN" | "BMG" | "SCI" | null,
  "titulaire": string|null,
  "numero": string|null,
  "periode_debut": "AAAA-MM-JJ"|null,
  "periode_fin": "AAAA-MM-JJ"|null,
  "solde_debut": number|null,
  "solde_fin": number|null
}
- "tickets" : facture d'achat, ticket de caisse, ou scan de plusieurs tickets.
- "releve_compte" : relevé / extrait de compte bancaire (liste de mouvements débit/crédit d'un compte courant).
- "releve_carte" : relevé des opérations d'une carte de paiement (détail des paiements carte d'un mois, carte CIC à débit différé, ou relevé American Express).
- banque : "AMEX" pour tout relevé American Express (y compris carte American Express distribuée par le CIC) ; "CIC" pour CIC / Crédit Mutuel-CIC.
- societe : d'après le titulaire / la raison sociale : "LMF" ; "SAN" = Simple and New ; "BMG" ; "SCI" = SCI E NIZARD.
- numero : les 4 derniers chiffres du numéro de compte ou de carte, sinon null.
- soldes : relevés de compte uniquement (solde créditeur positif, débiteur négatif).`;

function promptLignes(ctx, categories) {
  return `Cette page fait partie d'un ${ctx.nature === 'releve_carte' ? 'relevé des opérations de carte' : 'relevé de compte bancaire'} ${ctx.banque || ''}` +
    `${ctx.periode_debut ? ` couvrant la période du ${ctx.periode_debut} au ${ctx.periode_fin}` : ''}.
Extrais TOUTES les lignes de mouvement de cette page. Réponds UNIQUEMENT en JSON :
{ "lignes": [ {
  "date": "AAAA-MM-JJ",       // date de l'opération (déduis l'année de la période du relevé)
  "libelle": string,          // libellé complet tel qu'imprimé (lignes de détail regroupées)
  "montant": number,          // NÉGATIF pour un débit / paiement, POSITIF pour un crédit / remboursement
  "total_carte": "CB CIC" | "AMEX" | null,
  "categorie": string|null    // une valeur EXACTE de : ${JSON.stringify(categories)}, ou null
} ] }
- N'inclus PAS les lignes de solde (ancien/nouveau solde), de totaux de colonnes, de report, ni les sous-totaux.
- "total_carte" : uniquement pour une ligne de RELEVÉ DE COMPTE qui est le débit global mensuel d'une carte` +
  ` (ex. "FACTURE CARTE", "FACTURES CARTES DU …", "CARTE X1234 DEBIT DIFFERE" → "CB CIC" ; prélèvement "AMERICAN EXPRESS" → "AMEX"). Sinon null.
- Montants : nombres décimaux avec un point. Si la page ne contient aucune ligne, renvoie { "lignes": [] }.`;
}

async function classer(buffer, mimetype) {
  const r = await appel(await toContentBlock(buffer, mimetype), PROMPT_CLASSER, 1024);
  if (!['tickets', 'releve_compte', 'releve_carte'].includes(r.nature)) r.nature = 'tickets';
  r.societe_nom = r.societe ? SOCIETES[r.societe] || null : null;
  return r;
}

async function extraireLignes(buffer, mimetype, ctx, categories) {
  const out = await appel(await toContentBlock(buffer, mimetype), promptLignes(ctx, categories), 16000);
  return (Array.isArray(out.lignes) ? out.lignes : [])
    .filter((l) => l && l.date && l.libelle && l.montant !== null && !Number.isNaN(Number(l.montant)))
    .map((l) => ({
      date: l.date,
      libelle: String(l.libelle).trim(),
      montant: Number(l.montant),
      total_carte: ['CB CIC', 'AMEX'].includes(l.total_carte) ? l.total_carte : null,
      categorie: categories.includes(l.categorie) ? l.categorie : null,
    }));
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

module.exports = { analyser, classer, extraireLignes, decouperPdf, PAIEMENTS, SOCIETES };

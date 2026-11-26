// Analyse de factures / tickets de caisse via l'API Claude (vision + écriture manuscrite).
// Un document peut contenir plusieurs tickets (scan multi-pages, plusieurs tickets par page).
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const API_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SOCIETES = { LMF: 'LMF', SAN: 'Simple and New', BMG: 'BMG', SCI: 'SCI E NIZARD' };
const PAIEMENTS = ['CB CIC', 'AMEX', 'Avance CC', 'Virement / prélèvement CIC', 'Autre'];

function prompt(categories) {
  return `Cette image (ou page PDF) contient une ou plusieurs factures d'achat ou tickets de caisse français.
Pour CHAQUE facture ou ticket distinct visible, extrais les informations. Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{ "documents": [
  {
    "sens": "achat"|"vente",           // "vente" si le document est une facture ÉMISE par l'une de nos sociétés (émetteur / en-tête / mentions légales :
                                       // Simple and New, LMF, BMG ou SCI E NIZARD) à destination d'un client ; sinon "achat"
    "fournisseur": string|null,        // nom du commerçant / fournisseur ; pour une VENTE : nom du CLIENT destinataire
    "date": "AAAA-MM-JJ"|null,         // date de la facture ou du ticket
    "montant_ttc": number|null,        // total TTC payé
    "tva": number|null,                // montant total de TVA (somme des taux)
    "montant_ht": number|null,         // total HT
    "carte": string|null,              // carte utilisée telle qu'imprimée (ex. "VISA **** 1234", "AMEX"), sinon null
    "societe": "LMF"|"SAN"|"BMG"|"SCI"|null, // pour une VENTE : la société émettrice
    "paiement": "CB CIC"|"AMEX"|"Avance CC"|"Autre"|null,
    "categorie": string|null,          // une valeur EXACTE de cette liste : ${JSON.stringify(categories)}
    "libelle": string|null,            // description courte de l'achat (ex. "Fournitures de bureau")
    "type_document": "facture" | "ticket" | "facturette" | "recu",
      // facture = facture d'achat (invoice) ; ticket = ticket de caisse détaillé ;
      // facturette = petit ticket du terminal de carte bancaire (« CARTE BANCAIRE », « TICKET CLIENT », montant, n° de carte masqué, sans détail d'articles) ;
      // recu = reçu / confirmation de paiement émis par le fournisseur (« Receipt », « Payment receipt », « Reçu de paiement »)
    "numero_facture": string|null,     // numéro du document tel qu'imprimé : n° de facture (« Facture n° », « Invoice number », « Réf. »),
                                       // n° de ticket ou de transaction pour un ticket / une facturette, n° de facture rappelé sur un reçu ; null si absent
    "montant_paye": number|null,       // montant effectivement débité si différent du total (crédit, avoir, solde appliqué)
    "position": string|null,           // où se trouve ce ticket sur la page s'il y en a plusieurs (ex. "en haut à gauche")
    "mentions_manuscrites": string|null, // tout texte écrit à la main sur ce ticket, recopié tel quel
    "confiance": "haute"|"moyenne"|"basse"
  }
] }
Si la page est vide ou ne contient aucun ticket/facture, renvoie { "documents": [] }.
Une facture de plusieurs pages ne compte qu'une fois (ne renvoie rien pour une page de suite sans total).
Règle pour "societe" (achat) : la société DESTINATAIRE imprimée sur le document — « Facturé à », « Bill to », « Client »,
« Billed to », « Sold to », adresse ou raison sociale de facturation, n° de TVA du client. Simple and New / SIMPLE AND NEW SAS → "SAN" ;
LMF → "LMF" ; BMG → "BMG" ; SCI E NIZARD → "SCI". Une mention manuscrite de société, si présente, prime sur l'imprimé.
Règles pour les mentions MANUSCRITES (écrites au stylo sur le document — ticket, facturette CB, facture ou reçu ; regarde aussi les marges et le verso visible) :
- Société : "LMF" → "LMF" ; "SAN" ou "Simple and New" → "SAN" ; "BMG" → "BMG" ; "SCI" ou "SCI E NIZARD" ou "Nizard" → "SCI".
- Paiement : "Avance CC" ou "CC" (avance en compte courant) → "Avance CC" ; "CB CIC" ou "CIC" → "CB CIC" ; "AMEX" → "AMEX".
- Si aucune mention manuscrite de paiement : déduis-le de la carte imprimée (American Express → "AMEX"), sinon null.
Montants : nombres décimaux avec un point (ex. 12.5). Si HT ou TVA manquent mais que l'autre et le TTC sont connus, calcule-les.`;
}

function htmlEnTexte(html) {
  return html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function toContentBlock(buffer, mimetype) {
  if (/^text\//.test(mimetype)) {
    const texte = mimetype === 'text/html' ? htmlEnTexte(buffer.toString('utf8')) : buffer.toString('utf8');
    return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: texte.slice(0, 100000) } };
  }
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
  const content = block ? [block, { type: 'text', text: texte }] : [{ type: 'text', text: texte }];
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
        messages: [{ role: 'user', content }],
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
- "tickets" : facture d'achat, ticket de caisse, facturette de carte bancaire, reçu de paiement, ou scan de plusieurs de ces documents.
- "releve_compte" : relevé / extrait de compte bancaire (liste de mouvements débit/crédit d'un compte courant).
- "releve_carte" : relevé des opérations d'une carte de paiement (détail des paiements carte d'un mois, carte CIC à débit différé, ou relevé American Express).
- banque : "AMEX" pour tout relevé American Express (y compris carte American Express distribuée par le CIC) ; "CIC" pour CIC / Crédit Mutuel-CIC.
- societe : d'après le titulaire / la raison sociale : "LMF" ; "SAN" = Simple and New ; "BMG" ; "SCI" = SCI E NIZARD.
- numero : les 4 derniers chiffres du numéro de compte ou de carte, sinon null.
- soldes : relevés de compte uniquement (solde créditeur positif, débiteur négatif).`;

function promptLignes(ctx, categories) {
  return `Cette page fait partie d'un ${ctx.nature === 'releve_carte' ? 'relevé des opérations de carte' : 'relevé de compte bancaire'} ${ctx.banque || ''}` +
    `${ctx.periode_debut ? ` couvrant la période du ${ctx.periode_debut} au ${ctx.periode_fin}` : ''}.` +
    `${ctx.sectionPrecedente === 'carte' ? `\nLa page précédente se terminait DANS une section de détail des opérations carte${ctx.carteNumero ? ` (carte ${ctx.carteNumero})` : ''} : si cette page commence par des lignes de commerçants, elles en font partie.` : ''}
Extrais TOUTES les lignes de mouvement de cette page. Réponds UNIQUEMENT en JSON :
{ "lignes": [ {
  "date": "AAAA-MM-JJ",       // date de l'opération (déduis l'année de la période du relevé)
  "libelle": string,          // libellé complet tel qu'imprimé (lignes de détail regroupées)
  "montant": number,          // NÉGATIF pour un débit / paiement, POSITIF pour un crédit / remboursement
  "section": "compte" | "carte",
  "carte_numero": string|null,
  "fournisseur": string|null, // nom commercial court et normalisé du tiers (ex. "Orange", "OVH", "Amazon", "G7", "DGFIP", "SNCF"), null pour un virement interne / la ligne RELEVE CARTE
  "total_carte": "CB CIC" | "AMEX" | null,
  "categorie": string|null    // une valeur EXACTE de : ${JSON.stringify(categories)}, ou null
} ],
  "fin_de_page_section": "compte" | "carte" }
IMPORTANT — détail de carte à débit différé : un extrait de compte CIC contient souvent, après les mouvements du compte,` +
  ` une section de DÉTAIL des paiements d'une carte (titres du type "Détail des opérations carte", "Relevé carte n°…",` +
  ` "Carte n° XXXX", "Opérations carte du … au …"). Ces paiements ne sont PAS débités un par un sur le compte :` +
  ` leur total est débité en une seule ligne du compte ("RELEVE CARTE …", "FACTURE CARTE …").
- Ligne de mouvement du compte (virements, prélèvements, frais, la ligne "RELEVE CARTE" elle-même…) → "section": "compte".
- Ligne de la section de détail carte → "section": "carte", "carte_numero" = numéro de carte ou de relevé carte indiqué dans le titre de la section (chiffres visibles), sinon null.
- Pour un relevé de carte (y compris AMEX), toutes les lignes sont "section": "carte".
- "fin_de_page_section" : la section dans laquelle se termine la page.
- N'inclus PAS les lignes de solde (ancien/nouveau solde), de totaux de colonnes ou de section, de report, ni les sous-totaux.
- "total_carte" : uniquement pour une ligne "section": "compte" qui est le débit global d'une carte` +
  ` (ex. "RELEVE CARTE …", "FACTURE CARTE …", "CARTE X1234 DEBIT DIFFERE" → "CB CIC" ; prélèvement "AMERICAN EXPRESS" → "AMEX"). Sinon null.
- Montants : nombres décimaux avec un point. Si la page ne contient aucune ligne, renvoie { "lignes": [], "fin_de_page_section": "compte" }.`;
}

async function classer(buffer, mimetype) {
  const r = await appel(await toContentBlock(buffer, mimetype), PROMPT_CLASSER, 1024);
  if (!['tickets', 'releve_compte', 'releve_carte'].includes(r.nature)) r.nature = 'tickets';
  r.societe_nom = r.societe ? SOCIETES[r.societe] || null : null;
  return r;
}

async function extraireLignes(buffer, mimetype, ctx, categories) {
  const out = await appel(await toContentBlock(buffer, mimetype), promptLignes(ctx, categories), 16000);
  const lignes = (Array.isArray(out.lignes) ? out.lignes : [])
    .filter((l) => l && l.date && l.libelle && l.montant !== null && !Number.isNaN(Number(l.montant)))
    .map((l) => ({
      date: l.date,
      libelle: String(l.libelle).trim(),
      montant: Number(l.montant),
      section: ctx.nature === 'releve_carte' || l.section === 'carte' ? 'carte' : 'compte',
      fournisseur: l.fournisseur ? String(l.fournisseur).trim().slice(0, 80) : null,
      carte_numero: l.carte_numero ? String(l.carte_numero).replace(/\D/g, '').slice(-4) || null : null,
      total_carte: l.section === 'carte' ? null : (['CB CIC', 'AMEX'].includes(l.total_carte) ? l.total_carte : null),
      categorie: categories.includes(l.categorie) ? l.categorie : null,
    }));
  return { lignes, finSection: out.fin_de_page_section === 'carte' ? 'carte' : 'compte' };
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

// Nom de fournisseur normalisé pour une liste de libellés bancaires (rattrapage).
async function normaliserFournisseurs(libelles) {
  const out = await appel(null, `Pour chaque libellé bancaire ci-dessous, donne le nom commercial court et normalisé du fournisseur / tiers
(ex. "PRLV SEPA ORANGE SA ORANGE SA VOTRE ABONNEMENT…" → "Orange" ; "STAT. PAYBYPHON 94 /IVRY" → "PayByPhone" ; "AMAZON PAYMENTS" → "Amazon").
Le même fournisseur doit toujours avoir exactement le même nom. null pour un virement interne entre comptes ou un débit global de carte.
Réponds UNIQUEMENT en JSON : { "resultats": [ { "i": <index>, "fournisseur": string|null } ] }
Libellés :
${libelles.map((l, i) => `${i}. ${l}`).join('\n')}`, 8000);
  const r = {};
  for (const x of out.resultats || []) if (Number.isInteger(x.i) && libelles[x.i] !== undefined) r[libelles[x.i]] = x.fournisseur || null;
  return r;
}

// Classe des fournisseurs : récurrent ou ponctuel, factures en ligne, récupération automatisable.
async function classerFournisseurs(fournisseurs) {
  const out = await appel(null, `Tu aides une petite entreprise française à organiser la récupération de ses factures fournisseurs.
Pour chaque fournisseur ci-dessous (avec des exemples de libellés bancaires, le nombre de mois où il apparaît et le sens des mouvements : un montant négatif est un paiement de l'entreprise, positif un encaissement), indique :
- "recurrent": true si c'est typiquement un abonnement / fournisseur à facturation régulière (télécom, énergie, SaaS, hébergement, assurance, loyer, banque, transport à compte…) ou s'il apparaît sur plusieurs mois ; false pour un achat ponctuel (commerce, restaurant…).
- "en_ligne": true si les factures sont normalement téléchargeables dans un espace client en ligne ou envoyées par e-mail (ex. Orange, OVH, Google, Amazon, G7, EDF, SNCF Connect, Free…), y compris pour un achat ponctuel (ex. commande Nespresso, Amazon, Fnac) ; false si seul un ticket papier existe (boutique, restaurant, parking à l'horodateur…).
- "url": l'adresse de la page où l'on récupère les factures (espace client) si tu la connais avec certitude, sinon null.
- "recuperation": "email" si les factures arrivent habituellement par e-mail (récupérables automatiquement depuis la boîte mail), "api" s'il existe une API/connecteur officiel pour les factures, "portail" si seulement via le site (téléchargement manuel), "non" si pas de facture en ligne (impôts, prêt, commerçant…).
- "note": une phrase courte et utile (où trouver les factures, à quelle fréquence).
Réponds UNIQUEMENT en JSON : { "resultats": [ { "i": <index>, "recurrent": bool, "en_ligne": bool, "url": string|null, "recuperation": "email"|"api"|"portail"|"non", "note": string } ] }
Fournisseurs :
${fournisseurs.map((f, i) => `${i}. ${f.nom} — ${f.mois} mois${f.solde !== null && f.solde !== undefined ? ` — total des mouvements ${Number(f.solde).toFixed(2)} €` : ''} — ex. : ${f.exemples.join(' | ')}`).join('\n')}`, 8000);
  return (out.resultats || []).filter((x) => Number.isInteger(x.i) && fournisseurs[x.i]).map((x) => ({
    id: fournisseurs[x.i].id,
    recurrent: !!x.recurrent,
    en_ligne: !!x.en_ligne,
    url: typeof x.url === 'string' && /^https?:\/\//.test(x.url) ? x.url : null,
    recuperation: ['email', 'api', 'portail', 'non'].includes(x.recuperation) ? x.recuperation : null,
    note: x.note ? String(x.note).slice(0, 300) : null,
  }));
}

module.exports = { normaliserFournisseurs, classerFournisseurs, analyser, classer, extraireLignes, decouperPdf, PAIEMENTS, SOCIETES };

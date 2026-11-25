// Import des relevés (compte CIC, carte CIC, AMEX) et rapprochement avec les opérations saisies.
const { pool } = require('./db');
const { idFournisseur } = require('./fournisseurs');

const BANQUE_CARTE = { 'CB CIC': 'CIC', AMEX: 'AMEX' };

// Trouve ou crée le compte correspondant au relevé reconnu.
async function trouverCompte(info, entiteId) {
  const banque = info.banque === 'AMEX' ? 'AMEX' : (info.banque || 'AUTRE');
  const nature = info.nature === 'releve_carte' || banque === 'AMEX' ? 'carte' : 'compte';
  const numero = info.numero ? String(info.numero).replace(/\D/g, '').slice(-4) || null : null;
  let r;
  if (numero) {
    r = await pool.query('SELECT * FROM comptes WHERE banque=$1 AND nature=$2 AND numero=$3', [banque, nature, numero]);
  }
  if ((!r || !r.rows[0]) && entiteId) {
    r = await pool.query('SELECT * FROM comptes WHERE banque=$1 AND nature=$2 AND entite_id=$3 AND (numero IS NULL OR $4::text IS NULL) ORDER BY id LIMIT 1',
      [banque, nature, entiteId, numero]);
  }
  if (r && r.rows[0]) {
    const c = r.rows[0];
    if (!c.entite_id && entiteId) await pool.query('UPDATE comptes SET entite_id=$1 WHERE id=$2', [entiteId, c.id]);
    if (!c.numero && numero) await pool.query('UPDATE comptes SET numero=$1 WHERE id=$2', [numero, c.id]);
    return c.id;
  }
  const ins = await pool.query('INSERT INTO comptes (banque, nature, numero, entite_id) VALUES ($1,$2,$3,$4) RETURNING id',
    [banque, nature, numero, entiteId || null]);
  return ins.rows[0].id;
}

// Insère les lignes d'une page en ignorant celles déjà importées par un autre relevé du même compte.
async function insererLignes(releveId, compteId, page, lignes) {
  let doublons = 0;
  for (const l of lignes) {
    const { rows } = await pool.query(
      `SELECT 1 FROM lignes WHERE compte_id=$1 AND releve_id<>$2 AND date_op=$3 AND montant=$4 AND libelle=$5 LIMIT 1`,
      [compteId, releveId, l.date, l.montant, l.libelle]);
    if (rows[0]) { doublons++; continue; }
    const fId = l.total_carte ? null : await idFournisseur(l.fournisseur);
    await pool.query(
      `INSERT INTO lignes (releve_id, compte_id, page, date_op, libelle, montant, categorie, total_carte, fournisseur_id, fournisseur_vu)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [releveId, compteId, page, l.date, l.libelle, l.montant, l.categorie, l.total_carte, fId, !!(fId || l.total_carte)]);
  }
  if (doublons) await pool.query('UPDATE releves SET nb_doublons = nb_doublons + $1 WHERE id=$2', [doublons, releveId]);
}

// Rapprochement automatique. Ne touche jamais à ce qui est déjà rapproché.
async function rapprocher() {
  let auto = 0;

  // 1) Débits globaux de carte sur le relevé de compte ↔ relevé de carte dont le total correspond.
  const { rows: totaux } = await pool.query(`
    SELECT l.id, l.montant, l.date_op, l.total_carte, c.entite_id
    FROM lignes l JOIN comptes c ON c.id = l.compte_id
    WHERE l.total_carte IS NOT NULL AND l.releve_carte_id IS NULL AND NOT l.ignoree`);
  for (const t of totaux) {
    const { rows } = await pool.query(`
      SELECT r.id FROM releves r JOIN comptes c ON c.id = r.compte_id
      WHERE c.nature = 'carte' AND c.banque = $1 AND ($2::int IS NULL OR c.entite_id IS NULL OR c.entite_id = $2)
        AND NOT EXISTS (SELECT 1 FROM lignes x WHERE x.releve_carte_id = r.id)
        AND ABS((SELECT COALESCE(SUM(montant),0) FROM lignes WHERE releve_id = r.id) - $3) < 0.02
      ORDER BY ABS(COALESCE(r.periode_fin, $4::date) - $4::date) LIMIT 1`,
    [BANQUE_CARTE[t.total_carte], t.entite_id, t.montant, t.date_op]);
    if (rows[0]) {
      await pool.query('UPDATE lignes SET releve_carte_id=$1 WHERE id=$2', [rows[0].id, t.id]);
      auto++;
    }
  }

  // 2) Lignes de mouvement ↔ opérations saisies (tickets, factures).
  const { rows: lignes } = await pool.query(`
    SELECT l.id, l.montant, l.date_op, c.nature, c.banque, c.entite_id
    FROM lignes l JOIN comptes c ON c.id = l.compte_id
    WHERE l.operation_id IS NULL AND l.total_carte IS NULL AND NOT l.ignoree
    ORDER BY l.date_op`);
  for (const l of lignes) {
    const cands = await candidats(l, 10);
    if (!cands.length) continue;
    // Rapprochement automatique seulement s'il n'y a pas d'ambiguïté.
    if (cands.length === 1 || cands[0].ecart < cands[1].ecart) {
      try {
        await pool.query('UPDATE lignes SET operation_id=$1 WHERE id=$2 AND operation_id IS NULL', [cands[0].id, l.id]);
        auto++;
      } catch (e) { /* opération déjà prise entre-temps */ }
    }
  }
  auto += await ecrituresSansFacture();
  await attribuerSocietes();
  return auto;
}

// Organismes sans facture (URSSAF, DGFIP…) : chaque ligne de relevé devient une écriture réglée, sans justificatif demandé.
async function ecrituresSansFacture() {
  const { rows } = await pool.query(`
    SELECT l.id, l.date_op, l.libelle, l.montant, c.entite_id, c.nature, c.banque, f.id AS fid, f.nom AS fnom, f.cle, (f.mode = 'rien' OR f.ecriture_auto) AS rien
    FROM lignes l JOIN comptes c ON c.id = l.compte_id JOIN fournisseurs f ON f.id = l.fournisseur_id
    WHERE (f.mode = 'rien' OR f.ecriture_auto OR f.recup_annuelle) AND l.operation_id IS NULL AND l.total_carte IS NULL AND NOT l.ignoree AND c.entite_id IS NOT NULL`);
  let n = 0;
  for (const l of rows) {
    // Rien à faire (URSSAF, impôts, salaires…) : catégorie habituelle du fournisseur, sinon celle de l'organisme.
    // Session annuelle : catégorie habituelle du fournisseur.
    const { rows: cat } = await pool.query(`SELECT COALESCE(
        (SELECT categorie_id FROM operations WHERE fournisseur_id=$1 AND categorie_id IS NOT NULL ORDER BY date_op DESC LIMIT 1),
        CASE WHEN $2 THEN (SELECT id FROM categories WHERE nom = CASE WHEN $3 ~ 'urssaf' THEN 'Salaires & charges sociales'
          WHEN $3 ~ '(^| )(urssaf|dgfip|sie|impots|tresor public)( |$)' THEN 'Impôts & taxes' ELSE 'Salaires & charges sociales' END) END) AS id`,
      [l.fid, l.rien, l.cle]);
    const { rows: ins } = await pool.query(
      `INSERT INTO operations (entite_id, date_op, type, categorie_id, libelle, tiers, montant_ttc, tva, notes, paiement,
         reglement, date_paiement, fournisseur_id, justif_attendu)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'Déjà réglé',$2,$10,$11) RETURNING id`,
      [l.entite_id, l.date_op, Number(l.montant) < 0 ? 'depense' : 'recette', cat[0] ? cat[0].id : null, l.libelle, l.fnom,
        Math.abs(Number(l.montant)),
        l.rien ? 'Écriture automatique — rien à faire'
          : 'Justificatif à télécharger lors de la session annuelle',
        paiementAttendu(l), l.fid, !l.rien]);
    await pool.query('UPDATE lignes SET operation_id=$1 WHERE id=$2 AND operation_id IS NULL', [ins[0].id, l.id]);
    n++;
  }
  return n;
}

// Une opération saisie avec « société à déterminer » prend la société du compte où elle a été rapprochée.
async function attribuerSocietes() {
  await pool.query(`UPDATE operations o SET entite_id = c.entite_id
    FROM lignes l JOIN comptes c ON c.id = l.compte_id
    WHERE l.operation_id = o.id AND o.entite_id IS NULL AND c.entite_id IS NOT NULL`);
  // Idem pour le moyen de paiement : carte CIC, AMEX ou compte courant.
  await pool.query(`UPDATE operations o SET paiement = CASE
      WHEN c.nature = 'carte' AND c.banque = 'AMEX' THEN 'AMEX'
      WHEN c.nature = 'carte' THEN 'CB CIC'
      ELSE 'Virement / prélèvement CIC' END
    FROM lignes l JOIN comptes c ON c.id = l.compte_id
    WHERE l.operation_id = o.id AND o.paiement IS NULL`);
  // Apprentissage des cartes : une opération payée avec « •••• 1001 » rapprochée sur le relevé AMEX → 1001 = AMEX.
  await pool.query(`INSERT INTO cartes (numero, paiement)
    SELECT DISTINCT ON (substring(o.carte from '(\\d{4})\\D*$')) substring(o.carte from '(\\d{4})\\D*$'),
      CASE WHEN c.banque = 'AMEX' THEN 'AMEX' ELSE 'CB CIC' END
    FROM operations o JOIN lignes l ON l.operation_id = o.id JOIN comptes c ON c.id = l.compte_id
    WHERE c.nature = 'carte' AND o.carte ~ '\\d{4}\\D*$'
    ON CONFLICT (numero) DO NOTHING`);
  await appliquerCartes();
}

// Moyen de paiement déduit des cartes connues, pour les opérations où il manque.
async function appliquerCartes() {
  await pool.query(`UPDATE operations o SET paiement = k.paiement FROM cartes k
    WHERE o.paiement IS NULL AND o.carte IS NOT NULL AND substring(o.carte from '(\\d{4})\\D*$') = k.numero`);
}

// Moyen de paiement d'un document : mention explicite, marque de la carte, ou carte déjà connue.
async function paiementDepuisDocument(r) {
  if (r.paiement) return r.paiement;
  if (r.carte && /amex|american\s*express/i.test(r.carte)) return 'AMEX';
  const m = r.carte && String(r.carte).match(/(\d{4})\D*$/);
  if (m) {
    const { rows } = await pool.query('SELECT paiement FROM cartes WHERE numero=$1', [m[1]]);
    if (rows[0]) return rows[0].paiement;
  }
  return null;
}

// Moyen de paiement attendu pour une ligne d'un compte donné.
function paiementAttendu(c) {
  if (c.nature === 'carte') return c.banque === 'AMEX' ? 'AMEX' : 'CB CIC';
  return 'Virement / prélèvement CIC';
}

// Écarts entre ce qui a été saisi sur l'opération et ce que dit le relevé.
function ecarts(op, compte, nomsEntites) {
  const e = [];
  if (op.entite_id && compte.entite_id && op.entite_id !== compte.entite_id) {
    e.push(`société saisie « ${nomsEntites[op.entite_id] || '?'} », le relevé indique « ${nomsEntites[compte.entite_id] || '?'} »`);
  }
  const attendu = paiementAttendu(compte);
  const okCompte = compte.nature === 'compte' && ['Virement / prélèvement CIC', 'Autre'].includes(op.paiement);
  if (op.paiement && op.paiement !== attendu && !okCompte) {
    e.push(`paiement saisi « ${op.paiement} », le relevé indique « ${attendu} »`);
  }
  return e;
}

// Opérations pouvant correspondre à une ligne (même montant, dates proches, pas encore rapprochées).
// strict : même société et moyen de paiement compatible. Sinon : toutes (pour détecter les erreurs de saisie).
async function candidats(l, jours, strict = true) {
  const type = Number(l.montant) < 0 ? 'depense' : 'recette';
  let filtre = '';
  if (strict) {
    filtre = 'AND ($5::int IS NULL OR o.entite_id IS NULL OR o.entite_id = $5) ';
    if (l.nature === 'carte') {
      filtre += l.banque === 'AMEX' ? "AND (o.paiement = 'AMEX' OR o.paiement IS NULL)" : "AND (o.paiement = 'CB CIC' OR o.paiement IS NULL)";
    } else {
      // Sur le compte courant : pas les achats payés par carte (ils sont dans le relevé de carte) ni les avances en compte courant.
      filtre += "AND (o.paiement IS NULL OR o.paiement NOT IN ('CB CIC','AMEX','Avance CC'))";
    }
  }
  const { rows } = await pool.query(`
    SELECT o.id, o.date_op, o.libelle, o.tiers, o.montant_ttc, o.entite_id, o.paiement, e.nom AS entite,
      ABS(o.date_op - $3::date) AS ecart
    FROM operations o LEFT JOIN entites e ON e.id = o.entite_id
    WHERE o.type = $1 AND (ABS(o.montant_ttc - ABS($2::numeric)) < 0.01
      OR ABS(COALESCE(o.montant_debite, -1) - ABS($2::numeric)) < 0.01)
      AND ABS(o.date_op - $3::date) <= $4
      AND ($5::int IS NULL OR TRUE)
      AND NOT EXISTS (SELECT 1 FROM lignes x WHERE x.operation_id = o.id)
      ${filtre}
    ORDER BY ecart, o.id`, [type, l.montant, l.date_op, jours, l.entite_id]);
  return rows;
}

// Corrige l'opération rapprochée selon le relevé (société du compte, moyen de paiement).
async function corrigerDepuisLigne(ligneId) {
  const { rows } = await pool.query(
    `SELECT l.operation_id, c.entite_id, c.nature, c.banque FROM lignes l JOIN comptes c ON c.id = l.compte_id WHERE l.id=$1`, [ligneId]);
  const r = rows[0];
  if (!r || !r.operation_id) return;
  await pool.query('UPDATE operations SET entite_id = COALESCE($1, entite_id), paiement = $2, updated_at = NOW() WHERE id = $3',
    [r.entite_id, paiementAttendu(r), r.operation_id]);
}

// Justificatif déposé pour une opération créée en attente (session annuelle) : on complète cette opération.
// Opération créée d'office depuis le relevé (session annuelle, rien à faire) sans justificatif, correspondant à un document :
// même montant (TTC ou débité), date à 10 jours près. Le fournisseur n'est pas exigé (le document peut le révéler
// différemment de ce qu'on imaginait) ; à égalité, on préfère le même fournisseur.
async function trouverProvisoire(montants, date, fournisseur) {
  const { idFournisseur } = require('./fournisseurs');
  montants = montants.map(Number).filter((m) => m > 0);
  if (!montants.length || !date) return null;
  const fid = fournisseur ? await idFournisseur(fournisseur) : null;
  const { rows } = await pool.query(`
    SELECT o.id FROM operations o
    WHERE o.justif_data IS NULL AND (o.justif_attendu OR o.notes LIKE 'Écriture automatique%')
      AND EXISTS (SELECT 1 FROM unnest($1::numeric[]) m WHERE ABS(o.montant_ttc - m) < 0.01)
      AND ABS(o.date_op - $2::date) <= 10
    ORDER BY (o.fournisseur_id IS NOT DISTINCT FROM $3) DESC, ABS(o.date_op - $2::date) LIMIT 1`, [montants, date, fid]);
  return rows[0] ? rows[0].id : null;
}

// Document déposé (session annuelle ou scan) : complète l'opération provisoire au lieu d'en créer une autre.
async function completerAttendu(r, doc) {
  const id = await trouverProvisoire([r.montant_ttc, r.montant_paye].filter(Boolean), r.date, r.fournisseur);
  if (!id) return null;
  const { rows: cat } = r.categorie ? await pool.query('SELECT id FROM categories WHERE nom=$1', [r.categorie]) : { rows: [] };
  await pool.query(`UPDATE operations SET justif_attendu = FALSE, justif_nom=$1, justif_type=$2, justif_data=$3,
      tva = $4, numero_facture = COALESCE($5, numero_facture), date_op = $6, tiers = COALESCE($7, tiers),
      categorie_id = COALESCE($8, categorie_id), notes = 'Justificatif déposé et rattaché à l''opération du relevé', updated_at = NOW()
    WHERE id = $9`,
    [doc.nom, doc.mimetype, doc.data, r.tva || 0, r.numero_facture || null, r.date, r.fournisseur || null, cat[0] ? cat[0].id : null, id]);
  if (r.fournisseur) await require('./fournisseurs').lierOperation(id, r.fournisseur);
  return id;
}

module.exports = { completerAttendu, trouverProvisoire, trouverCompte, insererLignes, rapprocher, candidats, attribuerSocietes, ecarts, paiementAttendu, corrigerDepuisLigne, paiementDepuisDocument, appliquerCartes };

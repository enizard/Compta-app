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
  await attribuerSocietes();
  return auto;
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
    WHERE o.type = $1 AND ABS(o.montant_ttc - ABS($2::numeric)) < 0.01
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

module.exports = { trouverCompte, insererLignes, rapprocher, candidats, attribuerSocietes, ecarts, paiementAttendu, corrigerDepuisLigne };

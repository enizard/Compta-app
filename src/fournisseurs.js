// Fournisseurs : rattachement des lignes de relevé et des opérations, classification récurrent / en ligne.
const { pool } = require('./db');
const { normaliserFournisseurs, classerFournisseurs } = require('./analyse');

function cle(nom) {
  return String(nom).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(sas|sasu|sarl|sa|eurl|sca|ltd|inc|france|fr)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

async function idFournisseur(nom) {
  if (!nom || !String(nom).trim()) return null;
  const k = cle(nom);
  if (!k) return null;
  const { rows } = await pool.query(
    `INSERT INTO fournisseurs (nom, cle) VALUES ($1, $2)
     ON CONFLICT (cle) DO UPDATE SET cle = EXCLUDED.cle RETURNING id`, [String(nom).trim().slice(0, 80), k]);
  return rows[0].id;
}

async function lierOperation(opId, tiers) {
  const id = await idFournisseur(tiers);
  if (id) await pool.query('UPDATE operations SET fournisseur_id=$1 WHERE id=$2', [id, opId]);
}

let enCours = false;

// Rattrapage (lignes et opérations sans fournisseur) puis classification des nouveaux fournisseurs.
async function mettreAJour() {
  if (enCours || !process.env.ANTHROPIC_API_KEY) return;
  enCours = true;
  try {
    // 1) Lignes de relevé sans fournisseur : normalisation des libellés par lots.
    for (;;) {
      const { rows } = await pool.query(
        `SELECT DISTINCT libelle FROM lignes WHERE NOT fournisseur_vu AND total_carte IS NULL LIMIT 80`);
      if (!rows.length) break;
      const libs = rows.map((r) => r.libelle);
      const map = await normaliserFournisseurs(libs);
      for (const lib of libs) {
        const id = await idFournisseur(map[lib]);
        await pool.query('UPDATE lignes SET fournisseur_id=$1, fournisseur_vu=TRUE WHERE libelle=$2 AND NOT fournisseur_vu', [id, lib]);
      }
    }
    await pool.query('UPDATE lignes SET fournisseur_vu=TRUE WHERE total_carte IS NOT NULL AND NOT fournisseur_vu');

    // 2) Opérations saisies sans fournisseur : d'après le tiers.
    const { rows: ops } = await pool.query(
      "SELECT id, tiers FROM operations WHERE fournisseur_id IS NULL AND COALESCE(tiers,'') <> ''");
    for (const o of ops) await lierOperation(o.id, o.tiers);
    // Une opération rapprochée hérite du fournisseur de sa ligne de relevé.
    await pool.query(`UPDATE operations o SET fournisseur_id = l.fournisseur_id FROM lignes l
      WHERE l.operation_id = o.id AND o.fournisseur_id IS NULL AND l.fournisseur_id IS NOT NULL`);

    // 3) Classification des fournisseurs pas encore classés.
    for (;;) {
      const { rows } = await pool.query(`
        SELECT f.id, f.nom,
          (SELECT COUNT(DISTINCT date_trunc('month', d)) FROM (
             SELECT date_op d FROM lignes WHERE fournisseur_id = f.id
             UNION ALL SELECT date_op FROM operations WHERE fournisseur_id = f.id) x)::int AS mois,
          ARRAY(SELECT DISTINCT libelle FROM lignes WHERE fournisseur_id = f.id LIMIT 3) AS exemples,
          (SELECT SUM(montant) FROM lignes WHERE fournisseur_id = f.id) AS solde
        FROM fournisseurs f WHERE f.classe_le IS NULL AND NOT f.modifie_main ORDER BY f.id LIMIT 40`);
      if (!rows.length) break;
      const res = await classerFournisseurs(rows.map((r) => ({ ...r, exemples: r.exemples.length ? r.exemples : [r.nom] })));
      for (const r of res) {
        await pool.query(
          `UPDATE fournisseurs SET type=$1, en_ligne=$2, url=$3, recuperation=$4, note=$5, classe_le=NOW(),
             ecriture_auto = ecriture_auto OR cle ~ '(^| )(urssaf|dgfip|sie|impots|tresor public)( |$)'
           WHERE id=$6 AND NOT modifie_main`,
          [r.recurrent ? 'recurrent' : 'ponctuel', r.en_ligne, r.url, r.recuperation, r.note, r.id]);
      }
      // Ceux que l'IA n'a pas renvoyés ne doivent pas boucler indéfiniment.
      await pool.query('UPDATE fournisseurs SET classe_le=NOW() WHERE id = ANY($1) AND classe_le IS NULL', [rows.map((r) => r.id)]);
    }
    // Les fournisseurs viennent d'être rattachés : écritures automatiques (URSSAF, DGFIP…) et rapprochement.
    await require('./releves').rapprocher();
  } catch (e) {
    console.error('Fournisseurs :', e.message);
  } finally {
    enCours = false;
  }
}

module.exports = { idFournisseur, lierOperation, mettreAJour, cle };

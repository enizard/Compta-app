# compta-app

Suivi simple de comptabilité multi-sociétés (SCI E NIZARD, BMG, LMF, Simple and New) :
recettes / dépenses, catégories, justificatifs, synthèse mensuelle, export CSV pour l'expert-comptable, plusieurs utilisateurs.

Node.js 22 + Express + PostgreSQL.

## Déploiement Heroku

1. Créer l'app sur Heroku et ajouter l'add-on **Heroku Postgres** (fournit `DATABASE_URL`).
2. Dans *Deploy*, choisir **GitHub**, connecter `enizard/compta-app`, activer **Automatic deploys** sur `main`, puis **Deploy Branch**.
3. Ouvrir l'app : la première visite propose de créer le compte administrateur.

## En local

```
DATABASE_URL=postgresql://localhost/compta npm start
```

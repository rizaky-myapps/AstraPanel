# AstraPanel — conventions du dépôt

- Interface, messages et documentation en **français**.
- Aucune dépendance npm pour le panel (Node.js ≥ 20 uniquement) ; `npm test` doit passer.

## Versions et branches

- Chaque mise à jour (MAJ) est publiée sur une **nouvelle branche** nommée `AstraPanel-version.X.Y.Z-latest`,
  où `X.Y.Z` est la `version` de `package.json` (à incrémenter à chaque MAJ).
- À la publication d'une nouvelle version, l'ancienne branche `…-latest` est **renommée sans le suffixe**
  (`AstraPanel-version.X.Y.Z`). Il n'existe donc qu'une seule branche `-latest`.
- Les panels installés suivent automatiquement la branche `-latest` (Paramètres → Mises à jour → « Automatique »),
  et `sudo astrapanel-update` fait de même.
- Pour publier : `./scripts/nouvelle-version.sh X.Y.Z` (met à jour `package.json`, pousse la nouvelle branche,
  renomme l'ancienne).

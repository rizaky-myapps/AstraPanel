# AstraPanel — conventions du dépôt

- Interface, messages et documentation en **français**.
- Aucune dépendance npm pour le panel (Node.js ≥ 20 uniquement) ; `npm test` doit passer.

## Versions et branches

- **`AstraPanel-Latest`** remplace `main` : c'est la branche principale, elle contient toujours la dernière version.
- Chaque mise à jour (MAJ) incrémente la `version` de `package.json` de **0.0.1** avec retenue
  (1.2.8 → 1.2.9 → 1.3.0 → 1.3.1 ; 1.9.9 → 2.0.0), met à jour `AstraPanel-Latest` et crée une nouvelle branche
  **`AstraPanel-V.X.Y.Z`** avec exactement les mêmes fichiers.
- Les panels installés regardent `AstraPanel-Latest` toutes les 5 minutes et comparent la `version` de son
  `package.json` à la leur ; `sudo astrapanel-update` installe aussi `AstraPanel-Latest`.
- Pour publier : `./scripts/nouvelle-version.sh` (sans argument : calcule la version suivante, commite
  `package.json`, pousse `AstraPanel-Latest` et `AstraPanel-V.X.Y.Z` en une seule fois).

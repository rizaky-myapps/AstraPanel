#!/usr/bin/env bash
# Publie une nouvelle version d'AstraPanel sur sa propre branche.
#
#   ./scripts/nouvelle-version.sh 1.2.0
#
# 1. met « version » de package.json à 1.2.0 (et commite si besoin) ;
# 2. pousse la branche « AstraPanel-version.1.2.0-latest » ;
# 3. renomme l'ancienne branche « AstraPanel-version.X.Y.Z-latest » en « AstraPanel-version.X.Y.Z ».
# Les panels installés suivent automatiquement la branche « -latest » pour leurs mises à jour.
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage : $0 X.Y.Z (ex. 1.2.0)" >&2; exit 1; }
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Des modifications ne sont pas commitées." >&2; exit 1; }

NEW="AstraPanel-version.$VERSION-latest"
git fetch --quiet origin
if git ls-remote --exit-code --heads origin "AstraPanel-version.$VERSION" "$NEW" >/dev/null; then
  echo "La version $VERSION est déjà publiée." >&2
  exit 1
fi

# La nouvelle version doit être plus récente que la dernière publiée
previous="$(git ls-remote --heads origin 'AstraPanel-version.*-latest' | sed 's|.*refs/heads/||')"
for b in $previous; do
  v="${b#AstraPanel-version.}"
  v="${v%-latest}"
  if [ "$(printf '%s\n%s\n' "$v" "$VERSION" | sort -V | tail -n 1)" != "$VERSION" ]; then
    echo "La version $VERSION doit être plus récente que $v." >&2
    exit 1
  fi
done

if [ "$(node -p "require('./package.json').version")" != "$VERSION" ]; then
  node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json"));
    p.version = process.argv[1]; fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' "$VERSION"
  git commit -qm "Version $VERSION" package.json
fi

git push origin "HEAD:refs/heads/$NEW"
echo "✔ Branche $NEW publiée"

git ls-remote --heads origin 'AstraPanel-version.*-latest' | while read -r sha ref; do
  b="${ref#refs/heads/}"
  [ "$b" = "$NEW" ] && continue
  git push origin "$sha:refs/heads/${b%-latest}"
  git push origin --delete "$b"
  echo "✔ $b renommée en ${b%-latest}"
done

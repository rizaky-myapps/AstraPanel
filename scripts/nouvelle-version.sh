#!/usr/bin/env bash
# Publie une nouvelle version d'AstraPanel.
#
#   ./scripts/nouvelle-version.sh
#
# 1. calcule la version suivante en ajoutant 0.0.1 à la dernière publiée (la plus haute entre le package.json
#    de AstraPanel-Latest et les branches AstraPanel-V.X.Y.Z) : 1.2.8 → 1.2.9 → 1.3.0 → 1.3.1 ;
# 2. l'écrit dans package.json et commite ;
# 3. pousse ce commit sur « AstraPanel-Latest » (la dernière version, surveillée par les panels installés)
#    et sur une nouvelle branche « AstraPanel-V.X.Y.Z » (copie de cette version, gardée telle quelle).
set -euo pipefail

LATEST=AstraPanel-Latest
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "Des modifications ne sont pas commitées." >&2; exit 1; }

# Dernière version publiée : package.json de AstraPanel-Latest et branches AstraPanel-V.X.Y.Z
# (pour la toute première publication : la version de package.json)
base="$(node -p "require('./package.json').version")"
heads="$(git ls-remote --heads origin)" || { echo "Dépôt distant injoignable." >&2; exit 1; }
published=""
if grep -q "	refs/heads/$LATEST\$" <<<"$heads"; then
  git fetch --quiet origin "refs/heads/$LATEST"
  if ! git merge-base --is-ancestor FETCH_HEAD HEAD; then
    echo "$LATEST contient des commits absents d'ici : intégrez-les d'abord (git pull origin $LATEST)." >&2
    exit 1
  fi
  published="$(git show FETCH_HEAD:package.json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { console.log(JSON.parse(s).version || ""); } catch {} });' || true)"
else
  echo "Première publication sur $LATEST."
fi
published="$( (echo "$published"; sed -n 's|.*refs/heads/AstraPanel-V\.\([0-9]*\.[0-9]*\.[0-9]*\)$|\1|p' <<<"$heads") | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
base="${published:-$base}"

VERSION="$(node src/version.js next "$base")"
NEW="AstraPanel-V.$VERSION"
if git ls-remote --exit-code --heads origin "$NEW" >/dev/null; then
  echo "La branche $NEW existe déjà." >&2
  exit 1
fi
echo "Dernière version publiée : $base → nouvelle version : $VERSION"

if [ "$(node -p "require('./package.json').version")" != "$VERSION" ]; then
  node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json"));
    p.version = process.argv[1]; fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");' "$VERSION"
  git commit -qm "Version $VERSION" package.json
fi

# Les deux branches reçoivent le même commit, ou aucune des deux
git push --atomic origin "HEAD:refs/heads/$LATEST" "HEAD:refs/heads/$NEW"
echo "✔ Version $VERSION publiée sur $LATEST et $NEW"

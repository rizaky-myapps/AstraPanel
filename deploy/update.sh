#!/usr/bin/env bash
# Mise à jour d'AstraPanel depuis son dépôt Git.
# Lancé en root par astrapanel-update.service (demande faite depuis le panel) ou à la main :
#   sudo astrapanel-update                      dernière version (branche AstraPanel-Latest)
#   sudo astrapanel-update AstraPanel-V.1.2.3   une version précise (retour en arrière, 1.2.3 au minimum)
set -euo pipefail

INSTALL_DIR="${ASTRA_DIR:-/opt/astrapanel}"
STATE_DIR=/var/lib/astrapanel
SRC="$STATE_DIR/source"
LOG=/var/log/astrapanel-update.log
STATUS="$STATE_DIR/update-status.json"
REQUEST="$INSTALL_DIR/data/update-request"
BRANCH_RE='^[A-Za-z0-9._/-]{1,200}$'

mkdir -p "$STATE_DIR"
: >"$LOG"
chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1

NODE_BIN="$(command -v node)"
status() {
  "$NODE_BIN" -e 'const [f, state, message, commit] = process.argv.slice(1);
    require("fs").writeFileSync(f, JSON.stringify({ state, message, commit: commit || null, at: Date.now() }));' \
    "$STATUS" "$1" "$2" "${3:-}"
  chmod 644 "$STATUS"
}
trap 'status failed "La mise à jour a échoué : consultez le journal."' ERR

# La demande du panel (data/update-request) n'est qu'un déclencheur : on installe toujours AstraPanel-Latest.
rm -f "$REQUEST"
branch="${1:-AstraPanel-Latest}"
[[ "$branch" =~ $BRANCH_RE ]] && [[ "$branch" != -* ]] && [[ "$branch" != *..* ]] || { echo "Branche invalide : $branch"; exit 1; }

version_field() {
  "$NODE_BIN" -e 'try { process.stdout.write(String(require(process.argv[1])[process.argv[2]] || "")); } catch {}' "$INSTALL_DIR/version.json" "$1"
}
repo="$(version_field repo)"
[ -n "$repo" ] || { echo "Dépôt inconnu : relancez install.sh depuis un clone Git."; exit 1; }
export GIT_TERMINAL_PROMPT=0

echo "==> Mise à jour depuis la branche « $branch »"
status running "Téléchargement de la nouvelle version…"
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git clone --quiet --depth 1 --branch "$branch" -- "$repo" "$SRC"
else
  git -C "$SRC" remote set-url origin "$repo"
  git -C "$SRC" fetch --quiet --depth 1 origin "$branch"
  git -C "$SRC" checkout --quiet -f -B "$branch" FETCH_HEAD
  git -C "$SRC" clean -fdq
fi
commit="$(git -C "$SRC" rev-parse HEAD)"
version="$("$NODE_BIN" -e 'try { process.stdout.write(String(require(process.argv[1]).version)); } catch {}' "$SRC/package.json")"
echo "==> Version ${version:-?} (commit ${commit:0:7} : $(git -C "$SRC" log -1 --format=%s))"

status running "Installation de la nouvelle version…" "$commit"
"$SRC/install.sh"

status done "Mise à jour terminée" "$commit"
echo "==> Mise à jour terminée"

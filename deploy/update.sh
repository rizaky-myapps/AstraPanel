#!/usr/bin/env bash
# Mise à jour d'AstraPanel depuis son dépôt Git.
# Lancé en root par astrapanel-update.service (demande faite depuis le panel) ou à la main : sudo astrapanel-update
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

# Branche demandée par le panel (le fichier est écrit par l'utilisateur du panel : on le valide)
requested=""
if [ -f "$REQUEST" ] && [ ! -L "$REQUEST" ]; then
  requested="$(head -c 4096 "$REQUEST" | "$NODE_BIN" -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { const b = String(JSON.parse(s).branch || ""); if (!b.startsWith("-") && !b.includes("..")) process.stdout.write(b); } catch {} });')"
fi
rm -f "$REQUEST"

version_field() {
  "$NODE_BIN" -e 'try { process.stdout.write(String(require(process.argv[1])[process.argv[2]] || "")); } catch {}' "$INSTALL_DIR/version.json" "$1"
}
repo="$(version_field repo)"
[ -n "$repo" ] || { echo "Dépôt inconnu : relancez install.sh depuis un clone Git."; exit 1; }
export GIT_TERMINAL_PROMPT=0

# Sans demande du panel (sudo astrapanel-update) : dernière version publiée « AstraPanel-version.X.Y.Z-latest »
latest=""
if [ -z "$requested" ]; then
  latest="$(git ls-remote --heads -- "$repo" 'AstraPanel-version.*-latest' | sed 's|.*refs/heads/||' | sort -V | tail -n 1 || true)"
fi
branch="${requested:-${latest:-$(version_field branch)}}"
[[ "$branch" =~ $BRANCH_RE ]] || { echo "Branche invalide : $branch"; exit 1; }

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
echo "==> Version ${commit:0:7} : $(git -C "$SRC" log -1 --format=%s)"

status running "Installation de la nouvelle version…" "$commit"
"$SRC/install.sh"

status done "Mise à jour terminée" "$commit"
echo "==> Mise à jour terminée"

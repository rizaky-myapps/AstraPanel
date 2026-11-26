#!/usr/bin/env bash
# Installateur / mise à jour d'AstraPanel
# Pour Linux 64 bits avec apt et systemd : Debian, Ubuntu et leurs dérivés (ordinateur, mini-PC, serveur, VPS…).
#
#   sudo ./install.sh                 installe ou met à jour le panel
#   sudo ./install.sh --port=9000     change le port du panel (8080 par défaut)
set -euo pipefail

INSTALL_DIR="${ASTRA_DIR:-/opt/astrapanel}"
DATA_DIR="$INSTALL_DIR/data"
PANEL_USER="astrapanel"
NODE_MAJOR="${NODE_MAJOR:-24}"
UNIT_FILE="/etc/systemd/system/astrapanel.service"
PANEL_PORT=""

info() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --port=*) PANEL_PORT="${arg#*=}" ;;
    -h | --help) usage; exit 0 ;;
    *) usage; fail "Option inconnue : $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "Lancez ce script avec sudo : sudo ./install.sh"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SRC_DIR/src/server.js" ] || fail "Lancez install.sh depuis le dossier AstraPanel (git clone)."

# Port : celui demandé, sinon celui de l'installation existante, sinon 8080
if [ -z "$PANEL_PORT" ] && [ -f "$UNIT_FILE" ]; then
  PANEL_PORT="$(sed -n 's/^Environment=ASTRA_PORT=\([0-9]*\)$/\1/p' "$UNIT_FILE")"
fi
PANEL_PORT="${PANEL_PORT:-8080}"
[[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || fail "Port invalide : $PANEL_PORT"

case "$(uname -m)" in
  aarch64 | arm64 | x86_64) ;;
  armv7l | armv6l) warn "Système 32 bits détecté : un système 64 bits est fortement recommandé." ;;
  *) warn "Architecture $(uname -m) non testée." ;;
esac

# --- Paquets système ---------------------------------------------------------
info "Installation des paquets système (git, unzip, outils de compilation)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git zip unzip tar rsync build-essential python3

# --- Node.js -----------------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 20 ]; then
    need_node=0
    info "Node.js $(node -v) déjà installé."
  fi
fi
if [ "$need_node" -eq 1 ]; then
  info "Installation de Node.js $NODE_MAJOR LTS (dépôt NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"

# --- Utilisateur système -----------------------------------------------------
if ! id "$PANEL_USER" >/dev/null 2>&1; then
  info "Création de l'utilisateur système « $PANEL_USER »…"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$PANEL_USER"
fi
# groupe video : permet de lire l'état de l'alimentation et de la température (vcgencmd), sur les cartes qui le proposent
if getent group video >/dev/null; then usermod -aG video "$PANEL_USER"; fi

# --- Code du panel -----------------------------------------------------------
info "Copie du panel dans $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
if [ "$SRC_DIR" != "$INSTALL_DIR" ]; then
  # appartient à root : les applis hébergées ne peuvent pas modifier le panel
  rsync -a --no-owner --no-group --delete \
    --exclude '.git' --exclude 'data' --exclude 'node_modules' \
    "$SRC_DIR/" "$INSTALL_DIR/"
fi
mkdir -p "$DATA_DIR"
chown "$PANEL_USER:$PANEL_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# --- Ancienne intégration Caddy (retirée) -------------------------------------
# Les versions précédentes pouvaient configurer Caddy : on retire ce que le panel avait ajouté.
if [ -d /etc/caddy/astrapanel ]; then
  info "Retrait de l'ancienne configuration Caddy d'AstraPanel…"
  if [ -f /etc/caddy/Caddyfile.avant-astrapanel ]; then
    mv /etc/caddy/Caddyfile.avant-astrapanel /etc/caddy/Caddyfile
  elif [ -f /etc/caddy/Caddyfile ]; then
    sed -i '\|/etc/caddy/astrapanel|d' /etc/caddy/Caddyfile
  fi
  rm -rf /etc/caddy/astrapanel
  systemctl reload caddy >/dev/null 2>&1 || true
  warn "AstraPanel n'utilise plus Caddy. Pour le désinstaller : sudo apt purge caddy"
fi

# --- Service systemd ---------------------------------------------------------
info "Installation du service systemd (port $PANEL_PORT)…"
sed -e "s|@USER@|$PANEL_USER|g" -e "s|@DIR@|$INSTALL_DIR|g" -e "s|@DATA@|$DATA_DIR|g" \
  -e "s|@PORT@|$PANEL_PORT|g" -e "s|@NODE@|$NODE_BIN|g" \
  "$INSTALL_DIR/deploy/astrapanel.service" >"$UNIT_FILE"
# Petit outil de secours (réinitialiser un mot de passe…), exécuté en tant qu'utilisateur du panel
cat >/usr/local/bin/astrapanel-cli <<CLI
#!/bin/sh
[ "\$(id -u)" -eq 0 ] || { echo "Utilisez : sudo astrapanel-cli \$*" >&2; exit 1; }
if [ "\$1" = "reset-password" ]; then
  systemctl stop astrapanel
  trap 'systemctl start astrapanel' EXIT
fi
cd "$INSTALL_DIR" && sudo -u $PANEL_USER $NODE_BIN "$INSTALL_DIR/src/cli.js" "\$@"
CLI
chmod 755 /usr/local/bin/astrapanel-cli

# Version installée (permet au panel de détecter les nouvelles versions sur GitHub)
GIT_SRC=(git -c safe.directory="$SRC_DIR" -C "$SRC_DIR")
if "${GIT_SRC[@]}" rev-parse HEAD >/dev/null 2>&1; then
  "$NODE_BIN" -e 'const [file, repo, branch, commit, source] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({ repo, branch, commit, source, installedAt: Date.now() }, null, 2));' \
    "$INSTALL_DIR/version.json" \
    "$("${GIT_SRC[@]}" remote get-url origin 2>/dev/null || true)" \
    "$("${GIT_SRC[@]}" rev-parse --abbrev-ref HEAD)" \
    "$("${GIT_SRC[@]}" rev-parse HEAD)" \
    "$SRC_DIR"
  chown "root:$PANEL_USER" "$INSTALL_DIR/version.json"
  chmod 640 "$INSTALL_DIR/version.json"
else
  warn "Le dossier source n'est pas un clone Git : la mise à jour depuis le panel sera indisponible."
fi

# Services root déclenchés par le panel (qui tourne sans privilèges) : il crée data/update-request pour une mise à
# jour, data/reboot-request pour redémarrer la machine (Paramètres → Hardware)
mkdir -p /var/lib/astrapanel
chmod 755 "$INSTALL_DIR/deploy/update.sh" "$INSTALL_DIR/deploy/reboot.sh"
for unit in astrapanel-update.service astrapanel-update.path astrapanel-reboot.service astrapanel-reboot.path; do
  sed -e "s|@DIR@|$INSTALL_DIR|g" -e "s|@DATA@|$DATA_DIR|g" "$INSTALL_DIR/deploy/$unit" >"/etc/systemd/system/$unit"
done
ln -sf "$INSTALL_DIR/deploy/update.sh" /usr/local/bin/astrapanel-update
systemctl daemon-reload
for unit in astrapanel-update.path astrapanel-reboot.path; do
  systemctl enable "$unit" >/dev/null 2>&1
  systemctl start "$unit"
done
systemctl enable astrapanel >/dev/null 2>&1
systemctl restart astrapanel

info "Démarrage du panel…"
for _ in $(seq 1 20); do
  if systemctl is-active --quiet astrapanel && { [ -f "$DATA_DIR/db.json" ]; }; then break; fi
  sleep 0.5
done
systemctl is-active --quiet astrapanel || fail "Le panel ne démarre pas. Voir : sudo journalctl -u astrapanel -n 50"
sleep 1

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
printf '\033[1;32m✔ AstraPanel est installé et démarré !\033[0m\n\n'
echo "  Adresse du panel : http://${IP:-<ip-de-la-machine>}:$PANEL_PORT"
# nom en .local : seulement si la machine l'annonce sur le réseau (mDNS, avahi)
if systemctl is-active --quiet avahi-daemon 2>/dev/null; then
  echo "                     http://$(hostname).local:$PANEL_PORT"
fi
if [ -f "$DATA_DIR/setup-token" ]; then
  echo
  echo "  Jeton d'installation (à saisir à la première connexion) : $(cat "$DATA_DIR/setup-token")"
fi
echo
echo "  Journaux du panel : sudo journalctl -u astrapanel -f"
echo "  Mot de passe perdu : sudo astrapanel-cli reset-password <utilisateur>"
echo "  Mise à jour       : depuis le panel (Paramètres → Mises à jour) ou « sudo astrapanel-update »"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo
  warn "Le pare-feu ufw est actif : autorisez le panel avec « sudo ufw allow $PANEL_PORT/tcp »."
fi

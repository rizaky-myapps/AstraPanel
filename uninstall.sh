#!/usr/bin/env bash
# Désinstallation d'AstraPanel. Les données (apps, journaux) sont conservées sauf avec --purge.
set -euo pipefail

INSTALL_DIR="${ASTRA_DIR:-/opt/astrapanel}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script avec sudo." >&2; exit 1; }

systemctl disable --now astrapanel 2>/dev/null || true
rm -f /etc/systemd/system/astrapanel.service /usr/local/bin/astrapanel-cli
systemctl daemon-reload

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$INSTALL_DIR" /etc/caddy/astrapanel
  userdel astrapanel 2>/dev/null || true
  echo "AstraPanel et toutes ses données ont été supprimés."
  echo "Pensez à retirer la ligne « import /etc/caddy/astrapanel/*.caddy » de /etc/caddy/Caddyfile si besoin."
else
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  echo "AstraPanel est désinstallé. Vos données sont conservées dans $INSTALL_DIR/data"
  echo "(relancez avec --purge pour tout supprimer)."
fi

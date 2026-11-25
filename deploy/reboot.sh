#!/usr/bin/env bash
# Redémarre la machine à la demande du panel (Paramètres → Hardware).
# Lancé en root par astrapanel-reboot.service, lui-même déclenché par astrapanel-reboot.path.
set -euo pipefail

INSTALL_DIR="${ASTRA_DIR:-/opt/astrapanel}"
REQUEST="$INSTALL_DIR/data/reboot-request"

[ -f "$REQUEST" ] && [ ! -L "$REQUEST" ] || exit 0
request="$(head -c 4096 "$REQUEST")"
rm -f "$REQUEST"

# La demande doit dater du démarrage en cours : une demande restée d'avant (coupure, horloge fausse…) est ignorée,
# ce qui rend tout redémarrage en boucle impossible.
current="$(cat /proc/sys/kernel/random/boot_id)"
case "$request" in
  *"\"bootId\":\"$current\""*) ;;
  *)
    echo "Demande de redémarrage ignorée : elle date d'un démarrage précédent."
    exit 0
    ;;
esac

echo "Redémarrage demandé depuis AstraPanel : $request"
systemctl reboot

#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $EUID -ne 0 || $# -ne 1 ]]; then
  echo 'Ejecutar como root: capture-recovery.sh /ruta/nuevo-backup.ppr' >&2
  exit 1
fi

cd "$(dirname "$0")/.."
if [[ ! -f /etc/portalpromo-recovery.key ]]; then
  node scripts/recovery-backup.js key --key /etc/portalpromo-recovery.key
fi

was_active=false
if systemctl is-active --quiet portalpromo; then
  was_active=true
fi
restart_portal() {
  if [[ $was_active == true ]]; then
    systemctl start portalpromo
  fi
}
trap restart_portal EXIT

systemctl stop portalpromo
DOTENV_CONFIG_PATH=/etc/portalpromo.env node -r dotenv/config scripts/recovery-backup.js create \
  --env /etc/portalpromo.env --key /etc/portalpromo-recovery.key --output "$1"
node scripts/recovery-backup.js verify --key /etc/portalpromo-recovery.key --input "$1"

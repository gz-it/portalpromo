#!/usr/bin/env bash
# Fresh Ubuntu VPS only. Does not restore data or expose the application.
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Ejecutar como root' >&2; exit 1; }
[[ ! -e /etc/portalpromo.env ]] || { echo 'Ya existe una instalacion; no se sobrescribe.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git nginx postgresql postgresql-contrib ufw fail2ban python3-venv
python3 -m venv /opt/portal-backup-tools/verify-env
/opt/portal-backup-tools/verify-env/bin/pip install pyzipper==0.3.6
if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /root/portal-nodesource-setup.sh
  bash /root/portal-nodesource-setup.sh
  apt-get install -y nodejs
fi
id portalpromo >/dev/null 2>&1 || useradd --system --home-dir /var/lib/portalpromo --shell /usr/sbin/nologin portalpromo
install -d -m 2770 -o root -g portalpromo /var/lib/portalpromo
install -d -m 700 -o portalpromo -g portalpromo /var/lib/portalpromo/uploads /var/lib/portalpromo/backups
install -d -m 700 /root/portal-migration
install -d -m 755 /var/www/letsencrypt
ufw allow 5818/tcp
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
systemctl enable --now postgresql nginx
node --version
psql --version
echo 'Base del VPS preparada. Falta restaurar y configurar el servicio.'

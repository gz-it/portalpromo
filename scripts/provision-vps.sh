#!/usr/bin/env bash
set -euo pipefail

APP_NAME="portalpromo"
APP_USER="portalpromo"
APP_DIR="/opt/portalpromo"
DATA_DIR="/var/lib/portalpromo"
ENV_FILE="/etc/portalpromo.env"
REPOSITORY="${REPOSITORY:-https://github.com/gz-it/portalpromo.git}"
PUBLIC_URL="${PUBLIC_URL:-http://149.50.156.217}"

if [[ $EUID -ne 0 ]]; then
  echo "Este script debe ejecutarse como root." >&2
  exit 1
fi

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  rm -rf "$APP_DIR"
  git clone --branch main --single-branch "$REPOSITORY" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

install -d -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/uploads" "$DATA_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

runuser -u "$APP_USER" -- bash -c "cd '$APP_DIR' && npm install --omit=dev"

if [[ ! -f "$ENV_FILE" ]]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  ADMIN_PASSWORD="$(openssl rand -hex 12)"

  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
APP_URL=$PUBLIC_URL
DATABASE_URL=postgres://portalpromo:$DB_PASSWORD@127.0.0.1:5432/portalpromo
SESSION_SECRET=$SESSION_SECRET
SESSION_SECURE=false
MAX_UPLOAD_SIZE_MB=200
STORAGE_DRIVER=local
STORAGE_PATH=$DATA_DIR/uploads
BACKUP_PATH=$DATA_DIR/backups
INITIAL_ADMIN_EMAIL=admin@portalpromo.local
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=$ADMIN_PASSWORD
INITIAL_ADMIN_FIRST_NAME=Admin
INITIAL_ADMIN_LAST_NAME=Portal
GIT_REPOSITORY=$REPOSITORY
GIT_BRANCH=main
UPDATE_WORKDIR=$APP_DIR
PG_DUMP_BIN=pg_dump
NPM_BIN=npm
EOF
  chmod 600 "$ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

DB_PASSWORD="${DATABASE_URL#postgres://portalpromo:}"
DB_PASSWORD="${DB_PASSWORD%@127.0.0.1:5432/portalpromo}"
runuser -u postgres -- psql -v ON_ERROR_STOP=1 --command "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'portalpromo') THEN CREATE ROLE portalpromo LOGIN PASSWORD '$DB_PASSWORD'; ELSE ALTER ROLE portalpromo PASSWORD '$DB_PASSWORD'; END IF; END \$\$;"
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='portalpromo'" | grep -q 1; then
  runuser -u postgres -- createdb --owner=portalpromo portalpromo
fi

runuser -u "$APP_USER" -- npm --prefix "$APP_DIR" run migrate
runuser -u "$APP_USER" -- npm --prefix "$APP_DIR" run seed:admin

cat >/etc/systemd/system/portalpromo.service <<EOF
[Unit]
Description=Portal de Productores
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/nginx/sites-available/portalpromo <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 200M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/portalpromo /etc/nginx/sites-enabled/portalpromo
nginx -t
systemctl daemon-reload
systemctl enable --now portalpromo
systemctl restart nginx

for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1/health >/dev/null; then
    break
  fi
  if [[ $attempt -eq 20 ]]; then
    journalctl -u portalpromo --no-pager -n 80
    exit 1
  fi
  sleep 1
done

echo "PORTAL_READY=$PUBLIC_URL"
echo "INITIAL_ADMIN_EMAIL=$INITIAL_ADMIN_EMAIL"
echo "INITIAL_ADMIN_USERNAME=$INITIAL_ADMIN_USERNAME"
echo "INITIAL_ADMIN_PASSWORD=$INITIAL_ADMIN_PASSWORD"

# Recuperacion del Portal de Productores

## Que se conserva

`scripts/recovery-backup.js` crea un archivo `.ppr` cifrado con AES-256-GCM:
base PostgreSQL, adjuntos, configuracion y copia del codigo instalado.
El manifiesto incluye version, revision Git y hashes SHA-256. La copia del
codigo conserva tambien los cambios desplegados que aun no estan en Git.
No incluye Node.js, PostgreSQL, paquetes instalados, Nginx del servidor ni
certificados HTTPS: se preparan nuevamente en el VPS de destino.

El archivo incluye secretos. La clave debe guardarse fuera del VPS y por
separado del respaldo. Sin ella no es posible recuperar el archivo.
Un respaldo que solo permanece en el VPS no protege ante su perdida.

## Crear y verificar (Linux)

Desde el directorio de la aplicacion, como root:

```sh
node scripts/recovery-backup.js key --key /etc/portalpromo-recovery.key
```

La clave se crea una sola vez; no se sobrescribe. Para una copia consistente,
detener el portal durante la captura y reiniciarlo aunque el backup falle:

```sh
(
  set -eu
  trap 'systemctl start portalpromo' EXIT
  systemctl stop portalpromo
  DOTENV_CONFIG_PATH=/etc/portalpromo.env node -r dotenv/config scripts/recovery-backup.js create \
    --env /etc/portalpromo.env --key /etc/portalpromo-recovery.key \
    --output /var/lib/portalpromo/backups/recuperacion.ppr
)
node scripts/recovery-backup.js verify \
  --key /etc/portalpromo-recovery.key \
  --input /var/lib/portalpromo/backups/recuperacion.ppr
```

Cada backup debe tener un nombre nuevo. La herramienta no sobrescribe archivos.

## Recuperar en otro VPS

Preparar Linux, Node.js >=20, PostgreSQL de la misma version mayor o mas nueva,
una base vacia y el codigo desde Git. Mantener el servicio detenido.
Copiar el `.ppr` y la clave de recuperacion desde el almacenamiento externo.

```sh
export RESTORE_DATABASE_URL='postgres://usuario:clave@127.0.0.1:5432/base_nueva'
node scripts/recovery-backup.js restore \
  --input /ruta/recuperacion.ppr --key /ruta/portalpromo-recovery.key \
  --uploads /var/lib/portalpromo/uploads \
  --restored-env /etc/portalpromo.recuperado.env \
  --code /opt/portalpromo-recuperado --confirm RESTAURAR
unset RESTORE_DATABASE_URL
```

No sobrescribe bases con tablas, adjuntos existentes ni configuraciones.
El dump se restaura en una unica transaccion. Si falla la copia posterior de
archivos, el servicio debe permanecer detenido hasta resolver el problema.

La configuracion recuperada contiene los valores del VPS anterior: revisar
DATABASE_URL, APP_URL, STORAGE_PATH, BACKUP_PATH, PORT y UPDATE_WORKDIR.
Conservar SESSION_SECRET, porque protege las credenciales SMTP guardadas.
Instalar dependencias segun el lockfile, asignar permisos al usuario del
servicio, configurar systemd/Nginx y emitir certificados para el dominio.
Verificar login, eventos, aprobaciones y apertura/descarga de documentos.

## Estado de la automatizacion

El planificador existente del panel sigue generando backups `.dump` de la
base solamente. Esta herramienta agrega un respaldo completo manual;
su automatizacion y copia externa todavia deben configurarse. El envio por
correo tambien sigue pendiente de configurar SMTP y sus destinatarios.

## Prueba aislada

```sh
node -r dotenv/config scripts/review-sandbox.js dotenv_config_path=/etc/portalpromo.env
```

Crea bases temporales, recupera el respaldo completo en destinos nuevos y
compara los adjuntos byte a byte. No restaura sobre la base real.

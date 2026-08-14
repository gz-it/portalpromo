# Portal de Productores

Sistema web Express/PostgreSQL para productores, gerenciadoras y administradores de eventos. Mantiene archivos fuera de PostgreSQL, usa migraciones SQL y deja la lógica disponible desde rutas reutilizables para futuras apps móviles.

## Requisitos

- Linux para producción.
- Node.js 20 o superior.
- PostgreSQL 14 o superior.
- Nginx y Certbot para HTTPS.
- Git para despliegues y actualizaciones.
- `pg_dump` disponible para backups.

## Instalación

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed:admin
npm run dev
```

En producción use un gestor de procesos como `systemd` o `pm2` y ejecute `npm start`.

## PostgreSQL

Crear base y usuario:

```sql
create database portal_productores;
create user portal_user with encrypted password 'REEMPLAZAR';
grant all privileges on database portal_productores to portal_user;
```

Configurar `DATABASE_URL` en `.env`. Toda estructura se crea con `npm run migrate`. No se requieren cambios manuales en tablas.

## Primer Administrador

Definir en `.env`:

```env
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=una-clave-larga-y-segura
```

Luego ejecutar:

```bash
npm run seed:admin
```

La cuenta queda `ACTIVO` con rol `ADMINISTRADOR`.

## Variables de Entorno

Ver [.env.example](.env.example). Las principales son:

- `DATABASE_URL`: conexión PostgreSQL.
- `SESSION_SECRET`: secreto largo para sesiones.
- `APP_URL`: URL pública, usada en emails.
- `MAX_UPLOAD_SIZE_MB`: límite de subida, por defecto 200.
- `STORAGE_PATH`: carpeta local de archivos.
- `BACKUP_PATH`: carpeta de backups fuera de Git.
- `SMTP_*`: credenciales SMTP opcionales.
- `GIT_BRANCH`, `GIT_REPOSITORY`, `UPDATE_WORKDIR`: actualización controlada.

No guardar secretos reales en el repositorio.

## Funcionalidades

- Registro, login, logout, recuperación y cambio de contraseña.
- Estados de usuario: pendiente, activo, bloqueado y deshabilitado.
- Roles: administrador, productor y gerenciadora.
- Productores con múltiples eventos y 10 módulos por evento.
- Validación backend de acceso: productores solo acceden a sus eventos; gerenciadoras solo a eventos asignados.
- Identificación, productora por evento y personal manual o por Excel.
- Plantilla Excel, análisis, validación por fila e importación a PostgreSQL.
- Seguros, habilitaciones, servicios, prensa/assets, producción técnica, comercial/ticketing, sponsors, aceptación y ticketera.
- Adjuntos originales en almacenamiento local, metadata en PostgreSQL, límite configurable de 200 MB.
- Vista/descarga de archivos, PDF por módulo y ZIP completo de evento para administradores.
- Identidad configurable: nombre, título y logo.
- Updater administrativo registrado y script controlado de servidor.

## Producción

1. Clonar el repositorio en el servidor.
2. Crear `.env` con valores de producción.
3. Crear base PostgreSQL.
4. Ejecutar `npm install`, `npm run migrate`, `npm run seed:admin`.
5. Configurar servicio `systemd` apuntando a `npm start`.
6. Configurar Nginx usando [nginx/portal.conf.example](nginx/portal.conf.example).
7. Emitir certificado con Certbot.

Ejemplo Certbot:

```bash
sudo certbot --nginx -d portal-prueba.example.com
```

Para migrar de prueba a producción, cambiar DNS y variables `.env` (`APP_URL`, `DATABASE_URL`, rutas y SMTP) sin modificar código.

### Prueba gratuita en Render

El repositorio incluye `render.yaml` para crear el servicio web y PostgreSQL desde un Blueprint. En Render, elegir **New > Blueprint**, conectar el repositorio y completar `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_USERNAME` e `INITIAL_ADMIN_PASSWORD` (mínimo 12 caracteres).

El plan gratuito es solo para evaluación: la aplicación entra en reposo por inactividad, la base expira a los 30 días y el almacenamiento local de archivos no persiste entre reinicios o despliegues. Para producción se debe usar un disco persistente o almacenamiento S3 compatible.

## Nginx y HTTPS

La configuración de ejemplo incluye:

- `client_max_body_size 200M`.
- Reverse proxy a Node.
- Headers `X-Forwarded-*`.
- Timeouts para uploads grandes.
- Bloque para Let's Encrypt.

Reemplazar el dominio en la ruta del certificado una vez emitido.

## Almacenamiento

Los binarios subidos se guardan en `STORAGE_PATH`; PostgreSQL conserva nombre original, nombre interno, MIME, tamaño, usuario, evento, módulo y storage key. La capa está separada para reemplazar almacenamiento local por S3/MinIO posteriormente.

Respaldar siempre:

- Base PostgreSQL.
- `STORAGE_PATH`.
- `.env` de producción.

## Backups

```bash
npm run backup
```

El backup usa `pg_dump --format=custom` y escribe en `BACKUP_PATH`. Esta carpeta no debe estar dentro de rutas que Git pueda sobrescribir.

## Actualizaciones por Git

Desde Administración se registra el chequeo o solicitud. En el servidor, ejecutar el flujo controlado:

```bash
npm run update
```

El script:

1. Crea backup PostgreSQL.
2. Ejecuta `git fetch`.
3. Cambia a `GIT_BRANCH`.
4. Hace `git pull --ff-only`.
5. Instala dependencias.
6. Ejecuta migraciones.
7. Indica verificar `/health` y reiniciar el proceso.

No existe consola web para comandos arbitrarios.

## Pruebas Recomendadas

- Registro, aprobación, login, logout y recuperación.
- Productor A intentando abrir evento de Productor B por URL.
- Productor sin acceso a Administración.
- Gerenciadora con acceso solo al evento asignado.
- Usuario bloqueado sin login.
- Crear eventos con varias fechas.
- Descargar plantilla, importar Excel correcto y Excel con errores.
- Subir PDF, imagen, Excel y DOCX.
- Revisar los 10 módulos, observar, corregir y aprobar.
- Generar PDFs por módulo y ZIP completo.
- Revisar responsive en 375, 390, 430, 768, 1024 y desktop.

## Estructura

- `src/app.js`: aplicación Express, rutas y pantallas.
- `src/services`: settings, eventos, storage, Excel, PDF y ZIP.
- `src/middleware`: autenticación, autorización y CSRF.
- `migrations`: esquema PostgreSQL versionado.
- `scripts`: migración, admin inicial, backup y update.
- `src/public`: CSS/JS responsive.
- `nginx`: configuración de referencia.

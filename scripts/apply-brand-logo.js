const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('../src/config');
const db = require('../src/db');

async function main() {
  const source = path.join(config.root, 'src/public/images/logo-brand.png');
  const filename = `${randomUUID()}-logo-brand.png`;
  const directory = path.join(config.storagePath, 'system');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, filename);
  fs.copyFileSync(source, target);
  try {
    await db.tx(async (client) => {
      const actor = (await client.query(`select u.id from users u join user_roles ur on ur.user_id=u.id
        join roles r on r.id=ur.role_id where r.name='ADMINISTRADOR' order by u.created_at limit 1`)).rows[0];
      if (!actor) throw new Error('No hay administrador para registrar el cambio');
      const attachment = (await client.query(`insert into attachments
        (original_name,internal_name,storage_key,mime_type,size_bytes,uploaded_by)
        values($1,$2,$3,$4,$5,$6) returning id`,
      ['logo-brand.png', filename, `system/${filename}`, 'image/png', fs.statSync(target).size, actor.id])).rows[0];
      await client.query(`insert into system_settings(key,value,updated_by,updated_at)
        values('logo_attachment_id',$1,$2,now()) on conflict(key) do update
        set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [attachment.id, actor.id]);
    });
    console.log('Logo actualizado; se conserva el anterior para recuperarlo.');
  } catch (error) {
    fs.unlinkSync(target);
    throw error;
  } finally {
    await db.pool.end();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

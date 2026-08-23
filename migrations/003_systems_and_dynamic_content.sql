insert into roles (name, description) values
  ('SISTEMAS', 'Configuracion tecnica, correo y backups')
on conflict (name) do nothing;

insert into permissions (name, description) values
  ('systems.manage', 'Gestionar configuracion tecnica y backups'),
  ('backups.manage', 'Crear, descargar y restaurar backups')
on conflict (name) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
join permissions p on p.name in ('systems.manage', 'backups.manage', 'settings.manage', 'updates.run')
where r.name='SISTEMAS'
on conflict do nothing;

create table if not exists module_entries (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  module_key text not null,
  label text not null,
  value text,
  observation text,
  attachment_id uuid references attachments(id) on delete set null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists backup_runs (
  id uuid primary key default uuid_generate_v4(),
  filename text,
  storage_path text,
  source text not null default 'MANUAL',
  status text not null default 'RUNNING',
  size_bytes bigint,
  requested_by uuid references users(id),
  detail text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists module_entries_event_module_idx on module_entries(event_id, module_key, created_at desc);
create index if not exists backup_runs_created_idx on backup_runs(created_at desc);

insert into system_settings (key, value) values
  ('smtp_host', ''),
  ('smtp_port', '587'),
  ('smtp_secure', 'false'),
  ('smtp_user', ''),
  ('smtp_password_encrypted', ''),
  ('smtp_from', ''),
  ('backup_enabled', 'false'),
  ('backup_frequency', 'daily'),
  ('backup_email', ''),
  ('backup_send_file', 'false'),
  ('backup_retention_days', '30')
on conflict (key) do nothing;

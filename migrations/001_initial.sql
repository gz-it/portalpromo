create extension if not exists "uuid-ossp";
create extension if not exists citext;

create table if not exists roles (
  id serial primary key,
  name text unique not null,
  description text
);

create table if not exists permissions (
  id serial primary key,
  name text unique not null,
  description text
);

create table if not exists role_permissions (
  role_id int references roles(id) on delete cascade,
  permission_id int references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  first_name text not null,
  last_name text not null,
  email citext unique not null,
  phone text,
  username citext unique not null,
  password_hash text not null,
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE','ACTIVO','BLOQUEADO','DESHABILITADO')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_roles (
  user_id uuid references users(id) on delete cascade,
  role_id int references roles(id) on delete cascade,
  primary key (user_id, role_id)
);

create table if not exists password_reset_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default uuid_generate_v4(),
  owner_user_id uuid not null references users(id),
  created_by uuid references users(id),
  name text not null,
  artist text not null,
  venue text not null,
  city text not null,
  province text not null,
  status text not null default 'PENDIENTE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists event_dates (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  show_date date not null
);

create table if not exists event_manager_access (
  event_id uuid references events(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists event_companies (
  event_id uuid primary key references events(id) on delete cascade,
  legal_name text,
  cuit text,
  responsible text,
  phone text,
  email text,
  updated_at timestamptz not null default now()
);

create table if not exists event_modules (
  event_id uuid references events(id) on delete cascade,
  module_key text not null,
  module_name text not null,
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE','CARGADO','OBSERVADO','APROBADO')),
  updated_at timestamptz not null default now(),
  primary key (event_id, module_key)
);

create table if not exists module_status_history (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  module_key text not null,
  previous_status text,
  new_status text not null,
  observation text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists event_staff (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  cuit text not null,
  role_title text not null,
  company text,
  phone text,
  email text,
  import_batch_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists staff_imports (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  attachment_id uuid,
  total_rows int not null default 0,
  valid_rows int not null default 0,
  error_rows int not null default 0,
  errors jsonb not null default '[]',
  imported_by uuid references users(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists insurances (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  type text not null,
  valid_until date,
  observation text,
  attachment_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists permits (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  type text not null,
  reference_number text,
  observation text,
  attachment_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists mandatory_services (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  category text not null,
  provider text,
  observation text,
  attachment_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists assets (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  category text not null,
  observation text,
  attachment_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists technical_documents (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  category text not null,
  observation text,
  attachment_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists ticketing (
  event_id uuid primary key references events(id) on delete cascade,
  ticketing_name text,
  contact text,
  observations text,
  sales_url text,
  sales_date date,
  sales_observations text,
  updated_at timestamptz not null default now()
);

create table if not exists ticket_sectors (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  capacity int,
  price numeric(12,2),
  observation text
);

create table if not exists sales_phases (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  date_from date,
  date_to date
);

create table if not exists ticket_prices (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  sector_id uuid references ticket_sectors(id) on delete cascade,
  phase_id uuid references sales_phases(id) on delete cascade,
  price numeric(12,2) not null
);

create table if not exists courtesies (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  sector_id uuid references ticket_sectors(id) on delete set null,
  quantity int not null,
  observations text
);

create table if not exists promotions (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  entity text,
  card text,
  installments int,
  promotion text,
  valid_until date,
  observation text
);

create table if not exists sponsors (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  brand text not null,
  agreement_type text,
  description text,
  observation text,
  attachment_id uuid
);

create table if not exists club_agreements (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  title text not null,
  description text,
  attachment_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists ticketing_approvals (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  decision text not null check (decision in ('APROBADO','OBSERVADO')),
  comment text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists comments (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  module_key text,
  comment text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table if not exists attachments (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid references events(id) on delete cascade,
  module_key text,
  original_name text not null,
  internal_name text not null,
  storage_key text not null,
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists system_settings (
  key text primary key,
  value text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id),
  action text not null,
  entity_type text,
  entity_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists system_updates (
  id uuid primary key default uuid_generate_v4(),
  status text not null,
  current_version text,
  available_version text,
  started_by uuid references users(id),
  log text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_events_owner on events(owner_user_id);
create index if not exists idx_attachments_event_module on attachments(event_id, module_key);
create index if not exists idx_audit_created on audit_logs(created_at desc);
create index if not exists idx_module_history_event on module_status_history(event_id, module_key, created_at desc);

insert into roles (name, description) values
  ('ADMINISTRADOR','Acceso completo al sistema'),
  ('PRODUCTOR','Productor o promotor de eventos'),
  ('GERENCIADORA','Revisor autorizado por evento')
on conflict (name) do nothing;

insert into permissions (name, description) values
  ('admin.all','Administracion completa'),
  ('events.own','Gestionar eventos propios'),
  ('events.review','Revisar eventos autorizados'),
  ('files.manage','Gestionar archivos'),
  ('settings.manage','Gestionar configuracion'),
  ('updates.run','Ejecutar actualizaciones')
on conflict (name) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r cross join permissions p where r.name='ADMINISTRADOR'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.name in ('events.own','files.manage') where r.name='PRODUCTOR'
on conflict do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r join permissions p on p.name in ('events.review','files.manage') where r.name='GERENCIADORA'
on conflict do nothing;

insert into system_settings (key, value) values
  ('company_name','Portal de Productores'),
  ('portal_title','Portal de Productores'),
  ('logo_attachment_id', null),
  ('last_update_result', null)
on conflict (key) do nothing;

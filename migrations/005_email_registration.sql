alter table users add column if not exists email_verification_required boolean not null default false;
alter table users add column if not exists email_verified_at timestamptz;
create table if not exists email_verification_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

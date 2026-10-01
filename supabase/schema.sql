-- =====================================================================
-- Du Green Operations App — database schema (Supabase / Postgres)
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Team & roles ---------------------------------------------
-- Who may use the app. Add people here (or from the app's Team screen).
create table if not exists team (
  email text primary key,
  full_name text,
  role text not null default 'qs'
    check (role in ('admin','qs','horticulturist','procurement','viewer')),
  created_at timestamptz default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'pending',
  created_at timestamptz default now()
);

-- New sign-ups get the role listed for their email in `team`, else 'pending' (no access).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from team where lower(email) = lower(new.email);
  insert into profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(t.full_name, split_part(new.email,'@',1)), coalesce(t.role, 'pending'))
  on conflict (id) do update set role = excluded.role, email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep profile role in sync when an admin edits `team`.
create or replace function public.sync_team_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles set role = new.role, full_name = coalesce(new.full_name, full_name)
  where lower(email) = lower(new.email);
  return new;
end $$;
drop trigger if exists on_team_change on team;
create trigger on_team_change after insert or update on team
  for each row execute function public.sync_team_role();

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role not in ('pending'));
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- Core: projects and areas ---------------------------------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  code text, name text not null, client text, site_address text,
  kind text not null default 'installation' check (kind in ('installation','maintenance')),
  status text not null default 'tender',
  lat double precision, lng double precision, zoom int,
  vat_rate numeric not null default 0.15,
  notes text,
  created_by uuid references auth.users(id), created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists areas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  code text, name text, type text,
  source text not null default 'manual',          -- map | manual | kml
  geom jsonb,          -- {kind:'polygon'|'line'|'point', coords:[[lat,lng],...]}
  edges jsonb,         -- [{traced:m, measured:m|null}]
  shape jsonb,         -- manual dimensions, e.g. {kind:'rect', l:10, w:4}
  traced_area numeric, area_mode text default 'traced', area_override numeric,
  final_area numeric, final_length numeric, final_count numeric,
  notes text, photos jsonb default '[]', sort int default 0,
  created_by uuid references auth.users(id), created_at timestamptz default now(), updated_at timestamptz default now()
);

-- ---------- Specification (QS + Horticulturist) ----------------------
create table if not exists spec_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  area_id uuid references areas(id) on delete cascade,     -- null = site-wide
  item_key text not null,                                  -- groups the same product across areas
  category text, description text not null, spec text, unit text,
  qty_mode text default 'manual', rate numeric, qty numeric, allowance_pct numeric default 0,
  notes text, sort int default 0,
  created_by uuid references auth.users(id), created_at timestamptz default now(), updated_at timestamptz default now()
);

-- ---------- Suppliers & price library --------------------------------
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null, contact text, email text, phone text, categories text, notes text,
  created_at timestamptz default now()
);

create table if not exists library_prices (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id) on delete cascade,
  item_key text not null, description text, spec text, unit text,
  unit_price numeric not null, price_date date default current_date,
  source text default 'manual',                             -- manual | quote
  quote_id uuid, project_id uuid,
  created_at timestamptz default now()
);
create index if not exists library_prices_key on library_prices(item_key);

-- ---------- RFQs, quotes, selections, POs ----------------------------
create table if not exists rfqs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number text, title text, status text default 'draft', due_date date, notes text,
  supplier_ids jsonb default '[]',
  created_by uuid references auth.users(id), created_at timestamptz default now()
);
create table if not exists rfq_lines (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  item_key text not null, category text, description text, spec text, unit text, qty numeric,
  extra boolean default false, sort int default 0
);
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  rfq_id uuid references rfqs(id) on delete set null,
  supplier_id uuid references suppliers(id) on delete cascade,
  quote_ref text, quote_date date, valid_until date, vat_included boolean default false,
  file_path text, file_name text, read_by text default 'manual', notes text,
  created_by uuid references auth.users(id), created_at timestamptz default now()
);
create table if not exists quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  item_key text, description text, spec text, unit text, qty numeric, unit_price numeric, lead_time text, notes text
);
create table if not exists selections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  item_key text not null, supplier_id uuid references suppliers(id) on delete set null,
  unit_price numeric, source text, quote_line_id uuid, library_price_id uuid,
  selected_by uuid references auth.users(id), created_at timestamptz default now(),
  unique (project_id, item_key)
);
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  supplier_id uuid references suppliers(id),
  number text, status text default 'draft', po_date date default current_date,
  delivery text, notes text, vat_rate numeric default 0.15,
  created_by uuid references auth.users(id), created_at timestamptz default now()
);
create table if not exists po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  item_key text, description text, spec text, unit text, qty numeric, unit_price numeric, sort int default 0
);

-- ---------- Costing (mark-up per item, no default ratio) -------------
create table if not exists costing (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  item_key text not null, markup_pct numeric, sell_override numeric, cost_override numeric, notes text,
  unique (project_id, item_key)
);

-- ---------- Claude conversation log (optional) -----------------------
create table if not exists claude_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  kind text, question text, answer text,
  created_by uuid references auth.users(id), created_at timestamptz default now()
);

-- ---------- Row-level security ---------------------------------------
do $$
declare t text;
begin
  foreach t in array array['projects','areas','spec_items','suppliers','library_prices','rfqs','rfq_lines',
                           'quotes','quote_lines','selections','purchase_orders','po_lines','costing','claude_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists members_all on %I', t);
    execute format('create policy members_all on %I for all to authenticated using (public.is_member()) with check (public.is_member())', t);
  end loop;
end $$;

alter table profiles enable row level security;
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated using (id = auth.uid() or public.is_member());

alter table team enable row level security;
drop policy if exists team_read on team;
create policy team_read on team for select to authenticated using (public.is_member());
drop policy if exists team_write on team;
create policy team_write on team for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- File storage (supplier quotes, site photos) --------------
insert into storage.buckets (id, name, public) values ('quotes','quotes', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('photos','photos', false) on conflict (id) do nothing;
drop policy if exists dg_files_rw on storage.objects;
create policy dg_files_rw on storage.objects for all to authenticated
  using (bucket_id in ('quotes','photos') and public.is_member())
  with check (bucket_id in ('quotes','photos') and public.is_member());

-- ---------- Starting team (edit emails/roles as needed) --------------
insert into team (email, full_name, role) values
  ('dugreen.ai@gmail.com','Matt Harmer','admin'),
  ('dugreensystems@gmail.com','Du Green Systems','admin'),
  ('dugreenspencer@gmail.com','Spencer (QS)','qs'),
  ('procurement.dugreen@gmail.com','Procurement Officer','procurement')
on conflict (email) do nothing;

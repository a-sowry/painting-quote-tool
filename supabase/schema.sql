-- PaintQuote database. Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Every painter can only ever see their own rows (row level security).

create table if not exists public.painters (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,        -- business details, prices, services, paint, profile
  updated_at timestamptz not null default now()
);

create table if not exists public.quotes (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  number text,
  customer_name text,
  total numeric,
  quote_date text,
  draft jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- One row per photo / roof lookup, so each painter can be held to a monthly limit.
-- Only the server functions (service role) can read or write this - painters cannot.
create table if not exists public.usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);
create index if not exists usage_user_kind_time on public.usage (user_id, kind, created_at);

alter table public.painters enable row level security;
alter table public.quotes   enable row level security;
alter table public.usage    enable row level security;

drop policy if exists "own settings" on public.painters;
create policy "own settings" on public.painters
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "own quotes" on public.quotes;
create policy "own quotes" on public.quotes
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Tables are not exposed to the API automatically, so grant access deliberately.
grant select, insert, update, delete on public.painters to authenticated;
grant select, insert, update, delete on public.quotes   to authenticated;
revoke all on public.usage from anon, authenticated;
grant all on public.usage to service_role;
grant usage, select on sequence public.usage_id_seq to service_role;

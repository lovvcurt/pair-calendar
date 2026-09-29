-- Telegram identities can only be mapped to Supabase accounts by the Edge Function.
-- Never expose this mapping through the public Data API or Realtime.
create table public.telegram_accounts (
  telegram_user_id text primary key check (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now()
);

alter table public.telegram_accounts enable row level security;

revoke all on public.telegram_accounts from public, anon, authenticated, service_role;
grant select, insert on public.telegram_accounts to service_role;

comment on table public.telegram_accounts is
  'Private mapping from a server-verified Telegram user ID to one Supabase Auth user. No client or Realtime access.';

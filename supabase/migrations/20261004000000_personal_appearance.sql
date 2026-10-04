-- Private appearance preferences: each partner controls only their own devices.
create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme_mode text not null default 'dark' check (theme_mode in ('dark', 'light', 'system')),
  palette text not null default 'mint' check (palette in ('mint', 'ocean', 'rose', 'lavender', 'amber', 'berry')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

drop policy if exists "users read own appearance" on public.user_preferences;
drop policy if exists "users create own appearance" on public.user_preferences;
drop policy if exists "users update own appearance" on public.user_preferences;
create policy "users read own appearance" on public.user_preferences
  for select to authenticated using (user_id = (select auth.uid()));
create policy "users create own appearance" on public.user_preferences
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "users update own appearance" on public.user_preferences
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.user_preferences to authenticated;

drop trigger if exists user_preferences_updated_at on public.user_preferences;
create trigger user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- Realtime remains restricted by the user's own-row RLS policies above.
do $$ begin
  alter publication supabase_realtime add table public.user_preferences;
exception when duplicate_object or undefined_object then null; end $$;

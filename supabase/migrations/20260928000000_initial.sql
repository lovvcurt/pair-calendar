-- Pair Calendar: initial schema. Apply in Supabase SQL Editor or with `supabase db push`.
create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.couples (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Наш календарь',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.couple_members (
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (couple_id, user_id),
  unique (user_id)
);
create index couple_members_user_idx on public.couple_members(user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,
  accepted_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index invitations_couple_idx on public.invitations(couple_id, expires_at);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 32),
  color text not null default '#a6e3b0' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (couple_id, label)
);
create index tags_couple_idx on public.tags(couple_id);

-- The event row contains only data partners may need for availability. Sensitive
-- descriptions, names, places, reminders and tags live behind their own RLS policy.
create table public.events (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  timezone text not null default 'UTC',
  visibility text not null default 'full' check (visibility in ('full', 'busy', 'private')),
  surprise_until timestamptz,
  recurrence_frequency text check (recurrence_frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  recurrence_interval integer not null default 1 check (recurrence_interval between 1 and 365),
  recurrence_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_times_ordered check (ends_at > starts_at),
  constraint recurrence_end_not_before_start check (recurrence_until is null or recurrence_until >= (starts_at at time zone timezone)::date)
);
create index events_couple_start_idx on public.events(couple_id, starts_at);
create index events_owner_idx on public.events(owner_id, starts_at);

create table public.event_details (
  event_id uuid primary key references public.events(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 160),
  description text not null default '',
  place text not null default '',
  address text not null default '',
  latitude double precision,
  longitude double precision,
  category text not null default 'Другое',
  tags text[] not null default '{}',
  color text not null default '#a6e3b0' check (color ~ '^#[0-9a-fA-F]{6}$'),
  reminders jsonb not null default '[]'::jsonb check (jsonb_typeof(reminders) = 'array'),
  updated_at timestamptz not null default now(),
  constraint valid_coordinates check (
    (latitude is null and longitude is null) or
    (latitude between -90 and 90 and longitude between -180 and 180)
  )
);

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  question text not null check (length(trim(question)) between 1 and 180),
  description text not null default '',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index polls_couple_idx on public.polls(couple_id, created_at desc);
create table public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 180),
  starts_at timestamptz,
  ends_at timestamptz,
  sort_order integer not null default 0,
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index poll_options_poll_idx on public.poll_options(poll_id, sort_order);
create table public.poll_votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (poll_id, user_id)
);
create index poll_votes_option_idx on public.poll_votes(option_id);

create table public.date_ideas (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text not null check (length(trim(title)) between 1 and 160),
  description text not null default '',
  tags text[] not null default '{}',
  status text not null default 'idea' check (status in ('idea', 'chosen', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index date_ideas_couple_idx on public.date_ideas(couple_id, created_at desc);

create table public.important_dates (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text not null check (length(trim(title)) between 1 and 120),
  event_date date not null,
  repeats_yearly boolean not null default true,
  reminder_days integer not null default 1 check (reminder_days between 0 and 365),
  created_at timestamptz not null default now()
);
create index important_dates_couple_date_idx on public.important_dates(couple_id, event_date);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger events_updated_at before update on public.events for each row execute function public.set_updated_at();
create trigger polls_updated_at before update on public.polls for each row execute function public.set_updated_at();
create trigger date_ideas_updated_at before update on public.date_ideas for each row execute function public.set_updated_at();

create or replace function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger auth_user_profile after insert on auth.users for each row execute function public.create_profile_for_auth_user();

-- SECURITY DEFINER avoids recursive RLS checks when validating membership.
create or replace function public.is_couple_member(p_couple_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.couple_members m
    where m.couple_id = p_couple_id and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_couple_member(uuid) from public;
grant execute on function public.is_couple_member(uuid) to authenticated;

create or replace function public.create_couple(p_name text default 'Наш календарь')
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Требуется вход'; end if;
  if exists (select 1 from public.couple_members where user_id = auth.uid()) then
    raise exception 'У вас уже есть календарь пары';
  end if;
  insert into public.profiles(id, display_name)
  values (auth.uid(), coalesce((select raw_user_meta_data->>'display_name' from auth.users where id = auth.uid()), ''))
  on conflict (id) do nothing;
  insert into public.couples(name, created_by)
  values (coalesce(nullif(trim(p_name), ''), 'Наш календарь'), auth.uid()) returning id into new_id;
  insert into public.couple_members(couple_id, user_id, role) values (new_id, auth.uid(), 'owner');
  return new_id;
end;
$$;
revoke all on function public.create_couple(text) from public;
grant execute on function public.create_couple(text) to authenticated;

create or replace function public.create_invitation(p_couple_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare plain_token text; member_count integer;
begin
  if auth.uid() is null or not public.is_couple_member(p_couple_id) then raise exception 'Нет доступа к календарю'; end if;
  perform 1 from public.couples where id = p_couple_id for update;
  select count(*) into member_count from public.couple_members where couple_id = p_couple_id;
  if member_count >= 2 then raise exception 'В календаре уже два участника'; end if;
  plain_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.invitations(couple_id, token_hash, created_by, expires_at)
  values (p_couple_id, encode(extensions.digest(plain_token, 'sha256'), 'hex'), auth.uid(), now() + interval '7 days');
  return plain_token;
end;
$$;
revoke all on function public.create_invitation(uuid) from public;
grant execute on function public.create_invitation(uuid) to authenticated;

create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare invite public.invitations%rowtype; member_count integer;
begin
  if auth.uid() is null then raise exception 'Сначала войдите или создайте аккаунт'; end if;
  if length(coalesce(p_token, '')) <> 64 then raise exception 'Приглашение недействительно или устарело'; end if;
  select * into invite from public.invitations
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      and used_at is null and expires_at > now()
    for update;
  if invite.id is null then raise exception 'Приглашение недействительно, уже использовано или истекло'; end if;
  perform 1 from public.couples where id = invite.couple_id for update;
  if exists (select 1 from public.couple_members where user_id = auth.uid()) then
    raise exception 'У вас уже есть календарь пары';
  end if;
  select count(*) into member_count from public.couple_members where couple_id = invite.couple_id;
  if member_count >= 2 then raise exception 'В календаре уже два участника'; end if;
  insert into public.profiles(id, display_name)
    values (auth.uid(), coalesce((select raw_user_meta_data->>'display_name' from auth.users where id = auth.uid()), ''))
    on conflict (id) do nothing;
  insert into public.couple_members(couple_id, user_id, role) values (invite.couple_id, auth.uid(), 'member');
  update public.invitations set used_at = now(), accepted_by = auth.uid() where id = invite.id;
  return invite.couple_id;
end;
$$;
revoke all on function public.accept_invitation(text) from public;
grant execute on function public.accept_invitation(text) to authenticated;

-- One transaction per event save. expected_updated_at prevents silent last-write-wins edits.
create or replace function public.save_calendar_event(p_event jsonb, p_details jsonb, p_expected_updated_at timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare event_id uuid; existing public.events%rowtype; saved_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Требуется вход'; end if;
  event_id := coalesce((p_event->>'id')::uuid, gen_random_uuid());
  if not public.is_couple_member((p_event->>'couple_id')::uuid) then raise exception 'Нет доступа к календарю'; end if;
  if p_event->>'visibility' is null or p_event->>'visibility' not in ('full', 'busy', 'private') then raise exception 'Некорректная видимость'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = coalesce(nullif(p_event->>'timezone', ''), 'UTC')) then
    raise exception 'Неизвестный часовой пояс';
  end if;
  select * into existing from public.events where id = event_id for update;
  if existing.id is not null then
    if existing.owner_id <> auth.uid() then raise exception 'Изменять событие может только его автор'; end if;
    if existing.couple_id <> (p_event->>'couple_id')::uuid then raise exception 'Нельзя перенести событие в другой календарь'; end if;
    if p_expected_updated_at is null or existing.updated_at <> p_expected_updated_at then
      raise exception using errcode = '40001', message = 'Событие изменилось на другом устройстве. Обновите календарь и повторите правку.';
    end if;
    update public.events set
      starts_at = (p_event->>'starts_at')::timestamptz,
      ends_at = (p_event->>'ends_at')::timestamptz,
      all_day = coalesce((p_event->>'all_day')::boolean, false),
      timezone = coalesce(nullif(p_event->>'timezone', ''), 'UTC'),
      visibility = p_event->>'visibility',
      surprise_until = nullif(p_event->>'surprise_until', '')::timestamptz,
      recurrence_frequency = nullif(p_event->>'recurrence_frequency', ''),
      recurrence_interval = coalesce(nullif(p_event->>'recurrence_interval', '')::integer, 1),
      recurrence_until = nullif(p_event->>'recurrence_until', '')::date
    where id = event_id returning updated_at into saved_at;
  else
    insert into public.events(id, couple_id, owner_id, starts_at, ends_at, all_day, timezone, visibility, surprise_until, recurrence_frequency, recurrence_interval, recurrence_until)
    values (
      event_id, (p_event->>'couple_id')::uuid, auth.uid(),
      (p_event->>'starts_at')::timestamptz, (p_event->>'ends_at')::timestamptz,
      coalesce((p_event->>'all_day')::boolean, false), coalesce(nullif(p_event->>'timezone', ''), 'UTC'),
      p_event->>'visibility', nullif(p_event->>'surprise_until', '')::timestamptz,
      nullif(p_event->>'recurrence_frequency', ''), coalesce(nullif(p_event->>'recurrence_interval', '')::integer, 1),
      nullif(p_event->>'recurrence_until', '')::date
    ) returning updated_at into saved_at;
  end if;
  insert into public.event_details(event_id, title, description, place, address, latitude, longitude, category, tags, color, reminders)
  values (
    event_id, p_details->>'title', coalesce(p_details->>'description', ''), coalesce(p_details->>'place', ''), coalesce(p_details->>'address', ''),
    nullif(p_details->>'latitude', '')::double precision, nullif(p_details->>'longitude', '')::double precision,
    coalesce(p_details->>'category', 'Другое'), coalesce(array(select jsonb_array_elements_text(coalesce(p_details->'tags', '[]'::jsonb))), '{}'),
    coalesce(p_details->>'color', '#a6e3b0'), coalesce(p_details->'reminders', '[]'::jsonb)
  ) on conflict (event_id) do update set
    title = excluded.title, description = excluded.description, place = excluded.place, address = excluded.address,
    latitude = excluded.latitude, longitude = excluded.longitude, category = excluded.category, tags = excluded.tags,
    color = excluded.color, reminders = excluded.reminders, updated_at = now();
  return saved_at;
end;
$$;
revoke all on function public.save_calendar_event(jsonb, jsonb, timestamptz) from public;
grant execute on function public.save_calendar_event(jsonb, jsonb, timestamptz) to authenticated;

create or replace function public.delete_calendar_event(p_event_id uuid, p_expected_updated_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare existing public.events%rowtype;
begin
  if auth.uid() is null then raise exception 'Требуется вход'; end if;
  select * into existing from public.events where id = p_event_id for update;
  if existing.id is null or existing.owner_id <> auth.uid() then raise exception 'Удалить событие может только его автор'; end if;
  if p_expected_updated_at is null or existing.updated_at <> p_expected_updated_at then
    raise exception using errcode = '40001', message = 'Событие изменилось на другом устройстве. Обновите календарь и повторите удаление.';
  end if;
  delete from public.events where id = p_event_id;
end;
$$;
revoke all on function public.delete_calendar_event(uuid, timestamptz) from public;
grant execute on function public.delete_calendar_event(uuid, timestamptz) to authenticated;

create or replace function public.cast_poll_vote(p_poll_id uuid, p_option_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare poll_couple uuid;
begin
  select couple_id into poll_couple from public.polls where id = p_poll_id;
  if poll_couple is null or not public.is_couple_member(poll_couple) then raise exception 'Опрос не найден'; end if;
  if not exists (select 1 from public.poll_options where id = p_option_id and poll_id = p_poll_id) then raise exception 'Вариант опроса не найден'; end if;
  insert into public.poll_votes(poll_id, option_id, user_id) values (p_poll_id, p_option_id, auth.uid())
    on conflict (poll_id, user_id) do update set option_id = excluded.option_id, created_at = now();
end;
$$;
revoke all on function public.cast_poll_vote(uuid, uuid) from public;
grant execute on function public.cast_poll_vote(uuid, uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.couples enable row level security;
alter table public.couple_members enable row level security;
alter table public.invitations enable row level security;
alter table public.tags enable row level security;
alter table public.events enable row level security;
alter table public.event_details enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.date_ideas enable row level security;
alter table public.important_dates enable row level security;

create policy "profiles read self and partner" on public.profiles for select to authenticated using (
  id = (select auth.uid()) or exists (
    select 1 from public.couple_members mine join public.couple_members theirs using (couple_id)
    where mine.user_id = (select auth.uid()) and theirs.user_id = profiles.id
  )
);
create policy "profiles update self" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "couples read members" on public.couples for select to authenticated using (public.is_couple_member(id));
create policy "members read household" on public.couple_members for select to authenticated using (public.is_couple_member(couple_id));
-- No direct client access to invitation tokens: only the one-time RPCs can create/consume them.
create policy "tags read members" on public.tags for select to authenticated using (public.is_couple_member(couple_id));
create policy "tags insert members" on public.tags for insert to authenticated with check (public.is_couple_member(couple_id) and created_by = (select auth.uid()));
create policy "tags update members" on public.tags for update to authenticated using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy "tags delete members" on public.tags for delete to authenticated using (public.is_couple_member(couple_id));

create policy "read event blocks allowed by visibility" on public.events for select to authenticated using (
  public.is_couple_member(couple_id) and (owner_id = (select auth.uid()) or visibility <> 'private')
);
create policy "read event details allowed by visibility and reveal time" on public.event_details for select to authenticated using (
  exists (
    select 1 from public.events e
    where e.id = event_details.event_id and public.is_couple_member(e.couple_id)
      and (e.owner_id = (select auth.uid()) or (e.visibility = 'full' and (e.surprise_until is null or e.surprise_until <= now())))
  )
);
-- Event writes use save/delete RPCs so the base row and private payload commit atomically.

create policy "polls read members" on public.polls for select to authenticated using (public.is_couple_member(couple_id));
create policy "polls create members" on public.polls for insert to authenticated with check (public.is_couple_member(couple_id) and created_by = (select auth.uid()));
create policy "polls update author" on public.polls for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "polls delete author" on public.polls for delete to authenticated using (created_by = (select auth.uid()));
create policy "poll options read members" on public.poll_options for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and public.is_couple_member(p.couple_id))
);
create policy "poll options insert author" on public.poll_options for insert to authenticated with check (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.created_by = (select auth.uid()))
);
create policy "poll options edit author" on public.poll_options for update to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.created_by = (select auth.uid()))
) with check (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.created_by = (select auth.uid()))
);
create policy "poll options delete author" on public.poll_options for delete to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_options.poll_id and p.created_by = (select auth.uid()))
);
create policy "votes read members" on public.poll_votes for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_votes.poll_id and public.is_couple_member(p.couple_id))
);
-- Cast/change vote is only available through cast_poll_vote RPC.

create policy "ideas read members" on public.date_ideas for select to authenticated using (public.is_couple_member(couple_id));
create policy "ideas create members" on public.date_ideas for insert to authenticated with check (public.is_couple_member(couple_id) and created_by = (select auth.uid()));
create policy "ideas update members" on public.date_ideas for update to authenticated using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy "ideas delete members" on public.date_ideas for delete to authenticated using (public.is_couple_member(couple_id));
create policy "important dates read members" on public.important_dates for select to authenticated using (public.is_couple_member(couple_id));
create policy "important dates create members" on public.important_dates for insert to authenticated with check (public.is_couple_member(couple_id) and created_by = (select auth.uid()));
create policy "important dates update members" on public.important_dates for update to authenticated using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy "important dates delete members" on public.important_dates for delete to authenticated using (public.is_couple_member(couple_id));

grant select, update on public.profiles to authenticated;
grant select on public.couples, public.couple_members, public.events, public.event_details, public.poll_votes to authenticated;
grant select, insert, update, delete on public.tags, public.polls, public.poll_options, public.date_ideas, public.important_dates to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select, insert, update, delete on public.event_details to authenticated;

-- Private avatar objects at <user-uuid>/avatar.<ext>. Never make this bucket public.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;

create policy "avatar owner or partner can read" on storage.objects for select to authenticated using (
  bucket_id = 'avatars' and (
    (storage.foldername(name))[1] = (select auth.uid())::text or exists (
      select 1 from public.couple_members mine join public.couple_members owner_member using (couple_id)
      where mine.user_id = (select auth.uid()) and owner_member.user_id::text = (storage.foldername(name))[1]
    )
  )
);
create policy "avatar owner can upload" on storage.objects for insert to authenticated with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
);
create policy "avatar owner can replace" on storage.objects for update to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
) with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatar owner can delete" on storage.objects for delete to authenticated using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Keep only necessary tables in the Realtime publication; row policies still govern reads.
do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.event_details;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.polls;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.poll_options;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.poll_votes;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.date_ideas;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.important_dates;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.tags;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object or undefined_object then null; end $$;

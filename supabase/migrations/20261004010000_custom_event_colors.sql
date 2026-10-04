-- Optional user-selected colors for the two event owners.
-- NULL means the selected built-in palette supplies that owner's color.
alter table public.user_preferences
  add column if not exists my_event_color text,
  add column if not exists partner_event_color text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_preferences_my_event_color_hex_check'
      and conrelid = 'public.user_preferences'::regclass
  ) then
    alter table public.user_preferences
      add constraint user_preferences_my_event_color_hex_check
      check (my_event_color is null or my_event_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_preferences_partner_event_color_hex_check'
      and conrelid = 'public.user_preferences'::regclass
  ) then
    alter table public.user_preferences
      add constraint user_preferences_partner_event_color_hex_check
      check (partner_event_color is null or partner_event_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end $$;

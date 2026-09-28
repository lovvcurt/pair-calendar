-- Replace save_calendar_event with an unambiguous local event id variable.
-- Apply this patch to databases where the initial migration was already run.
create or replace function public.save_calendar_event(p_event jsonb, p_details jsonb, p_expected_updated_at timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_event_id uuid; existing public.events%rowtype; saved_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Требуется вход'; end if;
  v_event_id := coalesce((p_event->>'id')::uuid, gen_random_uuid());
  if not public.is_couple_member((p_event->>'couple_id')::uuid) then raise exception 'Нет доступа к календарю'; end if;
  if p_event->>'visibility' is null or p_event->>'visibility' not in ('full', 'busy', 'private') then raise exception 'Некорректная видимость'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = coalesce(nullif(p_event->>'timezone', ''), 'UTC')) then
    raise exception 'Неизвестный часовой пояс';
  end if;
  select * into existing from public.events where id = v_event_id for update;
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
    where id = v_event_id returning updated_at into saved_at;
  else
    insert into public.events(id, couple_id, owner_id, starts_at, ends_at, all_day, timezone, visibility, surprise_until, recurrence_frequency, recurrence_interval, recurrence_until)
    values (
      v_event_id, (p_event->>'couple_id')::uuid, auth.uid(),
      (p_event->>'starts_at')::timestamptz, (p_event->>'ends_at')::timestamptz,
      coalesce((p_event->>'all_day')::boolean, false), coalesce(nullif(p_event->>'timezone', ''), 'UTC'),
      p_event->>'visibility', nullif(p_event->>'surprise_until', '')::timestamptz,
      nullif(p_event->>'recurrence_frequency', ''), coalesce(nullif(p_event->>'recurrence_interval', '')::integer, 1),
      nullif(p_event->>'recurrence_until', '')::date
    ) returning updated_at into saved_at;
  end if;
  insert into public.event_details(event_id, title, description, place, address, latitude, longitude, category, tags, color, reminders)
  values (
    v_event_id, p_details->>'title', coalesce(p_details->>'description', ''), coalesce(p_details->>'place', ''), coalesce(p_details->>'address', ''),
    nullif(p_details->>'latitude', '')::double precision, nullif(p_details->>'longitude', '')::double precision,
    coalesce(p_details->>'category', 'Другое'), coalesce(array(select jsonb_array_elements_text(coalesce(p_details->'tags', '[]'::jsonb))), '{}'),
    coalesce(p_details->>'color', '#a6e3b0'), coalesce(p_details->'reminders', '[]'::jsonb)
  ) on conflict on constraint event_details_pkey do update set
    title = excluded.title, description = excluded.description, place = excluded.place, address = excluded.address,
    latitude = excluded.latitude, longitude = excluded.longitude, category = excluded.category, tags = excluded.tags,
    color = excluded.color, reminders = excluded.reminders, updated_at = now();
  return saved_at;
end;
$$;
revoke all on function public.save_calendar_event(jsonb, jsonb, timestamptz) from public;
grant execute on function public.save_calendar_event(jsonb, jsonb, timestamptz) to authenticated;

-- Private per-device Web Push endpoints. Endpoints are capability URLs and must
-- never be readable by another member of the couple.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_secret text not null,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
create policy "push subscriptions read own" on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "push subscriptions add own" on public.push_subscriptions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "push subscriptions update own" on public.push_subscriptions
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "push subscriptions delete own" on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.push_subscriptions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, delete on public.push_subscriptions to service_role;

-- This internal table prevents duplicate deliveries when adjacent minute jobs overlap.
create table public.push_notification_deliveries (
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  notification_key text not null,
  status text not null check (status in ('processing', 'sent', 'failed')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 1,
  last_error text,
  primary key (subscription_id, notification_key)
);
alter table public.push_notification_deliveries enable row level security;
revoke all on public.push_notification_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.push_notification_deliveries to service_role;

create or replace function public.claim_push_delivery(p_subscription_id uuid, p_notification_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_claimed boolean := false;
begin
  insert into public.push_notification_deliveries(subscription_id, notification_key, status, claimed_at, attempts)
  values (p_subscription_id, p_notification_key, 'processing', now(), 1)
  on conflict (subscription_id, notification_key) do update
    set status = 'processing', claimed_at = now(), attempts = public.push_notification_deliveries.attempts + 1, last_error = null
    where public.push_notification_deliveries.status = 'failed'
       or (public.push_notification_deliveries.status = 'processing' and public.push_notification_deliveries.claimed_at < now() - interval '5 minutes')
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;
revoke all on function public.claim_push_delivery(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_push_delivery(uuid, text) to service_role;

create or replace function public.finish_push_delivery(p_subscription_id uuid, p_notification_key text, p_sent boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.push_notification_deliveries
  set status = case when p_sent then 'sent' else 'failed' end,
      sent_at = case when p_sent then now() else null end,
      last_error = case when p_sent then null else left(coalesce(p_error, 'Push delivery failed'), 500) end
  where subscription_id = p_subscription_id and notification_key = p_notification_key;
$$;
revoke all on function public.finish_push_delivery(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_push_delivery(uuid, text, boolean, text) to service_role;

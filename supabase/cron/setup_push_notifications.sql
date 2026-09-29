-- Before running, add these exact name/value pairs in Supabase Dashboard → Database → Vault:
-- pair_push_function_url = https://YOUR-PROJECT-REF.supabase.co/functions/v1/push-reminders
-- pair_push_apikey = your public sb_publishable_... key
-- pair_push_cron_secret = the same random value as the Edge Function PUSH_CRON_SECRET
-- Do not put private VAPID or Supabase service_role keys in this file.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'pair-calendar-push-reminders';

select cron.schedule(
  'pair-calendar-push-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'pair_push_function_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'pair_push_apikey'),
        'x-push-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pair_push_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);

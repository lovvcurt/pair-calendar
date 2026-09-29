import { createClient } from 'supabase';
import webpush from 'web-push';

type EventReminderRow = {
  id: string;
  couple_id: string;
  owner_id: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string;
  visibility: 'full' | 'busy' | 'private';
  surprise_until: string | null;
  recurrence_frequency: Frequency | null;
  recurrence_interval: number;
  recurrence_until: string | null;
  event_details: { title: string; reminders: { minutes: number }[] } | null;
};
type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };
type Occurrence = { startsAt: Date };
type Subscription = { id: string; user_id: string; endpoint: string; p256dh: string; auth_secret: string; timezone: string };

const minute = 60_000;
const maxReminderMinutes = 10_080;
const lookAheadMs = (maxReminderMinutes + 2) * minute;

function wallTime(date: Date, timezone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

function dateTimeInZone(wall: WallTime, timezone: string): Date {
  const wanted = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let candidate = wanted;
  for (let index = 0; index < 4; index++) {
    const actual = wallTime(new Date(candidate), timezone);
    candidate += wanted - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  }
  return new Date(candidate);
}

function addCalendarUnit(wall: WallTime, frequency: Frequency, amount: number, anchorDay: number): WallTime {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  if (frequency === 'daily') date.setUTCDate(date.getUTCDate() + amount);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + amount * 7);
  if (frequency === 'monthly') {
    const targetMonth = date.getUTCMonth() + amount;
    const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
    const month = ((targetMonth % 12) + 12) % 12;
    date.setUTCFullYear(targetYear, month, Math.min(anchorDay, new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate()));
  }
  if (frequency === 'yearly') {
    const year = date.getUTCFullYear() + amount;
    date.setUTCFullYear(year, date.getUTCMonth(), Math.min(anchorDay, new Date(Date.UTC(year, date.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

function eventOccurrences(event: EventReminderRow, from: Date, to: Date): Occurrence[] {
  const start = new Date(event.starts_at);
  if (!event.recurrence_frequency) return start >= from && start <= to ? [{ startsAt: start }] : [];
  const timezone = event.timezone || 'UTC';
  const startWall = wallTime(start, timezone);
  const fromWall = wallTime(from, timezone);
  const dayDelta = Math.floor((Date.UTC(fromWall.year, fromWall.month - 1, fromWall.day) - Date.UTC(startWall.year, startWall.month - 1, startWall.day)) / 86_400_000);
  const monthDelta = (fromWall.year - startWall.year) * 12 + fromWall.month - startWall.month;
  const interval = Math.max(1, event.recurrence_interval || 1);
  const rawSteps = event.recurrence_frequency === 'daily' ? Math.floor(dayDelta / interval)
    : event.recurrence_frequency === 'weekly' ? Math.floor(dayDelta / (7 * interval))
      : event.recurrence_frequency === 'monthly' ? Math.floor(monthDelta / interval)
        : Math.floor((fromWall.year - startWall.year) / interval);
  let count = Math.max(0, rawSteps - 1);
  let cursorWall = count ? addCalendarUnit(startWall, event.recurrence_frequency, count * interval, startWall.day) : startWall;
  let cursor = count ? dateTimeInZone(cursorWall, timezone) : start;
  const output: Occurrence[] = [];
  for (let iterations = 0; cursor <= to && iterations < 500; iterations++) {
    const localDate = `${cursorWall.year}-${String(cursorWall.month).padStart(2, '0')}-${String(cursorWall.day).padStart(2, '0')}`;
    if (event.recurrence_until && localDate > event.recurrence_until) break;
    if (cursor >= from) output.push({ startsAt: cursor });
    cursorWall = addCalendarUnit(cursorWall, event.recurrence_frequency, interval, startWall.day);
    cursor = dateTimeInZone(cursorWall, timezone);
    count++;
  }
  return output;
}

function formatWhen(date: Date, allDay: boolean, timezone: string): string {
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: 'numeric', month: 'long' }).format(date);
  if (allDay) return day;
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(date);
  return `${day} в ${time}`;
}

function safeSecretEqual(received: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(received);
  const right = encoder.encode(expected);
  if (!left.length || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = Deno.env.get('PUSH_CRON_SECRET') ?? '';
  if (!cronSecret || !safeSecretEqual(request.headers.get('x-push-cron-secret') ?? '', cronSecret)) return json({ error: 'Unauthorized' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const vapidSubject = Deno.env.get('VAPID_SUBJECT');
  if (!supabaseUrl || !serviceRoleKey || !vapidPublic || !vapidPrivate || !vapidSubject) return json({ error: 'Push server configuration is incomplete' }, 500);

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const now = new Date();
    const dueFrom = new Date(now.getTime() - 2 * minute);
    const dueTo = new Date(now.getTime() + 10_000);
    const eventHorizon = new Date(now.getTime() + lookAheadMs);
    const eventQuery = await admin.from('events')
      .select('id,couple_id,owner_id,starts_at,ends_at,all_day,timezone,visibility,surprise_until,recurrence_frequency,recurrence_interval,recurrence_until,event_details!inner(title,reminders)')
      .lte('starts_at', eventHorizon.toISOString())
      .or(`starts_at.gte.${new Date(now.getTime() - minute).toISOString()},recurrence_frequency.not.is.null`);
    if (eventQuery.error) throw eventQuery.error;
    const dateQuery = await admin.from('important_dates')
      .select('id,couple_id,title,event_date,repeats_yearly,reminder_days');
    if (dateQuery.error) throw dateQuery.error;
    const memberQuery = await admin.from('couple_members').select('couple_id,user_id');
    if (memberQuery.error) throw memberQuery.error;
    const subscriptionsQuery = await admin.from('push_subscriptions')
      .select('id,user_id,endpoint,p256dh,auth_secret,timezone');
    if (subscriptionsQuery.error) throw subscriptionsQuery.error;

    const membersByCouple = new Map<string, string[]>();
    for (const member of memberQuery.data ?? []) membersByCouple.set(member.couple_id, [...(membersByCouple.get(member.couple_id) ?? []), member.user_id]);
    const subscriptionsByUser = new Map<string, Subscription[]>();
    for (const subscription of (subscriptionsQuery.data ?? []) as Subscription[]) subscriptionsByUser.set(subscription.user_id, [...(subscriptionsByUser.get(subscription.user_id) ?? []), subscription]);
    let delivered = 0;
    let attempted = 0;

    const deliver = async (subscription: Subscription, notificationKey: string, title: string, body: string) => {
      const { data: claimed, error: claimError } = await admin.rpc('claim_push_delivery', { p_subscription_id: subscription.id, p_notification_key: notificationKey });
      if (claimError) throw claimError;
      if (!claimed) return;
      attempted++;
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth_secret } },
          JSON.stringify({ title, body, url: './' }),
          { TTL: 3600, urgency: 'normal' },
        );
        const { error } = await admin.rpc('finish_push_delivery', { p_subscription_id: subscription.id, p_notification_key: notificationKey, p_sent: true, p_error: null });
        if (error) throw error;
        delivered++;
      } catch (cause) {
        const error = cause as { statusCode?: number; message?: string };
        if (error.statusCode === 404 || error.statusCode === 410) await admin.from('push_subscriptions').delete().eq('id', subscription.id);
        await admin.rpc('finish_push_delivery', { p_subscription_id: subscription.id, p_notification_key: notificationKey, p_sent: false, p_error: error.message ?? 'Web Push delivery failed' });
        console.error('Web Push delivery failed', { statusCode: error.statusCode, message: error.message });
      }
    };

    const occurrenceFrom = new Date(now.getTime() - minute);
    for (const event of (eventQuery.data ?? []) as unknown as EventReminderRow[]) {
      const details = Array.isArray(event.event_details) ? event.event_details[0] : event.event_details;
      if (!details?.title || !Array.isArray(details.reminders) || !details.reminders.length) continue;
      const recipients = membersByCouple.get(event.couple_id) ?? [];
      const timezone = event.timezone || 'UTC';
      for (const occurrence of eventOccurrences(event, occurrenceFrom, eventHorizon)) {
        const startsMs = occurrence.startsAt.getTime();
        for (const reminder of details.reminders) {
          const reminderMinutes = Number(reminder.minutes);
          if (!Number.isFinite(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > maxReminderMinutes) continue;
          const firesAt = startsMs - reminderMinutes * minute;
          if (firesAt < dueFrom.getTime() || firesAt > dueTo.getTime()) continue;
          for (const userId of recipients) {
            const isOwner = userId === event.owner_id;
            if (!isOwner && event.visibility === 'private') continue;
            const surprisePending = !isOwner && event.surprise_until && new Date(event.surprise_until).getTime() > now.getTime();
            const title = !isOwner && (event.visibility === 'busy' || surprisePending) ? 'Напоминание' : details.title;
            const bodyTitle = !isOwner && event.visibility === 'busy' ? 'Занятое время' : !isOwner && surprisePending ? 'Сюрприз' : details.title;
            const body = `${bodyTitle} · ${formatWhen(occurrence.startsAt, event.all_day, timezone)}`;
            const key = `event:${event.id}:${occurrence.startsAt.toISOString()}:${reminderMinutes}`;
            for (const subscription of subscriptionsByUser.get(userId) ?? []) await deliver(subscription, key, title, body);
          }
        }
      }
    }

    for (const importantDate of dateQuery.data ?? []) {
      const [yearValue, monthValue, dayValue] = importantDate.event_date.split('-').map(Number);
      for (const userId of membersByCouple.get(importantDate.couple_id) ?? []) {
        for (const subscription of subscriptionsByUser.get(userId) ?? []) {
          const timezone = subscription.timezone || 'UTC';
          const currentYear = wallTime(now, timezone).year;
          const candidateYears = importantDate.repeats_yearly
            ? [Math.max(currentYear, yearValue), Math.max(currentYear, yearValue) + 1]
            : [yearValue];
          for (const year of candidateYears) {
            const day = Math.min(dayValue, new Date(Date.UTC(year, monthValue, 0)).getUTCDate());
            const dayBeforeReminder = new Date(Date.UTC(year, monthValue - 1, day - Number(importantDate.reminder_days ?? 0)));
            const reminderWall: WallTime = { year: dayBeforeReminder.getUTCFullYear(), month: dayBeforeReminder.getUTCMonth() + 1, day: dayBeforeReminder.getUTCDate(), hour: 9, minute: 0, second: 0 };
            const firesAt = dateTimeInZone(reminderWall, timezone);
            if (firesAt.getTime() < dueFrom.getTime() || firesAt.getTime() > dueTo.getTime()) continue;
            const eventWall: WallTime = { year, month: monthValue, day, hour: 9, minute: 0, second: 0 };
            const eventAt = dateTimeInZone(eventWall, timezone);
            const key = `important-date:${importantDate.id}:${year}:${importantDate.reminder_days}`;
            await deliver(subscription, key, 'Важная дата', `${importantDate.title} · ${formatWhen(eventAt, true, timezone)}`);
          }
        }
      }
    }

    const cleanupBefore = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    await admin.from('push_notification_deliveries').delete().lt('sent_at', cleanupBefore);
    return json({ ok: true, attempted, delivered });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Unknown push worker error';
    console.error('Push reminder job failed', message);
    return json({ error: 'Push reminder job failed' }, 500);
  }
});

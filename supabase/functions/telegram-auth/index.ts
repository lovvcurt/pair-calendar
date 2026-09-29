import { createClient } from 'supabase';

type TelegramUser = { id: number; first_name: string; last_name?: string; is_bot?: boolean };
type VerifiedTelegramUser = { id: string; displayName: string };
type LinkRow = { user_id: string };

const encoder = new TextEncoder();
const maxInitDataAgeSeconds = 60 * 60;
const futureClockToleranceSeconds = 5 * 60;

class ClientError extends Error {}

function allowedOrigins(): Set<string> {
  return new Set((Deno.env.get('TELEGRAM_APP_ORIGINS') ?? '').split(',').map((value) => {
    try { return new URL(value.trim()).origin; } catch { return ''; }
  }).filter(Boolean));
}

function corsHeaders(request: Request, origins: Set<string>): HeadersInit {
  const origin = request.headers.get('origin') ?? '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function respond(request: Request, origins: Set<string>, payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(request, origins), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function verifyTelegramInitData(initData: unknown, botToken: string): Promise<VerifiedTelegramUser> {
  if (typeof initData !== 'string' || initData.length < 1 || initData.length > 12_000) throw new ClientError('Откройте Mini App заново через Telegram и повторите попытку.');
  const params = new URLSearchParams(initData);
  const entries = [...params.entries()];
  if (!entries.length || new Set(entries.map(([key]) => key)).size !== entries.length) throw new ClientError('Telegram передал некорректные данные входа.');
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new ClientError('Telegram передал некорректную подпись.');

  const dataCheckString = entries.filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  // Telegram specifies HMAC with key="WebAppData" and message=bot token,
  // then HMAC with that derived key and the data-check-string as the message.
  const secretKey = await hmac(encoder.encode('WebAppData'), botToken);
  const expectedHash = hex(await hmac(secretKey, dataCheckString));
  if (!constantTimeHexEqual(expectedHash, hash.toLowerCase())) throw new ClientError('Не удалось проверить подпись Telegram. Откройте Mini App через вашего бота.');

  const authDateValue = params.get('auth_date') ?? '';
  if (!/^\d{1,12}$/.test(authDateValue)) throw new ClientError('В данных Telegram нет времени входа.');
  const authDate = Number(authDateValue);
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + futureClockToleranceSeconds || now - authDate > maxInitDataAgeSeconds) throw new ClientError('Ссылка входа устарела. Закройте и заново откройте Mini App в Telegram.');

  let user: TelegramUser;
  try { user = JSON.parse(params.get('user') ?? '') as TelegramUser; }
  catch { throw new ClientError('В данных Telegram не найден пользователь.'); }
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) throw new ClientError('Telegram передал недопустимый аккаунт.');
  const id = String(user.id);
  if (!/^[1-9][0-9]{0,15}$/.test(id)) throw new ClientError('Номер аккаунта Telegram имеет неверный формат.');
  const displayName = [user.first_name, user.last_name].filter((part) => typeof part === 'string').join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Пользователь Telegram';
  return { id, displayName };
}

function getBearerToken(request: Request): string | null {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return hex(bytes);
}

async function telegramEmail(telegramUserId: string, authSecret: string): Promise<string> {
  const digest = hex(await hmac(encoder.encode(authSecret), `telegram-account:${telegramUserId}`));
  return `tg-${digest.slice(0, 56)}@telegram.invalid`;
}

Deno.serve(async (request) => {
  const origins = allowedOrigins();
  const origin = request.headers.get('origin') ?? '';
  if (!origins.size) return respond(request, origins, { error: 'В Supabase не настроен список TELEGRAM_APP_ORIGINS.' }, 503);
  if (!origin || !origins.has(origin)) return respond(request, origins, { error: 'Этот адрес не разрешён для Telegram-входа.' }, 403);
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request, origins) });
  if (request.method !== 'POST') return respond(request, origins, { error: 'Допустим только POST-запрос.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  const authSecret = Deno.env.get('TELEGRAM_AUTH_SECRET') ?? '';
  if (!supabaseUrl || !serviceRoleKey || !botToken || !authSecret) {
    return respond(request, origins, { error: 'Серверная функция Telegram не настроена. Проверьте её Secrets в Supabase.' }, 503);
  }

  let body: { action?: unknown; initData?: unknown };
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return respond(request, origins, { error: 'Некорректное тело запроса.' }, 400);
    body = parsed as { action?: unknown; initData?: unknown };
  }
  catch { return respond(request, origins, { error: 'Не удалось прочитать запрос.' }, 400); }
  if (typeof body.action !== 'string' || !['login', 'status', 'link'].includes(body.action)) {
    return respond(request, origins, { error: 'Неизвестное действие.' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  async function findLink(column: 'telegram_user_id' | 'user_id', value: string) {
    const { data, error } = await admin.from('telegram_accounts').select('user_id').eq(column, value).maybeSingle();
    if (error) throw error;
    return data as LinkRow | null;
  }

  async function issueSession(userId: string) {
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId);
    if (userError || !userData.user?.email) throw new ClientError('Не удалось найти аккаунт Supabase для Telegram.');
    const email = userData.user.email;
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (linkError || !linkData.properties?.hashed_token) throw new ClientError('Supabase не смог подготовить безопасный вход.');

    // Admin.generateLink only creates an OTP; it does not send an email. Verify
    // it with the public client so Supabase returns a normal user session.
    const publicKey = Deno.env.get('SUPABASE_ANON_KEY') ?? request.headers.get('apikey');
    if (!publicKey) throw new ClientError('В Supabase Edge Function не найден публичный API key.');
    const publicClient = createClient(supabaseUrl, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: sessionData, error: sessionError } = await publicClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token, type: 'magiclink',
    });
    if (sessionError || !sessionData.session) throw new ClientError('Supabase не смог создать сессию. Повторите вход.');
    return { access_token: sessionData.session.access_token, refresh_token: sessionData.session.refresh_token };
  }

  try {
    if (body.action === 'status') {
      const token = getBearerToken(request);
      if (!token) return respond(request, origins, { error: 'Сначала войдите в аккаунт календаря.' }, 401);
      const { data: authData, error: authError } = await admin.auth.getUser(token);
      if (authError || !authData.user) return respond(request, origins, { error: 'Сессия Supabase устарела. Войдите снова.' }, 401);
      const link = await findLink('user_id', authData.user.id);
      return respond(request, origins, { linked: Boolean(link) });
    }

    if (body.action === 'link') {
      const token = getBearerToken(request);
      if (!token) return respond(request, origins, { error: 'Сначала войдите в тот аккаунт, который хотите связать.' }, 401);
      const { data: authData, error: authError } = await admin.auth.getUser(token);
      if (authError || !authData.user) return respond(request, origins, { error: 'Сессия Supabase устарела. Войдите снова.' }, 401);
      const telegramUser = await verifyTelegramInitData(body.initData, botToken);
      const accountForTelegram = await findLink('telegram_user_id', telegramUser.id);
      if (accountForTelegram) {
        if (accountForTelegram.user_id === authData.user.id) return respond(request, origins, { linked: true, alreadyLinked: true });
        return respond(request, origins, { error: 'Этот Telegram уже связан с другим аккаунтом календаря. Войдите именно в него; аккаунты автоматически не объединяются.' }, 409);
      }
      const accountForSupabase = await findLink('user_id', authData.user.id);
      if (accountForSupabase) return respond(request, origins, { error: 'К этому аккаунту календаря уже привязан другой Telegram.' }, 409);
      const { error: insertError } = await admin.from('telegram_accounts').insert({ telegram_user_id: telegramUser.id, user_id: authData.user.id });
      if (insertError) {
        if (insertError.code === '23505') return respond(request, origins, { error: 'Привязка уже изменилась. Обновите страницу и проверьте её статус.' }, 409);
        throw insertError;
      }
      return respond(request, origins, { linked: true });
    }

    const telegramUser = await verifyTelegramInitData(body.initData, botToken);
    let mapping = await findLink('telegram_user_id', telegramUser.id);
    if (!mapping) {
      const email = await telegramEmail(telegramUser.id, authSecret);
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password: randomPassword(),
        email_confirm: true,
        user_metadata: { display_name: telegramUser.displayName },
        app_metadata: { telegram_login: true },
      });
      if (createError || !created.user) {
        // Another click/device may have won the unique synthetic email race.
        for (let attempt = 0; attempt < 5 && !mapping; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          mapping = await findLink('telegram_user_id', telegramUser.id);
        }
        if (!mapping) return respond(request, origins, { error: 'Не удалось создать аккаунт Telegram. Попробуйте открыть Mini App ещё раз.' }, 409);
      } else {
        const { error: insertError } = await admin.from('telegram_accounts').insert({ telegram_user_id: telegramUser.id, user_id: created.user.id });
        if (insertError) {
          await admin.auth.admin.deleteUser(created.user.id);
          for (let attempt = 0; attempt < 5 && !mapping; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            mapping = await findLink('telegram_user_id', telegramUser.id);
          }
          if (!mapping) return respond(request, origins, { error: 'Не удалось сохранить привязку Telegram. Повторите попытку.' }, 409);
        } else mapping = { user_id: created.user.id };
      }
    }
    return respond(request, origins, await issueSession(mapping.user_id));
  } catch (error) {
    if (error instanceof ClientError) return respond(request, origins, { error: error.message }, 400);
    return respond(request, origins, { error: 'Не удалось выполнить вход через Telegram. Проверьте настройки и повторите попытку.' }, 500);
  }
});

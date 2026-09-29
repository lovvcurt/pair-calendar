import { createClient } from 'supabase';

type TelegramUser = { id: number; first_name: string; last_name?: string; is_bot?: boolean };
type VerifiedTelegramUser = { id: string; displayName: string };
type LinkRow = { user_id: string };
type TelegramClaims = {
  iss?: unknown; aud?: unknown; sub?: unknown; id?: unknown; exp?: unknown; iat?: unknown;
  azp?: unknown; nonce?: unknown; name?: unknown; given_name?: unknown; family_name?: unknown;
};
type TelegramJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

const encoder = new TextEncoder();
const maxInitDataAgeSeconds = 60 * 60;
const futureClockToleranceSeconds = 5 * 60;
const webChallengeLifetimeSeconds = 5 * 60;
let jwksCache: { keys: TelegramJwk[]; expiresAt: number } | null = null;

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

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ClientError('Telegram передал некорректный токен.');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function cleanDisplayName(value: unknown): string {
  return (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Пользователь Telegram';
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
  if (!constantTimeEqual(expectedHash, hash.toLowerCase())) throw new ClientError('Не удалось проверить подпись Telegram. Откройте Mini App через вашего бота.');

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
  const displayName = cleanDisplayName([user.first_name, user.last_name].filter((part) => typeof part === 'string').join(' '));
  return { id, displayName };
}

function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

async function createWebChallenge(authSecret: string) {
  const nonce = base64Url(randomBytes(32));
  const expiresAt = Math.floor(Date.now() / 1000) + webChallengeLifetimeSeconds;
  const payload = `${nonce}.${expiresAt}.${base64Url(randomBytes(16))}`;
  const signature = base64Url(await hmac(encoder.encode(authSecret), payload));
  return { nonce, challengeToken: `${base64Url(encoder.encode(payload))}.${signature}` };
}

async function verifyWebChallenge(challengeToken: unknown, nonce: unknown, authSecret: string): Promise<string> {
  if (typeof challengeToken !== 'string' || challengeToken.length > 512 || typeof nonce !== 'string' || nonce.length > 128) {
    throw new ClientError('Не удалось проверить запрос входа. Нажмите кнопку входа ещё раз.');
  }
  const [encodedPayload, signature, extra] = challengeToken.split('.');
  if (!encodedPayload || !signature || extra !== undefined) throw new ClientError('Запрос входа устарел. Нажмите кнопку ещё раз.');
  let payload: string;
  try { payload = new TextDecoder().decode(fromBase64Url(encodedPayload)); }
  catch { throw new ClientError('Запрос входа повреждён. Нажмите кнопку ещё раз.'); }
  const expectedSignature = base64Url(await hmac(encoder.encode(authSecret), payload));
  if (!constantTimeEqual(expectedSignature, signature)) throw new ClientError('Не удалось проверить запрос входа. Нажмите кнопку ещё раз.');
  const [issuedNonce, expiryText, randomPart, trailing] = payload.split('.');
  const expiresAt = Number(expiryText);
  const now = Math.floor(Date.now() / 1000);
  if (trailing !== undefined || !issuedNonce || !randomPart || issuedNonce !== nonce || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + webChallengeLifetimeSeconds + 10) {
    throw new ClientError('Время входа истекло. Нажмите кнопку ещё раз.');
  }
  return issuedNonce;
}

async function telegramJwks(): Promise<TelegramJwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch('https://oauth.telegram.org/.well-known/jwks.json', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Telegram signing keys could not be loaded');
  const payload = await response.json() as { keys?: TelegramJwk[] };
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) throw new Error('Telegram signing keys are unavailable');
  jwksCache = { keys: payload.keys, expiresAt: now + 10 * 60 * 1000 };
  return payload.keys;
}

async function verifyTelegramLoginToken(idToken: unknown, expectedNonce: string, clientId: string): Promise<VerifiedTelegramUser> {
  if (typeof idToken !== 'string' || idToken.length < 1 || idToken.length > 12_000) throw new ClientError('Telegram не вернул корректное подтверждение входа. Попробуйте ещё раз.');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new ClientError('Telegram передал некорректное подтверждение входа.');
  let header: { alg?: unknown; kid?: unknown };
  let claims: TelegramClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as { alg?: unknown; kid?: unknown };
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as TelegramClaims;
  } catch { throw new ClientError('Telegram передал некорректное подтверждение входа.'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new ClientError('Не удалось проверить подпись Telegram.');
  const key = (await telegramJwks()).find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA' && (!candidate.use || candidate.use === 'sig') && (!candidate.alg || candidate.alg === 'RS256'));
  if (!key) throw new ClientError('Не найдена ключевая подпись Telegram. Повторите вход через минуту.');
  const importedKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signedText = encoder.encode(`${parts[0]}.${parts[1]}`);
  let validSignature = false;
  try { validSignature = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', importedKey, fromBase64Url(parts[2]), signedText); }
  catch { validSignature = false; }
  if (!validSignature) throw new ClientError('Не удалось проверить подпись Telegram.');

  const audience = claims.aud;
  const audienceMatches = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  const authorizedPartyMatches = !Array.isArray(audience) || audience.length <= 1 || claims.azp === clientId;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== 'https://oauth.telegram.org' || !audienceMatches || !authorizedPartyMatches || typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.exp <= claims.iat || claims.exp - claims.iat > 60 * 60 || claims.iat > now + futureClockToleranceSeconds || now - claims.iat > webChallengeLifetimeSeconds + futureClockToleranceSeconds || claims.nonce !== expectedNonce) {
    throw new ClientError('Вход Telegram истёк или не совпал с настройками бота. Нажмите кнопку ещё раз.');
  }
  const id = typeof claims.sub === 'string' ? claims.sub : '';
  if (!/^[1-9][0-9]{0,19}$/.test(id) || (claims.id !== undefined && String(claims.id) !== id)) throw new ClientError('Telegram передал недопустимый аккаунт.');
  const displayName = cleanDisplayName(claims.name ?? [claims.given_name, claims.family_name].filter((part) => typeof part === 'string').join(' '));
  return { id, displayName };
}

function getBearerToken(request: Request): string | null {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

function randomPassword(): string {
  return hex(randomBytes(32));
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
  if (!supabaseUrl || !serviceRoleKey || !authSecret) {
    return respond(request, origins, { error: 'Серверная функция Telegram не настроена. Проверьте её Secrets в Supabase.' }, 503);
  }

  let body: { action?: unknown; initData?: unknown; idToken?: unknown; nonce?: unknown; challengeToken?: unknown };
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return respond(request, origins, { error: 'Некорректное тело запроса.' }, 400);
    body = parsed as typeof body;
  }
  catch { return respond(request, origins, { error: 'Не удалось прочитать запрос.' }, 400); }
  const actions = ['login', 'status', 'link', 'web_challenge', 'web_login', 'web_link'];
  if (typeof body.action !== 'string' || !actions.includes(body.action)) return respond(request, origins, { error: 'Неизвестное действие.' }, 400);
  if (['login', 'link'].includes(body.action) && !botToken) return respond(request, origins, { error: 'В Supabase не настроен TELEGRAM_BOT_TOKEN для Mini App.' }, 503);
  const telegramLoginClientId = Deno.env.get('TELEGRAM_LOGIN_CLIENT_ID') ?? '';
  if (['web_challenge', 'web_login', 'web_link'].includes(body.action) && !telegramLoginClientId) {
    return respond(request, origins, { error: 'В Supabase не настроен TELEGRAM_LOGIN_CLIENT_ID.' }, 503);
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
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: userData.user.email });
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

  async function getOrCreateAccount(telegramUser: VerifiedTelegramUser): Promise<LinkRow> {
    let mapping = await findLink('telegram_user_id', telegramUser.id);
    if (mapping) return mapping;
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
      if (!mapping) throw new ClientError('Не удалось создать аккаунт Telegram. Попробуйте ещё раз.');
      return mapping;
    }
    const { error: insertError } = await admin.from('telegram_accounts').insert({ telegram_user_id: telegramUser.id, user_id: created.user.id });
    if (insertError) {
      await admin.auth.admin.deleteUser(created.user.id);
      for (let attempt = 0; attempt < 5 && !mapping; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        mapping = await findLink('telegram_user_id', telegramUser.id);
      }
      if (!mapping) throw new ClientError('Не удалось сохранить привязку Telegram. Повторите попытку.');
      return mapping;
    }
    return { user_id: created.user.id };
  }

  async function linkAccount(userId: string, telegramUser: VerifiedTelegramUser) {
    const accountForTelegram = await findLink('telegram_user_id', telegramUser.id);
    if (accountForTelegram) {
      if (accountForTelegram.user_id === userId) return { linked: true, alreadyLinked: true };
      throw new ClientError('Этот Telegram уже связан с другим аккаунтом календаря. Войдите именно в него; аккаунты автоматически не объединяются.');
    }
    const accountForSupabase = await findLink('user_id', userId);
    if (accountForSupabase) throw new ClientError('К этому аккаунту календаря уже привязан другой Telegram.');
    const { error: insertError } = await admin.from('telegram_accounts').insert({ telegram_user_id: telegramUser.id, user_id: userId });
    if (insertError) {
      if (insertError.code === '23505') throw new ClientError('Привязка уже изменилась. Обновите страницу и проверьте её статус.');
      throw insertError;
    }
    return { linked: true };
  }

  async function currentUserId(): Promise<string> {
    const token = getBearerToken(request);
    if (!token) throw new ClientError('Сначала войдите в аккаунт календаря, который хотите связать.');
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) throw new ClientError('Сессия Supabase устарела. Войдите снова.');
    return data.user.id;
  }

  try {
    if (body.action === 'status') {
      const userId = await currentUserId();
      return respond(request, origins, { linked: Boolean(await findLink('user_id', userId)) });
    }

    if (body.action === 'web_challenge') return respond(request, origins, await createWebChallenge(authSecret));

    if (body.action === 'link' || body.action === 'web_link') {
      const userId = await currentUserId();
      let telegramUser: VerifiedTelegramUser;
      if (body.action === 'link') telegramUser = await verifyTelegramInitData(body.initData, botToken);
      else {
        const expectedNonce = await verifyWebChallenge(body.challengeToken, body.nonce, authSecret);
        telegramUser = await verifyTelegramLoginToken(body.idToken, expectedNonce, telegramLoginClientId);
      }
      return respond(request, origins, await linkAccount(userId, telegramUser));
    }

    let telegramUser: VerifiedTelegramUser;
    if (body.action === 'login') telegramUser = await verifyTelegramInitData(body.initData, botToken);
    else {
      const expectedNonce = await verifyWebChallenge(body.challengeToken, body.nonce, authSecret);
      telegramUser = await verifyTelegramLoginToken(body.idToken, expectedNonce, telegramLoginClientId);
    }
    const mapping = await getOrCreateAccount(telegramUser);
    return respond(request, origins, await issueSession(mapping.user_id));
  } catch (error) {
    if (error instanceof ClientError) return respond(request, origins, { error: error.message }, 400);
    return respond(request, origins, { error: 'Не удалось выполнить вход через Telegram. Проверьте настройки и повторите попытку.' }, 500);
  }
});

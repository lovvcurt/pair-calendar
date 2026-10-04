import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type * as React from 'react';
import {
  AlarmClock, ArrowDownToLine, ArrowRight, Bell, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Cloud, CloudOff, Compass, Download,
  Heart, Lightbulb, Link2, LoaderCircle, LogOut, MapPin, Menu, Moon, Palette, Pencil, Plus,
  Send, Settings2, Shield, Sparkles, Sun, Tag, Trash2, Upload, Users, Vote, X,
} from 'lucide-react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured, errorMessage } from './lib/supabase';
import {
  addDays, blankDetails, dateInput, formatDate, formatTime, fromLocalInput, initials, localMidnight,
  monthStart, occurrences, sameDay, todayInput, toLocalInput, weekStart, timezoneName,
} from './lib/calendar';
import type { CalendarEvent, EventDetails, Visibility } from './lib/calendar';
import { exportCalendar, parseCalendar, type ImportedEvent } from './lib/ics';
import { getTelegramInitData, loadTelegramLoginSdk, openTelegramLogin } from './lib/telegram';

type Tab = 'calendar' | 'polls' | 'ideas' | 'settings';
type ThemeMode = 'dark' | 'light' | 'system';
type PaletteId = 'mint' | 'ocean' | 'rose' | 'lavender' | 'amber' | 'berry';
type AppearancePreferences = { theme_mode: ThemeMode; palette: PaletteId; my_event_color: string | null; partner_event_color: string | null };
type Profile = { id: string; display_name: string; avatar_path: string | null };
type CoupleInfo = { id: string; name: string };
type Poll = { id: string; couple_id: string; created_by: string; question: string; description: string; tags: string[]; created_at: string };
type PollOption = { id: string; poll_id: string; label: string; starts_at: string | null; ends_at: string | null; sort_order: number };
type VoteRow = { id: string; poll_id: string; option_id: string; user_id: string };
type DateIdea = { id: string; couple_id: string; created_by: string; title: string; description: string; tags: string[]; status: 'idea' | 'chosen' | 'done'; created_at: string };
type ImportantDate = { id: string; couple_id: string; created_by: string; title: string; event_date: string; repeats_yearly: boolean; reminder_days: number };
type TagRow = { id: string; couple_id: string; label: string; color: string; created_by: string };
type EventDraft = { base: CalendarEvent | null; starts: string; ends: string; allDay: boolean; visibility: Visibility; surprise: string; recurrence: CalendarEvent['recurrence_frequency']; interval: number; recurrenceUntil: string; details: EventDetails };

const tabs: { id: Tab; label: string; icon: typeof CalendarDays }[] = [
  { id: 'calendar', label: 'Календарь', icon: CalendarDays },
  { id: 'polls', label: 'Опросы', icon: Vote },
  { id: 'ideas', label: 'Идеи', icon: Lightbulb },
  { id: 'settings', label: 'Ещё', icon: Menu },
];
const palettes: { id: PaletteId; label: string; swatches: [string, string, string]; events: { dark: [string, string]; light: [string, string] } }[] = [
  { id: 'mint', label: 'Мята', swatches: ['#a6e3b0', '#f3a6b7', '#c7a6ff'], events: { dark: ['#a6e3b0', '#f3a6b7'], light: ['#45995c', '#d96982'] } },
  { id: 'ocean', label: 'Океан', swatches: ['#82c8f0', '#ffc58a', '#a6ddcb'], events: { dark: ['#82c8f0', '#ffc58a'], light: ['#277dad', '#a75c14'] } },
  { id: 'rose', label: 'Роза', swatches: ['#f3a6b7', '#94d8c5', '#c7a6ff'], events: { dark: ['#f3a6b7', '#94d8c5'], light: ['#b84d68', '#297a68'] } },
  { id: 'lavender', label: 'Лаванда', swatches: ['#c7a6ff', '#f2bd7a', '#94d8c5'], events: { dark: ['#c7a6ff', '#f2bd7a'], light: ['#7250ac', '#9a5c16'] } },
  { id: 'amber', label: 'Янтарь', swatches: ['#e9bd7a', '#9dbbff', '#a6e3b0'], events: { dark: ['#e9bd7a', '#9dbbff'], light: ['#946414', '#3e66a2'] } },
  { id: 'berry', label: 'Ягоды', swatches: ['#ed91c0', '#86c9ef', '#e9bd7a'], events: { dark: ['#ed91c0', '#86c9ef'], light: ['#a94177', '#276b91'] } },
];
const colorOptions = ['#a6e3b0', '#f3a6b7', '#a6c8ff', '#e8bd7a', '#c7a6ff', '#f0d876'];
const reminderOptions = [5, 15, 30, 60, 180, 1440, 10080];
const maxBrowserTimeout = 2_147_000_000;
const reminderLabel = (minutes: number) => minutes < 60 ? `${minutes} мин.` : minutes < 1440 ? `${minutes / 60} ч.` : `${minutes / 1440} дн.`;
const telegramRedirectUri = () => new URL(import.meta.env.BASE_URL || './', window.location.href).href;

async function callTelegramFunction<T>(body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('Сначала подключите Supabase.');
  const { data, error } = await supabase.functions.invoke('telegram-auth', { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const payload = await context.clone().json().catch(() => null) as { error?: unknown } | null;
      if (typeof payload?.error === 'string') throw new Error(payload.error);
    }
    throw new Error(errorMessage(error));
  }
  return data as T;
}

function accountName(user: User, profile?: Profile) {
  return profile?.display_name?.trim() || (user.app_metadata?.telegram_login ? 'Пользователь Telegram' : user.email?.split('@')[0]) || 'Вы';
}

function defaultCalendarColors(theme: ThemeMode, palette: PaletteId): [string, string] {
  const resolvedTheme = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  return palettes.find((item) => item.id === palette)?.events[resolvedTheme] ?? palettes[0].events[resolvedTheme];
}

function useTheme(userId?: string) {
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => {
    const saved = localStorage.getItem('vmeste-theme');
    return { theme_mode: saved === 'light' || saved === 'system' ? saved : 'dark', palette: 'mint', my_event_color: null, partner_event_color: null };
  });
  const cacheAppearance = (value: string | null): AppearancePreferences | null => {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as Partial<AppearancePreferences>;
      if ((parsed.theme_mode === 'dark' || parsed.theme_mode === 'light' || parsed.theme_mode === 'system') && palettes.some((item) => item.id === parsed.palette)) {
        const validColor = (color: unknown): color is string => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
        return { theme_mode: parsed.theme_mode, palette: parsed.palette as PaletteId, my_event_color: validColor(parsed.my_event_color) ? parsed.my_event_color : null, partner_event_color: validColor(parsed.partner_event_color) ? parsed.partner_event_color : null };
      }
    } catch { /* Ignore invalid local cache and use the normal defaults. */ }
    return null;
  };
  useEffect(() => {
    if (!userId) { setAppearance({ theme_mode: 'dark', palette: 'mint', my_event_color: null, partner_event_color: null }); return; }
    const cached = cacheAppearance(localStorage.getItem(`vmeste-appearance:${userId}`));
    if (cached) { setAppearance(cached); return; }
    const savedTheme = localStorage.getItem(`vmeste-theme:${userId}`) ?? localStorage.getItem('vmeste-theme');
    const savedPalette = localStorage.getItem(`vmeste-palette:${userId}`);
    setAppearance({
      theme_mode: savedTheme === 'light' || savedTheme === 'system' ? savedTheme : 'dark',
      palette: palettes.some((item) => item.id === savedPalette) ? savedPalette as PaletteId : 'mint',
      my_event_color: null, partner_event_color: null,
    });
  }, [userId]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolvedTheme = appearance.theme_mode === 'system' ? (media.matches ? 'light' : 'dark') : appearance.theme_mode;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.palette = appearance.palette;
      if (appearance.my_event_color) document.documentElement.style.setProperty('--calendar-own-color', appearance.my_event_color);
      else document.documentElement.style.removeProperty('--calendar-own-color');
      if (appearance.partner_event_color) document.documentElement.style.setProperty('--calendar-partner-color', appearance.partner_event_color);
      else document.documentElement.style.removeProperty('--calendar-partner-color');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme === 'light' ? '#f6f7f5' : '#111111');
    };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [appearance]);
  const change = useCallback((next: AppearancePreferences) => {
    setAppearance(next);
    if (userId) {
      localStorage.setItem(`vmeste-appearance:${userId}`, JSON.stringify(next));
    }
  }, [userId]);
  return { theme: appearance.theme_mode, palette: appearance.palette, myEventColor: appearance.my_event_color, partnerEventColor: appearance.partner_event_color, change };
}

function Avatar({ name, url, size = 'normal' }: { name: string; url?: string | null; size?: 'small' | 'normal' | 'large' }) {
  return <span className={`avatar avatar-${size}`}>{url ? <img src={url} alt="" /> : initials(name)}</span>;
}

function Notice({ notice, dismiss }: { notice: { text: string; kind: 'success' | 'error' | 'info' } | null; dismiss: () => void }) {
  if (!notice) return null;
  return <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.text}</span><button className="icon-button" aria-label="Закрыть" onClick={dismiss}><X size={16} /></button></div>;
}

function Dialog({ title, children, close, wide = false, mobileFullHeight = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean; mobileFullHeight?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey); document.body.classList.add('dialog-open');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('dialog-open'); };
  }, [close]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className={`dialog ${wide ? 'dialog-wide' : ''} ${mobileFullHeight ? 'dialog-mobile-full-height' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-header"><h2>{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={close}><X size={20} /></button></header>
      <div className="dialog-body">{children}</div>
    </section>
  </div>;
}

function AuthScreen({ invitePending }: { invitePending: boolean }) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [telegramBusy, setTelegramBusy] = useState(false); const [telegramError, setTelegramError] = useState('');
  const [webTelegramReady, setWebTelegramReady] = useState(false);
  const [webTelegramChallenge, setWebTelegramChallenge] = useState<{ nonce: string; challengeToken: string } | null>(null);
  const webTelegramClientId = import.meta.env.VITE_TELEGRAM_LOGIN_CLIENT_ID?.trim() ?? '';
  const inTelegramMiniApp = Boolean(getTelegramInitData());
  useEffect(() => {
    if (!webTelegramClientId || inTelegramMiniApp) return;
    let active = true;
    void Promise.all([
      loadTelegramLoginSdk(),
      callTelegramFunction<{ nonce: string; challengeToken: string }>({ action: 'web_challenge' }),
    ]).then(([, challenge]) => {
      if (!active) return;
      setWebTelegramChallenge(challenge);
      setWebTelegramReady(true);
    }).catch((cause) => {
      if (active) setTelegramError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [webTelegramClientId, inTelegramMiniApp]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!supabase) return;
    setBusy(true); setError(''); setMessage('');
    const data = new FormData(event.currentTarget); const email = String(data.get('email') ?? '').trim(); const password = String(data.get('password') ?? '');
    try {
      if (mode === 'signup') {
        const displayName = String(data.get('displayName') ?? '').trim();
        const { data: result, error: authError } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: window.location.href } });
        if (authError) throw authError;
        setMessage(result.session ? 'Аккаунт создан. Сейчас откроется календарь.' : 'Аккаунт создан. Проверьте почту и перейдите по ссылке подтверждения.');
      } else if (mode === 'reset') {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
        if (authError) throw authError;
        setMessage('Письмо для восстановления отправлено, если адрес зарегистрирован.');
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
      }
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  async function signInWithTelegram() {
    const initData = getTelegramInitData();
    if (!supabase || !initData) return;
    setTelegramBusy(true); setTelegramError('');
    try {
      const result = await callTelegramFunction<{ access_token: string; refresh_token: string }>({ action: 'login', initData });
      const { error: sessionError } = await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
      if (sessionError) throw sessionError;
    } catch (cause) { setTelegramError(errorMessage(cause)); }
    finally { setTelegramBusy(false); }
  }
  async function signInWithWebsiteTelegram() {
    if (!supabase || !webTelegramClientId || !webTelegramChallenge || !webTelegramReady) return;
    const challenge = webTelegramChallenge;
    setWebTelegramChallenge(null);
    setTelegramBusy(true); setTelegramError('');
    try {
      // Open the popup immediately from the click handler. Preparing it after an
      // await can make mobile browsers block the Telegram window.
      const idToken = await openTelegramLogin(webTelegramClientId, challenge.nonce, telegramRedirectUri());
      const result = await callTelegramFunction<{ access_token: string; refresh_token: string }>({
        action: 'web_login', idToken, nonce: challenge.nonce, challengeToken: challenge.challengeToken,
      });
      const { error: sessionError } = await supabase.auth.setSession({ access_token: result.access_token, refresh_token: result.refresh_token });
      if (sessionError) throw sessionError;
    } catch (cause) { setTelegramError(errorMessage(cause)); }
    finally {
      setTelegramBusy(false);
      void callTelegramFunction<{ nonce: string; challengeToken: string }>({ action: 'web_challenge' })
        .then(setWebTelegramChallenge).catch(() => setWebTelegramChallenge(null));
    }
  }
  const title = mode === 'signup' ? 'Создайте аккаунт' : mode === 'reset' ? 'Восстановление доступа' : 'Рады видеть вас';
  return <main className="auth-screen"><div className="auth-card panel">
    <Brand /><div className="auth-intro"><h1>{title}</h1><p>{invitePending ? 'Войдите или зарегистрируйтесь, чтобы принять приглашение партнёра.' : 'Ваше общее место для планов, встреч и маленьких поводов быть рядом.'}</p></div>
    <form className="stack-form" onSubmit={submit}>
      {mode === 'signup' && <Field label="Как к вам обращаться"><input name="displayName" autoComplete="name" maxLength={80} placeholder="Имя" required /></Field>}
      <Field label="Электронная почта"><input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></Field>
      {mode !== 'reset' && <Field label="Пароль"><input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} placeholder="Не менее 8 символов" required /></Field>}
      {error && <p className="form-error">{error}</p>}{message && <p className="form-success">{message}</p>}
      <button className="button button-primary button-block" disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />}{mode === 'signup' ? 'Создать аккаунт' : mode === 'reset' ? 'Отправить письмо' : 'Войти'}</button>
    </form>
    {mode !== 'reset' && <div className="auth-telegram"><span className="auth-divider">или</span>
      {telegramError && <p className="form-error">{telegramError}</p>}
      {inTelegramMiniApp
        ? <button className="button button-secondary button-block" disabled={telegramBusy} onClick={() => void signInWithTelegram()}>{telegramBusy ? <LoaderCircle className="spin" size={17} /> : <Send size={16} />} Продолжить через Telegram</button>
        : <button className="button button-secondary button-block" disabled={telegramBusy || !webTelegramClientId || !webTelegramReady || !webTelegramChallenge} onClick={() => void signInWithWebsiteTelegram()}>{telegramBusy ? <LoaderCircle className="spin" size={17} /> : <Send size={16} />} {webTelegramClientId ? webTelegramReady ? 'Продолжить через Telegram' : 'Подготавливаем вход через Telegram…' : 'Вход через Telegram не настроен'}</button>}
      <p>Если Telegram уже связан с календарём, откроется этот же аккаунт. Иначе будет создан новый аккаунт. Чтобы сохранить календарь, сначала войдите в него и привяжите Telegram в настройках.</p>
      <p>Инструкция: <a href={`${import.meta.env.BASE_URL}guide.html#telegram-web-login`}>вход через Telegram на сайте</a> · <a href={`${import.meta.env.BASE_URL}guide.html#telegram-auth`}>Mini App</a></p>
    </div>}
    <div className="auth-links">
      {mode === 'login' && <button className="text-button" onClick={() => setMode('reset')}>Забыли пароль?</button>}
      <button className="text-button" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); setMessage(''); }}>{mode === 'signup' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</button>
      {mode === 'reset' && <button className="text-button" onClick={() => setMode('login')}>Вернуться ко входу</button>}
    </div>
    <p className="fine-print"><Shield size={14} /> Ваши данные защищены правилами доступа Supabase.</p>
  </div></main>;
}

function TelegramLinkCard({ user, onNotice }: { user: User; onNotice: (text: string, kind?: 'success' | 'error' | 'info') => void }) {
  const [state, setState] = useState<'checking' | 'linked' | 'unlinked' | 'unavailable'>('checking');
  const [busy, setBusy] = useState(false);
  const [webReady, setWebReady] = useState(false);
  const [webChallenge, setWebChallenge] = useState<{ nonce: string; challengeToken: string } | null>(null);
  const initData = getTelegramInitData();
  const webClientId = import.meta.env.VITE_TELEGRAM_LOGIN_CLIENT_ID?.trim() ?? '';
  useEffect(() => {
    let active = true;
    void callTelegramFunction<{ linked: boolean }>({ action: 'status' })
      .then(({ linked }) => { if (active) setState(linked ? 'linked' : 'unlinked'); })
      .catch(() => { if (active) setState('unavailable'); });
    return () => { active = false; };
  }, [user.id]);
  useEffect(() => {
    if (initData || !webClientId) return;
    let active = true;
    void Promise.all([
      loadTelegramLoginSdk(),
      callTelegramFunction<{ nonce: string; challengeToken: string }>({ action: 'web_challenge' }),
    ]).then(([, challenge]) => {
      if (!active) return;
      setWebChallenge(challenge);
      setWebReady(true);
    }).catch(() => { if (active) setWebReady(false); });
    return () => { active = false; };
  }, [initData, webClientId]);
  async function linkTelegram() {
    if (!initData) return;
    setBusy(true);
    try {
      await callTelegramFunction<{ linked: boolean }>({ action: 'link', initData });
      setState('linked');
      onNotice('Telegram привязан к этому аккаунту. Теперь через него можно входить на сайт и в Mini App.');
    } catch (cause) { onNotice(errorMessage(cause), 'error'); }
    finally { setBusy(false); }
  }
  async function linkWebsiteTelegram() {
    if (!webChallenge || !webClientId || !webReady) return;
    const challenge = webChallenge;
    setWebChallenge(null);
    setBusy(true);
    try {
      const idToken = await openTelegramLogin(webClientId, challenge.nonce, telegramRedirectUri());
      await callTelegramFunction<{ linked: boolean }>({ action: 'web_link', idToken, nonce: challenge.nonce, challengeToken: challenge.challengeToken });
      setState('linked');
      onNotice('Telegram привязан к этому аккаунту. Теперь через него можно входить на сайт и в Mini App.');
    } catch (cause) { onNotice(errorMessage(cause), 'error'); }
    finally {
      setBusy(false);
      void callTelegramFunction<{ nonce: string; challengeToken: string }>({ action: 'web_challenge' })
        .then(setWebChallenge).catch(() => setWebChallenge(null));
    }
  }
  return <section className="settings-card panel telegram-settings"><div className="settings-card-heading"><span className="small-icon mint"><Send size={16} /></span><div><h3>Вход через Telegram</h3><p>Свяжите Telegram с аккаунтом календаря, чтобы входить на сайт и в Mini App.</p></div></div>
    {state === 'checking' ? <p className="settings-hint">Проверяем привязку…</p> : state === 'unavailable' ? <><p className="settings-hint">Серверная функция входа через Telegram ещё не настроена или недоступна.</p><a className="text-button" href={`${import.meta.env.BASE_URL}guide.html#telegram-web-login`}>Открыть инструкцию по настройке Telegram</a></> : state === 'linked' ? <p className="settings-hint"><CheckCircle2 size={15} /> Telegram уже связан с этим аккаунтом.</p> : state === 'unlinked' && initData ? <><button className="button button-secondary" disabled={busy} onClick={() => void linkTelegram()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />} Привязать Telegram</button><p className="settings-hint">Откройте этот экран из Telegram Mini App. Мы привяжем текущий аккаунт, в который вы вошли.</p></> : null}
    {state === 'unlinked' && !initData && webClientId && <><button className="button button-secondary" disabled={busy || !webReady || !webChallenge} onClick={() => void linkWebsiteTelegram()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />} {webReady ? 'Привязать Telegram' : 'Подготавливаем вход…'}</button><p className="settings-hint">Подтвердите вход в окне Telegram. Привязка добавит этот способ входа к открытому аккаунту.</p></>}
    {state === 'unlinked' && !initData && !webClientId && <><p className="settings-hint">Чтобы связать аккаунты прямо на сайте, сначала включите Telegram Login.</p><a className="text-button" href={`${import.meta.env.BASE_URL}guide.html#telegram-web-login`}>Открыть инструкцию по настройке</a></>}
    <p className="settings-hint">Привязка не объединяет разные календари. Она добавляет Telegram как способ входа именно в этот аккаунт.</p>
  </section>;
}

function Brand() { return <div className="brand-mark"><span className="brand-icon"><Heart size={19} fill="currentColor" /></span><span>вместе</span><span className="brand-dot">.</span></div>; }
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }

function ConfigurationScreen() {
  return <main className="auth-screen"><div className="auth-card panel">
    <Brand /><div className="config-icon"><CloudOff size={24} /></div><h1>Подключите Supabase</h1>
    <p>Для входа и общей синхронизации нужны URL проекта и публичный ключ Supabase. Они задаются при сборке сайта.</p>
    <div className="setup-steps"><div><b>1</b><span>Создайте проект Supabase и примените SQL-миграцию.</span></div><div><b>2</b><span>Скопируйте URL и публичный ключ в локальный файл <code>.env</code>.</span></div><div><b>3</b><span>Для GitHub Pages добавьте те же значения в Variables репозитория.</span></div></div>
    <p className="form-error"><CircleHelp size={16} /> Не вставляйте сюда и не публикуйте секретный service_role ключ.</p>
    <a className="button button-secondary button-block" href={`${import.meta.env.BASE_URL}guide.html`}>Открыть инструкцию</a>
  </div></main>;
}

function PasswordRecoveryScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); if (!supabase) return; setError(''); if (password !== confirm) { setError('Пароли не совпадают.'); return; } setBusy(true); try { const { error: updateError } = await supabase.auth.updateUser({ password }); if (updateError) throw updateError; setSaved(true); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  return <main className="auth-screen"><div className="auth-card panel"><Brand /><div className="auth-intro"><h1>Новый пароль</h1><p>Придумайте пароль не короче 8 символов.</p></div>{saved ? <><p className="form-success">Пароль изменён.</p><button className="button button-primary button-block" onClick={onDone}>Продолжить</button></> : <form className="stack-form" onSubmit={submit}><Field label="Новый пароль"><input type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field><Field label="Повторите пароль"><input type="password" minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>{error && <p className="form-error">{error}</p>}<button className="button button-primary button-block" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />} Сохранить пароль</button></form>}</div></main>;
}

function PairSetup({ user, pendingInvite, onRefresh, onNotice }: { user: User; pendingInvite: string; onRefresh: () => void; onNotice: (text: string, kind?: 'success' | 'error' | 'info') => void }) {
  const [name, setName] = useState('Наш календарь'); const [busy, setBusy] = useState(false); const [inviteLink, setInviteLink] = useState('');
  async function createPair(event: FormEvent) {
    event.preventDefault(); if (!supabase) return; setBusy(true);
    try { const { error } = await supabase.rpc('create_couple', { p_name: name }); if (error) throw error; onNotice('Общий календарь создан.'); onRefresh(); }
    catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { setBusy(false); }
  }
  async function acceptInvite() {
    if (!supabase || !pendingInvite) return; setBusy(true);
    try { const { error } = await supabase.rpc('accept_invitation', { p_token: pendingInvite }); if (error) throw error; history.replaceState({}, '', `${location.pathname}${location.hash}`); onNotice('Вы присоединились к календарю пары.'); onRefresh(); }
    catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { setBusy(false); }
  }
  async function createInvite() {
    if (!supabase) return; setBusy(true);
    try { const { data, error } = await supabase.rpc('create_invitation', { p_couple_id: (await supabase.from('couple_members').select('couple_id').eq('user_id', user.id).single()).data?.couple_id }); if (error) throw error; if (!data) throw new Error('Не удалось получить ссылку.'); setInviteLink(`${location.origin}${import.meta.env.BASE_URL}?invite=${data}`); }
    catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { setBusy(false); }
  }
  return <main className="auth-screen"><div className="auth-card panel pair-setup"><Brand />
    {pendingInvite ? <><div className="config-icon"><Users size={24} /></div><h1>Приглашение в календарь</h1><p>Войдите как отдельный участник пары, чтобы видеть общий календарь.</p><button className="button button-primary button-block" disabled={busy} onClick={acceptInvite}>{busy ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />} Принять приглашение</button></>
      : <><div className="config-icon"><Heart size={24} /></div><h1>Начните ваш общий календарь</h1><p>Сначала создайте пространство пары, затем отправьте одноразовую ссылку партнёру.</p>
        <form className="stack-form" onSubmit={createPair}><Field label="Название календаря"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field><button className="button button-primary button-block" disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />} Создать календарь</button></form>
        <div className="invite-divider"><span>Уже создали календарь?</span></div><button className="button button-secondary button-block" disabled={busy} onClick={createInvite}><Link2 size={17} /> Создать приглашение</button>
        {inviteLink && <div className="invite-result"><p>Ссылка одноразовая и действует 7 дней. Отправьте её партнёру удобным способом.</p><div className="copy-row"><input readOnly value={inviteLink} /><button className="button button-primary" onClick={() => { navigator.clipboard?.writeText(inviteLink); onNotice('Ссылка скопирована.'); }}>Копировать</button></div></div>}
      </>}
    <p className="fine-print"><Shield size={14} /> Доступ выдаёт только принятая ссылка, а не знание адреса календаря.</p>
  </div></main>;
}

function App() {
  const [session, setSession] = useState<Session | null>(null); const [authReady, setAuthReady] = useState(false); const [recoveryMode, setRecoveryMode] = useState(false);
  const [tab, setTab] = useState<Tab>('calendar'); const [loading, setLoading] = useState(false); const [refreshKey, setRefreshKey] = useState(0); const [reminderClock, setReminderClock] = useState(0); const [devicePushActive, setDevicePushActive] = useState(false);
  const [couple, setCouple] = useState<CoupleInfo | null>(null); const [profiles, setProfiles] = useState<Profile[]>([]); const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<CalendarEvent[]>([]); const [polls, setPolls] = useState<Poll[]>([]); const [pollOptions, setPollOptions] = useState<PollOption[]>([]); const [votes, setVotes] = useState<VoteRow[]>([]); const [exportRequested, setExportRequested] = useState(false);
  const [ideas, setIdeas] = useState<DateIdea[]>([]); const [importantDates, setImportantDates] = useState<ImportantDate[]>([]); const [tags, setTags] = useState<TagRow[]>([]);
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' | 'info' } | null>(null); const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting'); const [pwaUpdate, setPwaUpdate] = useState(false);
  const [activeEvent, setActiveEvent] = useState<CalendarEvent | null | false>(false); const [eventDate, setEventDate] = useState(todayInput()); const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null); const [importDialog, setImportDialog] = useState<ImportedEvent[] | null>(null);
  const user = session?.user ?? null;
  const { theme, palette, myEventColor, partnerEventColor, change: changeAppearance } = useTheme(user?.id);
  const pendingInvite = useMemo(() => new URLSearchParams(location.search).get('invite') ?? '', []);
  const myProfile = profiles.find((profile) => profile.id === user?.id);
  const partner = profiles.find((profile) => profile.id !== user?.id);
  const showNotice = useCallback((text: string, kind: 'success' | 'error' | 'info' = 'success') => {
    setNotice({ text, kind }); window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 5000);
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => { setSession(nextSession); setAuthReady(true); if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true); });
    return () => subscription.unsubscribe();
  }, []);

  const refreshAll = useCallback(async () => {
    if (!supabase || !user) return;
    setLoading(true); setConnection(navigator.onLine ? 'connecting' : 'offline');
    try {
      const membership = await supabase.from('couple_members').select('couple_id,user_id').eq('user_id', user.id).maybeSingle();
      if (membership.error) throw membership.error;
      if (!membership.data) {
        setCouple(null); setProfiles([]); setEvents([]); setPolls([]); setPollOptions([]); setVotes([]); setIdeas([]); setImportantDates([]); setTags([]); setConnection('online'); return;
      }
      const coupleId = membership.data.couple_id;
      const [coupleResult, membersResult, eventResult, pollResult, ideaResult, dateResult, tagResult] = await Promise.all([
        supabase.from('couples').select('id,name').eq('id', coupleId).single(),
        supabase.from('couple_members').select('user_id').eq('couple_id', coupleId),
        supabase.from('events').select('*').eq('couple_id', coupleId).order('starts_at'),
        supabase.from('polls').select('*').eq('couple_id', coupleId).order('created_at', { ascending: false }),
        supabase.from('date_ideas').select('*').eq('couple_id', coupleId).order('created_at', { ascending: false }),
        supabase.from('important_dates').select('*').eq('couple_id', coupleId).order('event_date'),
        supabase.from('tags').select('*').eq('couple_id', coupleId).order('label'),
      ]);
      for (const result of [coupleResult, membersResult, eventResult, pollResult, ideaResult, dateResult, tagResult]) if (result.error) throw result.error;
      const memberIds = (membersResult.data ?? []).map((row) => row.user_id);
      const [profileResult, detailsResult] = await Promise.all([
        supabase.from('profiles').select('id,display_name,avatar_path').in('id', memberIds),
        eventResult.data?.length ? supabase.from('event_details').select('*').in('event_id', eventResult.data.map((event) => event.id)) : Promise.resolve({ data: [], error: null }),
      ]);
      if (profileResult.error) throw profileResult.error;
      if (detailsResult.error) throw detailsResult.error;
      const profileRows = (profileResult.data ?? []) as Profile[]; setProfiles(profileRows); setCouple(coupleResult.data as CoupleInfo);
      const detailById = new Map((detailsResult.data ?? []).map((row: Record<string, unknown>) => [row.event_id as string, row]));
      const names = new Map(profileRows.map((profile) => [profile.id, profile.display_name || (profile.id === user.id ? accountName(user, profile) : 'Партнёр') || 'Участник']));
      setEvents(((eventResult.data ?? []) as Omit<CalendarEvent, 'details' | 'ownerName'>[]).map((event) => ({
        ...event, details: (detailById.get(event.id) as unknown as EventDetails | undefined) ?? null, ownerName: names.get(event.owner_id) ?? 'Участник',
      })));
      setPolls((pollResult.data ?? []) as Poll[]); setIdeas((ideaResult.data ?? []) as DateIdea[]); setImportantDates((dateResult.data ?? []) as ImportantDate[]); setTags((tagResult.data ?? []) as TagRow[]);
      if (pollResult.data?.length) {
        const ids = pollResult.data.map((poll) => poll.id);
        const [optionResult, voteResult] = await Promise.all([
          supabase.from('poll_options').select('*').in('poll_id', ids).order('sort_order'),
          supabase.from('poll_votes').select('*').in('poll_id', ids),
        ]);
        if (optionResult.error) throw optionResult.error; if (voteResult.error) throw voteResult.error;
        setPollOptions((optionResult.data ?? []) as PollOption[]); setVotes((voteResult.data ?? []) as VoteRow[]);
      } else { setPollOptions([]); setVotes([]); }
      const avatarEntries = await Promise.all(profileRows.filter((profile) => profile.avatar_path).map(async (profile) => {
        const { data } = await supabase!.storage.from('avatars').createSignedUrl(profile.avatar_path!, 3600);
        return [profile.id, data?.signedUrl ?? ''] as const;
      }));
      setAvatars(Object.fromEntries(avatarEntries.filter(([, value]) => value)));
      setConnection('online');
    } catch (cause) {
      setConnection(navigator.onLine ? 'offline' : 'offline'); showNotice(`Не удалось обновить данные: ${errorMessage(cause)}`, 'error');
    } finally { setLoading(false); }
  }, [user, showNotice]);

  useEffect(() => { if (user) void refreshAll(); }, [user, refreshKey, refreshAll]);
  const refresh = () => setRefreshKey((key) => key + 1);

  useEffect(() => {
    if (!supabase || !user) return;
    let active = true;
    const load = async () => {
      const { data, error } = await supabase!.from('user_preferences').select('theme_mode,palette,my_event_color,partner_event_color').eq('user_id', user.id).maybeSingle();
      if (!active) return;
      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') showNotice('Для сохранения персонального оформления примените новую миграцию Supabase. Инструкция: docs/НАСТРОЙКА.md.', 'info');
        else showNotice(`Не удалось загрузить оформление: ${errorMessage(error)}`, 'error');
        return;
      }
      if (data && ['dark', 'light', 'system'].includes(data.theme_mode) && palettes.some((item) => item.id === data.palette)) {
        const color = (value: unknown) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : null;
        changeAppearance({ theme_mode: data.theme_mode as ThemeMode, palette: data.palette as PaletteId, my_event_color: color(data.my_event_color), partner_event_color: color(data.partner_event_color) });
      }
    };
    void load();
    const channel = supabase.channel(`preferences-${user.id}`).on('postgres_changes', {
      event: '*', schema: 'public', table: 'user_preferences', filter: `user_id=eq.${user.id}`,
    }, (payload) => {
      const next = payload.new as Partial<AppearancePreferences>;
      if (next.theme_mode && ['dark', 'light', 'system'].includes(next.theme_mode) && next.palette && palettes.some((item) => item.id === next.palette)) {
        const color = (value: unknown) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : null;
        changeAppearance({ theme_mode: next.theme_mode, palette: next.palette, my_event_color: color(next.my_event_color), partner_event_color: color(next.partner_event_color) });
      }
    }).subscribe();
    return () => { active = false; void supabase!.removeChannel(channel); };
  }, [user?.id, changeAppearance, showNotice]);

  useEffect(() => {
    if (!supabase || !couple) return;
    let timeout: number | undefined;
    const scheduleRefresh = () => { window.clearTimeout(timeout); timeout = window.setTimeout(() => void refreshAll(), 500); };
    const channel = supabase.channel(`pair-${couple.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `couple_id=eq.${couple.id}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_details' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'polls', filter: `couple_id=eq.${couple.id}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_options' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'date_ideas', filter: `couple_id=eq.${couple.id}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'important_dates', filter: `couple_id=eq.${couple.id}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tags', filter: `couple_id=eq.${couple.id}` }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, scheduleRefresh)
      .subscribe((status) => setConnection(status === 'SUBSCRIBED' ? 'online' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'offline' : 'connecting'));
    return () => { window.clearTimeout(timeout); void supabase!.removeChannel(channel); };
  }, [couple, refreshAll]);

  useEffect(() => {
    const nearest = events.map((event) => event.surprise_until ? new Date(event.surprise_until).getTime() : Infinity).filter((time) => time > Date.now()).sort((a, b) => a - b)[0];
    if (!nearest) return;
    const timer = window.setTimeout(() => void refreshAll(), Math.min(nearest - Date.now() + 500, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [events, refreshAll]);

  useEffect(() => {
    const handler = (event: Event) => { event.preventDefault(); setInstallPrompt(event as BeforeInstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', handler); return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  useEffect(() => { const handler = () => setPwaUpdate(true); window.addEventListener('pwa-update-ready', handler); return () => window.removeEventListener('pwa-update-ready', handler); }, []);
  useEffect(() => { const handler = () => setConnection(navigator.onLine ? 'connecting' : 'offline'); window.addEventListener('online', handler); window.addEventListener('offline', handler); return () => { window.removeEventListener('online', handler); window.removeEventListener('offline', handler); }; }, []);

  useEffect(() => {
    let live = true;
    const refreshPushState = async (event?: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'boolean') { setDevicePushActive(event.detail); return; }
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setDevicePushActive(false); return; }
      try { const registration = await navigator.serviceWorker.getRegistration(); const subscription = await registration?.pushManager.getSubscription(); if (live) setDevicePushActive(Boolean(subscription)); }
      catch { if (live) setDevicePushActive(false); }
    };
    void refreshPushState(); window.addEventListener('push-subscription-change', refreshPushState);
    return () => { live = false; window.removeEventListener('push-subscription-change', refreshPushState); };
  }, [user?.id]);

  useEffect(() => {
    if (devicePushActive || !events.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const seen: string[] = JSON.parse(localStorage.getItem('vmeste-fired-reminders') ?? '[]');
    const now = Date.now(); const windowEnd = new Date(now + 366 * 86_400_000); const timers: number[] = []; let hasDistantReminder = false;
    for (const event of events) {
      const repeatedEvents = occurrences(event, new Date(now), windowEnd);
      for (const occurrence of repeatedEvents) for (const reminder of event.details?.reminders ?? []) {
        const starts = new Date(occurrence.starts_at).getTime(); const fireAt = starts - reminder.minutes * 60_000;
        const key = `${event.id}:${occurrence.starts_at}:${reminder.minutes}`;
        if (fireAt <= now || seen.includes(key)) continue;
        if (fireAt - now > maxBrowserTimeout) { hasDistantReminder = true; continue; }
        timers.push(window.setTimeout(() => {
        const currentSeen: string[] = JSON.parse(localStorage.getItem('vmeste-fired-reminders') ?? '[]');
        if (currentSeen.includes(key)) return;
        localStorage.setItem('vmeste-fired-reminders', JSON.stringify([...currentSeen, key].slice(-300)));
        const title = occurrence.details?.title ?? (occurrence.visibility === 'busy' ? 'Занято' : 'Сюрприз');
        const body = `${title} · ${formatDate(occurrence.starts_at)} в ${formatTime(occurrence.starts_at)}`;
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) void navigator.serviceWorker.ready.then((registration) => registration.showNotification('Напоминание', { body, icon: `${import.meta.env.BASE_URL}icons/icon.svg` }));
        else new Notification('Напоминание', { body });
        setReminderClock((clock) => clock + 1);
        }, Math.max(1, fireAt - now)));
      }
    }
    if (hasDistantReminder) timers.push(window.setTimeout(() => setReminderClock((clock) => clock + 1), maxBrowserTimeout));
    return () => timers.forEach(window.clearTimeout);
  }, [events, reminderClock, devicePushActive]);

  useEffect(() => {
    if (devicePushActive || !importantDates.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const timers: number[] = [];
    for (const item of importantDates) {
      const [month, day] = item.event_date.slice(5, 10).split('-').map(Number);
      const now = new Date(); let year = Number(item.event_date.slice(0, 4));
      let occurrence = new Date(year, month - 1, day, 9, 0, 0);
      if (item.repeats_yearly) {
        while (occurrence.getTime() - item.reminder_days * 86_400_000 < now.getTime()) { year += 1; occurrence = new Date(year, month - 1, day, 9, 0, 0); }
      } else if (occurrence.getTime() - item.reminder_days * 86_400_000 < now.getTime()) continue;
      const remindAt = occurrence.getTime() - item.reminder_days * 86_400_000; const key = `date:${item.id}:${year}`;
      const seen: string[] = JSON.parse(localStorage.getItem('vmeste-fired-reminders') ?? '[]'); if (seen.includes(key)) continue;
      const fire = () => {
        const remaining = remindAt - Date.now();
        if (remaining > 0) { timers.push(window.setTimeout(fire, Math.min(remaining, 2_000_000_000))); return; }
        const currentSeen: string[] = JSON.parse(localStorage.getItem('vmeste-fired-reminders') ?? '[]');
        if (currentSeen.includes(key)) return;
        localStorage.setItem('vmeste-fired-reminders', JSON.stringify([...currentSeen, key].slice(-300)));
        const message = `${item.title} · ${formatDate(occurrence, { day: 'numeric', month: 'long' })}`;
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) void navigator.serviceWorker.ready.then((registration) => registration.showNotification('Важная дата', { body: message, icon: `${import.meta.env.BASE_URL}icons/icon.svg` }));
        else new Notification('Важная дата', { body: message });
      };
      timers.push(window.setTimeout(fire, Math.min(Math.max(1, remindAt - Date.now()), 2_000_000_000)));
    }
    return () => timers.forEach(window.clearTimeout);
  }, [importantDates, devicePushActive]);

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt(); const choice = await installPrompt.userChoice;
    showNotice(choice.outcome === 'accepted' ? 'Приложение добавлено на устройство.' : 'Установку можно запустить позже из меню браузера.', 'info'); setInstallPrompt(null);
  }
  async function signOut() {
    if (!supabase) return;
    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.getRegistration(); const subscription = await registration?.pushManager.getSubscription();
        if (subscription) { await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint); await subscription.unsubscribe(); }
      }
    } catch { /* Logout still needs to work if the device is offline. */ }
    await supabase.auth.signOut(); setTab('calendar');
  }

  if (!supabaseConfigured) return <ConfigurationScreen />;
  if (!authReady) return <main className="auth-screen"><div className="loading-card"><LoaderCircle size={24} className="spin" /><span>Подключаем аккаунт…</span></div></main>;
  if (!user) return <><AuthScreen invitePending={Boolean(pendingInvite)} /><Notice notice={notice} dismiss={() => setNotice(null)} /></>;
  if (recoveryMode) return <PasswordRecoveryScreen onDone={() => { setRecoveryMode(false); showNotice('Пароль обновлён.'); }} />;
  if (!couple) return <><PairSetup user={user} pendingInvite={pendingInvite} onRefresh={refresh} onNotice={showNotice} /><Notice notice={notice} dismiss={() => setNotice(null)} /></>;

  const saveEvent = async (draft: EventDraft) => {
    if (!supabase || !couple || !user) return;
    let startsAt: string; let endsAt: string;
    if (draft.allDay) {
      startsAt = new Date(`${draft.starts}T00:00:00`).toISOString();
      endsAt = new Date(`${dateInput(addDays(new Date(`${draft.ends}T00:00:00`), 1))}T00:00:00`).toISOString();
    } else { startsAt = fromLocalInput(draft.starts); endsAt = fromLocalInput(draft.ends); }
    const payload = {
      id: draft.base?.id ?? crypto.randomUUID(), couple_id: couple.id, starts_at: startsAt, ends_at: endsAt,
      all_day: draft.allDay, timezone: timezoneName(), visibility: draft.visibility,
      surprise_until: draft.surprise ? fromLocalInput(draft.surprise) : null,
      recurrence_frequency: draft.recurrence, recurrence_interval: draft.interval,
      recurrence_until: draft.recurrenceUntil || null,
    };
    const { error } = await supabase.rpc('save_calendar_event', { p_event: payload, p_details: { ...draft.details, tags: draft.details.tags, reminders: draft.details.reminders }, p_expected_updated_at: draft.base?.updated_at ?? null });
    if (error) throw error;
    showNotice(draft.base ? 'Изменения события сохранены.' : 'Событие добавлено.'); setActiveEvent(false); await refreshAll();
  };
  const deleteEvent = async (event: CalendarEvent) => {
    if (!supabase) return;
    const { error } = await supabase.rpc('delete_calendar_event', { p_event_id: event.id, p_expected_updated_at: event.updated_at });
    if (error) throw error; setActiveEvent(false); showNotice('Событие удалено.'); await refreshAll();
  };
  const createPoll = async (question: string, description: string, options: string[], pollTags: string[]) => {
    if (!supabase || !user || !couple) return;
    const { data, error } = await supabase.from('polls').insert({ couple_id: couple.id, created_by: user.id, question, description, tags: pollTags }).select('id').single();
    if (error) throw error;
    const { error: optionError } = await supabase.from('poll_options').insert(options.map((label, index) => ({ poll_id: data.id, label, sort_order: index })));
    if (optionError) { await supabase.from('polls').delete().eq('id', data.id); throw optionError; }
    showNotice('Опрос создан.'); await refreshAll();
  };
  const vote = async (pollId: string, optionId: string) => {
    if (!supabase) return; const { error } = await supabase.rpc('cast_poll_vote', { p_poll_id: pollId, p_option_id: optionId });
    if (error) throw error; showNotice('Ваш голос учтён.'); await refreshAll();
  };
  const saveIdea = async (idea: Partial<DateIdea> & { title: string; description: string; tags: string[] }) => {
    if (!supabase || !user || !couple) return;
    const payload = { ...idea, couple_id: couple.id, created_by: idea.created_by ?? user.id, title: idea.title, description: idea.description, tags: idea.tags };
    const query = idea.id ? supabase.from('date_ideas').update({ title: payload.title, description: payload.description, tags: payload.tags }).eq('id', idea.id) : supabase.from('date_ideas').insert(payload);
    const { error } = await query; if (error) throw error; showNotice(idea.id ? 'Идея обновлена.' : 'Идея добавлена.'); await refreshAll();
  };
  const changeIdeaStatus = async (idea: DateIdea) => { if (!supabase) return; const next = idea.status === 'idea' ? 'chosen' : idea.status === 'chosen' ? 'done' : 'idea'; const { error } = await supabase.from('date_ideas').update({ status: next }).eq('id', idea.id); if (error) throw error; await refreshAll(); };
  const removeIdea = async (idea: DateIdea) => { if (!supabase || !window.confirm(`Удалить идею «${idea.title}»?`)) return; const { error } = await supabase.from('date_ideas').delete().eq('id', idea.id); if (error) throw error; showNotice('Идея удалена.'); await refreshAll(); };
  const addTag = async (label: string, color: string) => { if (!supabase || !user || !couple) return; const { error } = await supabase.from('tags').insert({ couple_id: couple.id, created_by: user.id, label, color }); if (error) throw error; await refreshAll(); };
  const removeTag = async (tag: TagRow) => { if (!supabase || !window.confirm(`Удалить тег «${tag.label}»? Он останется в уже созданных событиях.`)) return; const { error } = await supabase.from('tags').delete().eq('id', tag.id); if (error) throw error; await refreshAll(); };
  const addImportantDate = async (title: string, date: string, repeats: boolean, reminderDays: number) => { if (!supabase || !couple || !user) return; const { error } = await supabase.from('important_dates').insert({ couple_id: couple.id, created_by: user.id, title, event_date: date, repeats_yearly: repeats, reminder_days: reminderDays }); if (error) throw error; await refreshAll(); };
  const deleteImportantDate = async (item: ImportantDate) => { if (!supabase || !window.confirm(`Удалить важную дату «${item.title}»?`)) return; const { error } = await supabase.from('important_dates').delete().eq('id', item.id); if (error) throw error; await refreshAll(); };

  const importFile = async (file: File) => {
    try { const imported = parseCalendar(await file.text()); if (!imported.length) throw new Error('В файле не найдены события.'); setImportDialog(imported); }
    catch (cause) { showNotice(`Не удалось прочитать .ics: ${errorMessage(cause)}`, 'error'); }
  };
  const commitImport = async () => {
    if (!supabase || !couple || !importDialog) return;
    try {
      for (const item of importDialog) {
        let startsAt = item.starts_at; let endsAt = item.ends_at;
        if (item.all_day) { startsAt = new Date(`${dateInput(item.starts_at)}T00:00:00`).toISOString(); endsAt = new Date(`${dateInput(item.ends_at)}T00:00:00`).toISOString(); }
        const { error } = await supabase.rpc('save_calendar_event', { p_event: { id: crypto.randomUUID(), couple_id: couple.id, starts_at: startsAt, ends_at: endsAt, all_day: item.all_day, timezone: item.timezone, visibility: 'full', surprise_until: null, recurrence_frequency: item.recurrence_frequency, recurrence_interval: item.recurrence_interval, recurrence_until: item.recurrence_until }, p_details: item.details, p_expected_updated_at: null });
        if (error) throw error;
      }
      setImportDialog(null); showNotice(`Импортировано событий: ${importDialog.length}.`); await refreshAll();
    } catch (cause) { showNotice(`Импорт прерван: ${errorMessage(cause)}`, 'error'); await refreshAll(); }
  };

  const exportCurrent = (from: Date, to: Date, allowed: Visibility[]) => {
    const filtered = events.filter((event) => allowed.includes(event.visibility));
    const blob = new Blob([exportCalendar(filtered, from, to)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `vmeste-${dateInput(from)}-${dateInput(to)}.ics`; link.click(); URL.revokeObjectURL(url); showNotice('Файл календаря подготовлен.');
  };

  async function updateProfile(name: string) {
    if (!supabase || !user) return; const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', user.id); if (error) throw error; showNotice('Имя сохранено.'); await refreshAll();
  }
  async function updateAppearance(themeMode: ThemeMode, colorPalette: PaletteId, myColor: string | null, partnerColor: string | null) {
    if (!supabase || !user) throw new Error('Сначала войдите в аккаунт.');
    const { error } = await supabase.from('user_preferences').upsert({
      user_id: user.id, theme_mode: themeMode, palette: colorPalette, my_event_color: myColor, partner_event_color: partnerColor, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw error;
    changeAppearance({ theme_mode: themeMode, palette: colorPalette, my_event_color: myColor, partner_event_color: partnerColor });
    showNotice('Оформление сохранено для вашего аккаунта.');
  }
  async function uploadAvatar(file: File | null) {
    if (!supabase || !user) return;
    if (!file) {
      if (myProfile?.avatar_path) { const { error } = await supabase.storage.from('avatars').remove([myProfile.avatar_path]); if (error) throw error; }
      const { error } = await supabase.from('profiles').update({ avatar_path: null }).eq('id', user.id); if (error) throw error; showNotice('Аватар удалён.'); await refreshAll(); return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Выберите JPG, PNG или WebP размером до 5 МБ.');
    const path = `${user.id}/avatar.${file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'}`;
    const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, { upsert: true, contentType: file.type }); if (uploadError) throw uploadError;
    const { error } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', user.id); if (error) throw error; showNotice('Аватар загружен.'); await refreshAll();
  }

  return <div className="app-shell">
    <aside className="side-rail"><div className="side-brand"><Brand /></div><div className="pair-mini"><div className="pair-avatars"><Avatar name={accountName(user, myProfile)} url={avatars[user.id]} /><Avatar name={partner?.display_name || 'Партнёр'} url={partner ? avatars[partner.id] : null} /></div><div><b>{couple.name}</b><small>{partner ? 'Ваш общий календарь' : 'Пока вы вдвоём?'}</small></div></div>
      <nav className="side-nav" aria-label="Главная навигация">{tabs.map(({ id, label, icon: Icon }) => <button className={`nav-item ${tab === id ? 'selected' : ''}`} key={id} onClick={() => setTab(id)}><Icon size={19} /><span>{id === 'settings' ? 'Настройки' : label}</span></button>)}</nav>
      <button className="button button-primary side-add" onClick={() => { setEventDate(todayInput()); setActiveEvent(null); }}><Plus size={17} /> Новое событие</button>
      <div className="side-bottom"><Connection status={connection} /><button className="user-row" onClick={() => setTab('settings')}><Avatar name={accountName(user, myProfile)} url={avatars[user.id]} size="small" /><span>{accountName(user, myProfile)}</span><ChevronDown size={15} /></button></div>
    </aside>
    <div className="main-column"><header className="topbar"><div className="mobile-brand"><Brand /></div><div className="topbar-title"><span className="eyebrow">ВАШЕ ВРЕМЯ ВДВОЁМ</span><h1>{tab === 'calendar' ? 'Календарь' : tab === 'polls' ? 'Опросы' : tab === 'ideas' ? 'Идеи свиданий' : 'Настройки'}</h1></div>
      <div className="topbar-actions"><Connection status={connection} /><div className="header-avatars"><Avatar name={accountName(user, myProfile)} url={avatars[user.id]} size="small" /><span className="avatar-plus">+</span><Avatar name={partner?.display_name || 'Партнёр'} url={partner ? avatars[partner.id] : null} size="small" /></div><button className="button button-primary header-add" onClick={() => { setEventDate(todayInput()); setActiveEvent(null); }}><Plus size={17} /><span>Событие</span></button></div>
    </header>
    {loading && <div className="sync-line"><span /></div>}
    {pwaUpdate && <div className="update-banner"><span>Доступна новая версия приложения.</span><button className="button button-secondary" onClick={() => navigator.serviceWorker.getRegistration().then((registration) => registration?.waiting?.postMessage('SKIP_WAITING'))}>Обновить</button><button className="icon-button" aria-label="Позже" onClick={() => setPwaUpdate(false)}><X size={15} /></button></div>}
    <main className="content-area">
      {tab === 'calendar' && <CalendarView events={events} userId={user.id} hasPartner={Boolean(partner)} date={eventDate} setDate={setEventDate} busy={loading} onCreate={(date) => { setEventDate(date); setActiveEvent(null); }} onOpen={(event) => setActiveEvent(event)} onExport={() => { setExportRequested(true); setTab('settings'); }} />}
      {tab === 'polls' && <PollsView polls={polls} options={pollOptions} votes={votes} userId={user.id} tags={tags} onCreate={createPoll} onVote={vote} onError={(text) => showNotice(text, 'error')} />}
      {tab === 'ideas' && <IdeasView ideas={ideas} onSave={saveIdea} onStatus={changeIdeaStatus} onDelete={removeIdea} onError={(text) => showNotice(text, 'error')} />}
      {tab === 'settings' && <SettingsView user={user} profile={myProfile} partner={partner} avatars={avatars} couple={couple} theme={theme} palette={palette} myEventColor={myEventColor} partnerEventColor={partnerEventColor} onAppearance={updateAppearance} onProfile={updateProfile} onAvatar={uploadAvatar} vapidPublicKey={import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''} openExport={exportRequested} onExportOpened={() => setExportRequested(false)} onInvite={async () => {
        if (!supabase) return ''; const { data: member } = await supabase.from('couple_members').select('couple_id').eq('user_id', user.id).single(); const { data, error } = await supabase.rpc('create_invitation', { p_couple_id: member?.couple_id }); if (error) throw error; return `${location.origin}${import.meta.env.BASE_URL}?invite=${data}`;
      }} onSignOut={signOut} onAddTag={addTag} onDeleteTag={removeTag} tags={tags} importantDates={importantDates} onAddDate={addImportantDate} onDeleteDate={deleteImportantDate} onImport={importFile} onExport={exportCurrent} events={events} installPrompt={Boolean(installPrompt)} onInstall={install} onNotice={showNotice} />}
    </main>
    <nav className="bottom-nav" aria-label="Нижняя навигация">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={`bottom-nav-item ${tab === id ? 'selected' : ''}`} onClick={() => setTab(id)}><span className="bottom-icon"><Icon size={20} /></span><span>{id === 'settings' ? 'Ещё' : id === 'ideas' ? 'Идеи' : label}</span></button>)}<button className="bottom-nav-add" aria-label="Новое событие" onClick={() => { setEventDate(todayInput()); setActiveEvent(null); }}><Plus size={23} /></button></nav>
    <Notice notice={notice} dismiss={() => setNotice(null)} />
    {activeEvent !== false && <EventDialog event={activeEvent || null} date={eventDate} userId={user.id} tags={tags} onClose={() => setActiveEvent(false)} onSave={saveEvent} onDelete={deleteEvent} onError={(text) => showNotice(text, 'error')} />}
    {importDialog && <Dialog title="Предпросмотр импорта" close={() => setImportDialog(null)}><p>В файле найдено событий: <b>{importDialog.length}</b>. Они будут добавлены в общий календарь и станут видны партнёру согласно выбранной видимости «полностью видно».</p><div className="import-preview">{importDialog.slice(0, 8).map((event, index) => <div key={index}><CalendarDays size={16} /><span><b>{event.details.title}</b><small>{formatDate(event.starts_at)} · {event.all_day ? 'весь день' : formatTime(event.starts_at)}{event.unsupportedRecurrence ? ' · повторение будет импортировано как одно событие' : ''}</small></span></div>)}{importDialog.length > 8 && <small>И ещё {importDialog.length - 8}…</small>}</div><div className="dialog-actions"><button className="button button-secondary" onClick={() => setImportDialog(null)}>Отмена</button><button className="button button-primary" onClick={() => void commitImport()}><Upload size={16} /> Импортировать</button></div></Dialog>}
    </div>
  </div>;
}

function Connection({ status }: { status: 'connecting' | 'online' | 'offline' }) {
  return <span className={`connection connection-${status}`}>{status === 'online' ? <Cloud size={14} /> : status === 'offline' ? <CloudOff size={14} /> : <LoaderCircle className="spin" size={14} />}<span>{status === 'online' ? 'Синхронизировано' : status === 'offline' ? 'Нет связи' : 'Подключение'}</span></span>;
}

function CalendarView({ events, userId, hasPartner, date, setDate, busy, onCreate, onOpen, onExport }: { events: CalendarEvent[]; userId: string; hasPartner: boolean; date: string; setDate: (date: string) => void; busy: boolean; onCreate: (date: string) => void; onOpen: (event: CalendarEvent) => void; onExport: () => void }) {
  const [view, setView] = useState<'month' | 'week' | 'list'>('month'); const current = new Date(`${date}T12:00:00`); const start = view === 'week' ? weekStart(current) : monthStart(current);
  const gridStart = weekStart(start); const rangeStart = view === 'week' ? start : view === 'list' ? localMidnight(current) : gridStart; const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(start, i)) : Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const end = view === 'list' ? addDays(rangeStart, 31) : addDays(days[days.length - 1], 1); const visibleEvents = useMemo(() => events.flatMap((event) => occurrences(event, rangeStart, end)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)), [events, rangeStart.getTime(), end.getTime()]);
  const go = (amount: number) => { const next = view === 'week' ? addDays(current, amount * 7) : view === 'list' ? addDays(current, amount * 14) : new Date(current.getFullYear(), current.getMonth() + amount, 1); setDate(dateInput(next)); };
  const header = view === 'week' ? `${formatDate(start, { day: 'numeric', month: 'long' })} — ${formatDate(addDays(start, 6), { day: 'numeric', month: 'long', year: 'numeric' })}` : new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(current);
  const byDay = (day: Date) => visibleEvents.filter((event) => new Date(event.starts_at) < addDays(localMidnight(day), 1) && new Date(event.ends_at) > localMidnight(day));
  const busyDay = (day: Date) => byDay(day).length === 0;
  return <div className="calendar-page"><section className="calendar-heading"><div><span className="eyebrow">ПЛАНИРУЙТЕ ВАЖНОЕ</span><h2>{header}</h2><p>Два расписания — один общий план.</p></div><div className="calendar-heading-actions"><button className="button button-secondary hide-mobile" onClick={onExport}><Download size={16} /> .ics</button><button className="button button-primary" onClick={() => onCreate(todayInput())}><Plus size={17} /><span>Новое событие</span></button></div></section>
    <section className="calendar-panel panel"><div className="calendar-toolbar"><div className="calendar-switcher"><button className="icon-button" aria-label="Назад" onClick={() => go(-1)}><ChevronLeft size={19} /></button><button className="button button-secondary today-button" onClick={() => setDate(todayInput())}>Сегодня</button><button className="icon-button" aria-label="Вперёд" onClick={() => go(1)}><ChevronRight size={19} /></button></div><div className="view-toggle">{(['month', 'week', 'list'] as const).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item === 'month' ? 'Месяц' : item === 'week' ? 'Неделя' : 'Список'}</button>)}</div></div>
      {view !== 'list' ? <div className={`calendar-grid ${view === 'week' ? 'calendar-grid-week' : ''}`}>
        <div className="weekday-row">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => <span key={day}>{day}</span>)}</div>
        {days.map((day) => {
          const dayEvents = byDay(day); const inCurrentMonth = view === 'week' || day.getMonth() === current.getMonth(); const today = sameDay(day, new Date()); const free = busyDay(day) && hasPartner;
          return <button key={day.toISOString()} className={`day-cell ${inCurrentMonth ? '' : 'outside'} ${today ? 'today' : ''} ${free && inCurrentMonth ? 'free-day' : ''}`} onClick={() => onCreate(dateInput(day))}>
            <span className="day-number">{day.getDate()}</span>
            <span className="day-event-list">{dayEvents.slice(0, view === 'week' ? 5 : 3).map((event) => {
              const ownerClass = event.owner_id === userId ? 'mine' : 'partner';
              const title = event.details ? event.details.title : event.visibility === 'busy' ? 'Занято' : 'Сюрприз';
              return <span key={`${event.id}-${event.starts_at}`} role="button" tabIndex={0} title={`${title} · ${event.owner_id === userId ? 'Вы' : event.ownerName}`} className={`mini-event ${ownerClass} ${event.visibility === 'busy' && event.owner_id !== userId ? 'busy-event' : ''} ${event.visibility === 'private' ? 'private-event' : ''}`} onClick={(e) => { e.stopPropagation(); onOpen(event); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpen(event); } }} style={{ '--event-color': event.details?.color ?? '#84909b' } as React.CSSProperties}><i />{title}</span>;
            })}{dayEvents.length > (view === 'week' ? 5 : 3) && <small className="more-events">ещё {dayEvents.length - (view === 'week' ? 5 : 3)}</small>}</span>
          </button>;
        })}
      </div> : <div className="event-list">{visibleEvents.length ? visibleEvents.map((event) => <EventListCard key={`${event.id}-${event.starts_at}`} event={event} userId={userId} onClick={() => onOpen(event)} />) : <EmptyState icon={<CalendarDays size={21} />} title="Пока тихо" text="Здесь появятся ваши события. Можно начать с небольшого плана на двоих." action={<button className="button button-primary" onClick={() => onCreate(todayInput())}><Plus size={16} /> Добавить событие</button>} />}</div>}
      <div className="calendar-legend"><span><i className="legend-dot mine-dot" />Моё</span><span><i className="legend-dot partner-dot" />Партнёра</span><span><i className="legend-dot free-dot-legend" />Свободный день</span><span className="legend-note"><Shield size={13} /> Доступ зависит от видимости события</span></div>
    </section>
    <div className="calendar-bottom-row"><div className="side-card panel"><div className="side-card-title"><span className="small-icon mint"><Users size={16} /></span><b>Наш ритм</b></div><p>{events.filter((event) => event.owner_id === userId).length} ваших событий <span>·</span> {events.filter((event) => event.owner_id !== userId).length} партнёра</p><div className="overlap-bar"><span style={{ width: `${Math.min(92, 24 + events.length * 3)}%` }} /></div><small>Свободные дни подсвечены в календаре</small></div><div className="side-card panel"><div className="side-card-title"><span className="small-icon lavender"><Sparkles size={16} /></span><b>Напоминание</b></div><p>Добавьте напоминание к событию, чтобы не забыть важное.</p><button className="text-button" onClick={() => onCreate(todayInput())}>Создать событие <ArrowRight size={14} /></button></div></div>
    {busy && <span className="visually-hidden">Обновляем календарь</span>}
  </div>;
}
function EventListCard({ event, userId, onClick }: { event: CalendarEvent; userId: string; onClick: () => void }) {
  const visibleTitle = event.details?.title ?? (event.visibility === 'busy' && event.owner_id !== userId ? 'Занято' : 'Сюрприз');
  return <button className="event-row" onClick={onClick}><span className="event-date-pill"><b>{new Date(event.starts_at).getDate()}</b><small>{new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(new Date(event.starts_at))}</small></span><span className="event-row-info"><b>{visibleTitle}</b><small>{event.all_day ? 'Весь день' : `${formatTime(event.starts_at)} – ${formatTime(event.ends_at)}`} · {event.owner_id === userId ? 'Вы' : event.ownerName}</small></span><span className="event-row-color" style={{ background: event.details?.color ?? '#76808a' }} /><ChevronRight size={17} /></button>;
}

function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function EventDialog({ event, date, userId, tags, onClose, onSave, onDelete, onError }: { event: CalendarEvent | null; date: string; userId: string; tags: TagRow[]; onClose: () => void; onSave: (draft: EventDraft) => Promise<void>; onDelete: (event: CalendarEvent) => Promise<void>; onError: (text: string) => void }) {
  const editable = !event || event.owner_id === userId;
  const sourceStart = event?.originalStartsAt ?? event?.starts_at;
  const sourceEnd = event?.originalEndsAt ?? event?.ends_at;
  const [allDay, setAllDay] = useState(event?.all_day ?? false);
  const [starts, setStarts] = useState(() => event ? (event.all_day ? dateInput(sourceStart!) : toLocalInput(sourceStart!)) : `${date}T18:00`);
  const [ends, setEnds] = useState(() => event ? (event.all_day ? dateInput(addDays(new Date(sourceEnd!), -1)) : toLocalInput(sourceEnd!)) : `${date}T19:00`);
  const [visibility, setVisibility] = useState<Visibility>(event?.visibility ?? 'full');
  const [surprise, setSurprise] = useState(event?.surprise_until ? toLocalInput(event.surprise_until) : '');
  const [recurrence, setRecurrence] = useState<CalendarEvent['recurrence_frequency']>(event?.recurrence_frequency ?? null);
  const [interval, setInterval] = useState(event?.recurrence_interval ?? 1);
  const [recurrenceUntil, setRecurrenceUntil] = useState(event?.recurrence_until ?? '');
  const [details, setDetails] = useState<EventDetails>(() => event?.details ? { ...event.details, reminders: event.details.reminders ?? [], tags: event.details.tags ?? [] } : blankDetails());
  const [saving, setSaving] = useState(false);
  const updateDetails = <K extends keyof EventDetails>(key: K, value: EventDetails[K]) => setDetails((current) => ({ ...current, [key]: value }));
  const hiddenBySurprise = Boolean(event && event.owner_id !== userId && event.surprise_until && new Date(event.surprise_until) > new Date());
  const detailsAvailable = Boolean(event?.details);
  const displayTitle = hiddenBySurprise ? 'Сюрприз' : event?.details?.title ?? (event?.visibility === 'busy' ? 'Занятое время' : 'Сюрприз');

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault(); if (!editable) return;
    const startDate = new Date(`${starts}T00:00:00`);
    const endDate = new Date(`${ends}T00:00:00`);
    const startMillis = allDay ? startDate.getTime() : new Date(starts).getTime();
    const endMillis = allDay ? addDays(endDate, 1).getTime() : new Date(ends).getTime();
    if (!details.title.trim()) { onError('Добавьте название события.'); return; }
    if (!Number.isFinite(startMillis) || !Number.isFinite(endMillis) || endMillis <= startMillis) { onError('Время окончания должно быть позже начала.'); return; }
    setSaving(true);
    try { await onSave({ base: event, starts, ends, allDay, visibility, surprise, recurrence, interval, recurrenceUntil, details: { ...details, title: details.title.trim(), tags: details.tags.filter(Boolean) } }); }
    catch (cause) { onError(errorMessage(cause)); } finally { setSaving(false); }
  }
  async function remove() {
    if (!event || !window.confirm(`Удалить событие «${event.details?.title ?? displayTitle}»?`)) return;
    setSaving(true); try { await onDelete(event); } catch (cause) { onError(errorMessage(cause)); } finally { setSaving(false); }
  }

  return <Dialog title={editable ? event ? 'Изменить событие' : 'Новое событие' : displayTitle} close={onClose} wide mobileFullHeight>
    {event && !editable ? <div className="event-readonly">
      <div className="readonly-banner"><span className="small-icon mint">{hiddenBySurprise ? <Sparkles size={16} /> : <Clock3 size={16} />}</span><div><b>{displayTitle}</b><small>{event.all_day ? 'Весь день' : `${formatTime(event.starts_at)} – ${formatTime(event.ends_at)}`} · {formatDate(event.starts_at)}</small></div></div>
      {detailsAvailable && !hiddenBySurprise && <><p>{event.details?.description || 'Описание не добавлено.'}</p>{event.details?.place && <div className="location-line"><MapPin size={16} /><span>{event.details.place}{event.details.address ? ` · ${event.details.address}` : ''}</span></div>}{event.details?.latitude !== null && event.details?.longitude !== null && event.details?.latitude !== undefined && event.details?.longitude !== undefined && <a className="text-button" href={`https://www.google.com/maps?q=${event.details.latitude},${event.details.longitude}`} target="_blank" rel="noreferrer"><Compass size={15} /> Открыть на карте</a>}{Boolean(event.details?.tags.length) && <div className="tag-list">{event.details?.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}</div>}</>}
      <p className="event-author">Создал(а): {event.ownerName}</p>
      {event.visibility === 'busy' && <p className="fine-print"><Shield size={14} /> Автор оставил видимым только занятое время.</p>}
      {hiddenBySurprise && <p className="fine-print"><Sparkles size={14} /> Подробности откроются {formatDate(event.surprise_until!, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.</p>}
      <div className="dialog-actions"><button className="button button-secondary" onClick={onClose}>Закрыть</button></div>
    </div> : <form className="event-form" onSubmit={submit}>
      {event && <div className="event-author-line"><span className="small-icon mint"><Users size={15} /></span>Создал(а): {event.ownerName}{event.isOccurrence && <small>Повторяющееся событие: правка относится ко всей серии.</small>}</div>}
      <div className="form-grid"><Field label="Название"><input value={details.title} maxLength={160} onChange={(e) => updateDetails('title', e.target.value)} required /></Field><Field label="Категория"><select value={details.category} onChange={(e) => updateDetails('category', e.target.value)}>{['Свидание', 'Путешествие', 'Семья', 'Здоровье', 'Дела', 'Другое'].map((value) => <option key={value}>{value}</option>)}</select></Field></div>
      <Field label="Описание"><textarea value={details.description} rows={3} maxLength={4000} onChange={(e) => updateDetails('description', e.target.value)} placeholder="Что важно помнить?" /></Field>
      <label className="check-row all-day-check"><input type="checkbox" checked={allDay} onChange={(e) => {
        if (e.target.checked) { const asDate = starts.slice(0, 10); setStarts(asDate); setEnds(ends.slice(0, 10)); }
        else { const day = starts.slice(0, 10); setStarts(`${day}T09:00`); setEnds(`${day}T10:00`); }
        setAllDay(e.target.checked);
      }} /><span>Событие на весь день</span></label>
      <div className="form-grid event-time-grid"><Field label="Начало"><input type={allDay ? 'date' : 'datetime-local'} value={starts} onChange={(e) => setStarts(e.target.value)} required /></Field><Field label={allDay ? 'Последний день' : 'Окончание'}><input type={allDay ? 'date' : 'datetime-local'} value={ends} onChange={(e) => setEnds(e.target.value)} required /></Field></div>
      <div className="form-grid"><Field label="Место"><input value={details.place} maxLength={160} onChange={(e) => updateDetails('place', e.target.value)} placeholder="Кафе, парк…" /></Field><Field label="Адрес"><input value={details.address} maxLength={240} onChange={(e) => updateDetails('address', e.target.value)} placeholder="Улица и город" /></Field></div>
      <div className="form-grid coordinates-grid"><Field label="Широта"><input type="number" step="any" min="-90" max="90" value={details.latitude ?? ''} onChange={(e) => updateDetails('latitude', e.target.value === '' ? null : Number(e.target.value))} placeholder="52.2297" /></Field><Field label="Долгота"><input type="number" step="any" min="-180" max="180" value={details.longitude ?? ''} onChange={(e) => updateDetails('longitude', e.target.value === '' ? null : Number(e.target.value))} placeholder="21.0122" /></Field><small>Координаты можно скопировать из карты.</small></div>
      <div className="form-grid color-recurrence-grid"><Field label="Цвет"><div className="color-options">{colorOptions.map((color) => <button type="button" aria-label={`Цвет ${color}`} key={color} className={`color-option ${details.color === color ? 'chosen' : ''}`} style={{ backgroundColor: color }} onClick={() => updateDetails('color', color)} />)}<input className="custom-color" type="color" value={details.color} aria-label="Другой цвет" onChange={(e) => updateDetails('color', e.target.value)} /></div></Field><Field label="Повторение"><select value={recurrence ?? ''} onChange={(e) => setRecurrence((e.target.value || null) as CalendarEvent['recurrence_frequency'])}><option value="">Не повторять</option><option value="daily">Каждый день</option><option value="weekly">Каждую неделю</option><option value="monthly">Каждый месяц</option><option value="yearly">Каждый год</option></select></Field></div>
      {recurrence && <div className="form-grid recurrence-row"><Field label="Интервал"><span className="inline-input"><input type="number" min="1" max="365" value={interval} onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 1))} /><span>{recurrence === 'daily' ? 'дн.' : recurrence === 'weekly' ? 'нед.' : recurrence === 'monthly' ? 'мес.' : 'года'}</span></span></Field><Field label="Повторять до"><input type="date" value={recurrenceUntil} onChange={(e) => setRecurrenceUntil(e.target.value)} /></Field></div>}
      <Field label="Теги"><div className="tag-picker">{tags.map((tag) => <button key={tag.id} type="button" className={`tag-chip ${details.tags.includes(tag.label) ? 'tag-selected' : ''}`} style={{ '--tag-color': tag.color } as React.CSSProperties} onClick={() => updateDetails('tags', details.tags.includes(tag.label) ? details.tags.filter((item) => item !== tag.label) : [...details.tags, tag.label])}>{details.tags.includes(tag.label) && <Check size={12} />}{tag.label}</button>)}<input className="tag-custom-input" value={details.tags.filter((tag) => !tags.some((saved) => saved.label === tag)).join(', ')} onChange={(e) => updateDetails('tags', [...details.tags.filter((tag) => tags.some((saved) => saved.label === tag)), ...e.target.value.split(',').map((tag) => tag.trim()).filter(Boolean)])} placeholder={tags.length ? 'Или свои через запятую' : 'Например: отпуск, сюрприз'} /></div></Field>
      <fieldset className="privacy-fieldset"><legend>Что увидит партнёр?</legend><label className="privacy-option"><input type="radio" name="visibility" checked={visibility === 'full'} onChange={() => setVisibility('full')} /><span><b>Полностью видно</b><small>Название, время и все подробности</small></span><EyeIcon /></label><label className="privacy-option"><input type="radio" name="visibility" checked={visibility === 'busy'} onChange={() => setVisibility('busy')} /><span><b>Только занятое время</b><small>Партнёр видит временной блок</small></span><Clock3 size={17} /></label><label className="privacy-option"><input type="radio" name="visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} /><span><b>Личное</b><small>Событие видно только вам</small></span><Shield size={17} /></label></fieldset>
      <Field label="Сюрприз до даты и времени" hint="До раскрытия партнёр увидит карточку «Сюрприз»."><input type="datetime-local" value={surprise} onChange={(e) => setSurprise(e.target.value)} /></Field>
      <div className="reminders-section"><div className="reminders-header"><b><Bell size={15} /> Напоминания</b><select aria-label="Добавить напоминание" value="" onChange={(e) => { const amount = Number(e.target.value); if (amount && !details.reminders.some((reminder) => reminder.minutes === amount)) updateDetails('reminders', [...details.reminders, { minutes: amount }].sort((a, b) => a.minutes - b.minutes)); }}><option value="">Добавить…</option>{reminderOptions.map((minutes) => <option value={minutes} key={minutes}>{reminderLabel(minutes)} до начала</option>)}</select></div><div className="reminder-chips">{details.reminders.map((reminder, index) => <button type="button" className="tag-chip" key={`${reminder.minutes}-${index}`} onClick={() => updateDetails('reminders', details.reminders.filter((_, i) => i !== index))}><AlarmClock size={13} /> {reminderLabel(reminder.minutes)} <X size={12} /></button>)}{!details.reminders.length && <small>Напоминаний пока нет.</small>}</div></div>
      <p className="fine-print"><Clock3 size={14} /> Время записывается в часовом поясе {event?.timezone ?? timezoneName()}.</p>
      <div className="dialog-actions">{event && <button className="button button-danger-outline" type="button" onClick={() => void remove()} disabled={saving}><Trash2 size={15} /> Удалить</button>}<span className="actions-spacer" /><button className="button button-secondary" type="button" onClick={onClose}>Отмена</button><button className="button button-primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}{event ? 'Сохранить' : 'Создать событие'}</button></div>
    </form>}
  </Dialog>;
}
function EyeIcon() { return <Shield size={17} />; }

function PollsView({ polls, options, votes, userId, tags, onCreate, onVote, onError }: { polls: Poll[]; options: PollOption[]; votes: VoteRow[]; userId: string; tags: TagRow[]; onCreate: (question: string, description: string, options: string[], tags: string[]) => Promise<void>; onVote: (pollId: string, optionId: string) => Promise<void>; onError: (text: string) => void }) {
  const [creating, setCreating] = useState(false); const [busy, setBusy] = useState('');
  async function create(question: string, description: string, choices: string[], pollTags: string[]) { setBusy('new'); try { await onCreate(question, description, choices, pollTags); setCreating(false); } catch (cause) { onError(errorMessage(cause)); } finally { setBusy(''); } }
  async function cast(pollId: string, optionId: string) { setBusy(pollId); try { await onVote(pollId, optionId); } catch (cause) { onError(errorMessage(cause)); } finally { setBusy(''); } }
  return <div className="section-page"><section className="page-intro"><div><span className="eyebrow">РЕШАЙТЕ ВМЕСТЕ</span><h2>Опросы</h2><p>Не можете выбрать дату или план? Предложите варианты и проголосуйте.</p></div><button className="button button-primary" onClick={() => setCreating(true)}><Plus size={17} /> Новый опрос</button></section>
    {!polls.length ? <EmptyState icon={<Vote size={22} />} title="Пока нет опросов" text="Создайте опрос о встрече, времени или идее и выберите общий вариант." action={<button className="button button-primary" onClick={() => setCreating(true)}><Plus size={16} /> Создать опрос</button>} /> : <div className="poll-grid">{polls.map((poll) => {
      const pollChoices = options.filter((option) => option.poll_id === poll.id); const pollVotes = votes.filter((voteRow) => voteRow.poll_id === poll.id); const myVote = pollVotes.find((voteRow) => voteRow.user_id === userId)?.option_id;
      return <article className="poll-card panel" key={poll.id}><div className="poll-card-top"><span className="small-icon lavender"><Vote size={16} /></span><span className="poll-count">{pollVotes.length} {pollVotes.length === 1 ? 'голос' : 'голосов'}</span></div><h3>{poll.question}</h3>{poll.description && <p>{poll.description}</p>}
        {Boolean(poll.tags?.length) && <div className="tag-list">{poll.tags.map((label) => <span key={label} className="tag-chip">{label}</span>)}</div>}
        <div className="poll-options">{pollChoices.map((option) => { const count = pollVotes.filter((voteRow) => voteRow.option_id === option.id).length; const percent = pollVotes.length ? Math.round((count / pollVotes.length) * 100) : 0; return <button className={`poll-option ${myVote === option.id ? 'voted' : ''}`} key={option.id} disabled={busy === poll.id} onClick={() => void cast(poll.id, option.id)}><span className="poll-option-text">{myVote === option.id && <Check size={14} />}{option.label}</span><span className="poll-progress"><i style={{ width: `${percent}%` }} /></span><small>{count} · {percent}%</small></button>; })}</div>
        <small className="poll-footnote">Нажмите на вариант, чтобы проголосовать или изменить голос.</small>
      </article>;
    })}</div>}
    {creating && <PollDialog tags={tags} close={() => setCreating(false)} onCreate={create} busy={busy === 'new'} />}
  </div>;
}
function PollDialog({ tags, close, onCreate, busy }: { tags: TagRow[]; close: () => void; onCreate: (question: string, description: string, choices: string[], tags: string[]) => void; busy: boolean }) {
  const [question, setQuestion] = useState(''); const [description, setDescription] = useState(''); const [choices, setChoices] = useState(''); const [selectedTags, setSelectedTags] = useState<string[]>([]);
  return <Dialog title="Новый опрос" close={close}><form className="stack-form" onSubmit={(event) => { event.preventDefault(); const values = choices.split('\n').map((value) => value.trim()).filter(Boolean); if (values.length < 2) return; onCreate(question.trim(), description.trim(), values, selectedTags); }}><Field label="Вопрос"><input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={180} placeholder="Например, когда увидимся?" required /></Field><Field label="Пояснение"><textarea rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Добавьте детали, если нужно" /></Field><Field label="Варианты — каждый с новой строки" hint="Можно указать даты, время или идеи."><textarea rows={5} value={choices} onChange={(e) => setChoices(e.target.value)} placeholder={'Пятница вечером\nСуббота днём\nВоскресенье'} required /></Field><TagSelector tags={tags} value={selectedTags} onChange={setSelectedTags} /><div className="dialog-actions"><button className="button button-secondary" type="button" onClick={close}>Отмена</button><button className="button button-primary" disabled={busy || choices.split('\n').filter((value) => value.trim()).length < 2}>{busy && <LoaderCircle size={16} className="spin" />} Создать опрос</button></div></form></Dialog>;
}

function TagSelector({ tags, value, onChange }: { tags: TagRow[]; value: string[]; onChange: (next: string[]) => void }) {
  if (!tags.length) return <p className="field-hint"><Tag size={14} /> Пользовательские теги можно добавить в настройках.</p>;
  return <div className="field"><span>Теги</span><div className="tag-picker">{tags.map((tag) => <button type="button" className={`tag-chip ${value.includes(tag.label) ? 'tag-selected' : ''}`} key={tag.id} style={{ '--tag-color': tag.color } as React.CSSProperties} onClick={() => onChange(value.includes(tag.label) ? value.filter((item) => item !== tag.label) : [...value, tag.label])}>{value.includes(tag.label) && <Check size={12} />}{tag.label}</button>)}</div></div>;
}

function IdeasView({ ideas, onSave, onStatus, onDelete, onError }: { ideas: DateIdea[]; onSave: (idea: Partial<DateIdea> & { title: string; description: string; tags: string[] }) => Promise<void>; onStatus: (idea: DateIdea) => Promise<void>; onDelete: (idea: DateIdea) => Promise<void>; onError: (text: string) => void }) {
  const [editing, setEditing] = useState<DateIdea | null | false>(false); const [busy, setBusy] = useState('');
  async function save(idea: Partial<DateIdea> & { title: string; description: string; tags: string[] }) { setBusy('save'); try { await onSave(idea); setEditing(false); } catch (cause) { onError(errorMessage(cause)); } finally { setBusy(''); } }
  async function run(action: () => Promise<void>, id: string) { setBusy(id); try { await action(); } catch (cause) { onError(errorMessage(cause)); } finally { setBusy(''); } }
  const statusName = { idea: 'В списке', chosen: 'Выбрано', done: 'Выполнено' };
  return <div className="section-page"><section className="page-intro"><div><span className="eyebrow">СОБИРАЙТЕ ВДОХНОВЕНИЕ</span><h2>Идеи свиданий</h2><p>Сохраняйте маленькие планы и выбирайте, что попробовать следующим.</p></div><button className="button button-primary" onClick={() => setEditing(null)}><Plus size={17} /> Добавить идею</button></section>
    {!ideas.length ? <EmptyState icon={<Lightbulb size={22} />} title="Идеи только начинаются" text="Сохраните место, занятие или маленький сюрприз на потом." action={<button className="button button-primary" onClick={() => setEditing(null)}><Plus size={16} /> Добавить идею</button>} /> : <div className="ideas-grid">{ideas.map((idea) => <article className={`idea-card panel idea-${idea.status}`} key={idea.id}><div className="idea-card-top"><span className={`idea-status status-${idea.status}`}>{idea.status === 'done' ? <CheckCircle2 size={14} /> : idea.status === 'chosen' ? <Heart size={14} /> : <Lightbulb size={14} />}{statusName[idea.status]}</span><button className="icon-button subtle" aria-label="Редактировать идею" onClick={() => setEditing(idea)}><Pencil size={15} /></button></div><h3>{idea.title}</h3>{idea.description && <p>{idea.description}</p>}{Boolean(idea.tags?.length) && <div className="tag-list">{idea.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}</div>}<div className="idea-actions"><button className="button button-secondary" disabled={busy === idea.id} onClick={() => void run(() => onStatus(idea), idea.id)}>{idea.status === 'idea' ? 'Выбрать' : idea.status === 'chosen' ? 'Отметить сделанным' : 'Вернуть в идеи'}</button><button className="icon-button subtle" aria-label="Удалить идею" disabled={busy === idea.id} onClick={() => void run(() => onDelete(idea), idea.id)}><Trash2 size={15} /></button></div></article>)}</div>}
    {editing !== false && <IdeaDialog idea={editing || null} close={() => setEditing(false)} onSave={save} busy={busy === 'save'} />}
  </div>;
}
function IdeaDialog({ idea, close, onSave, busy }: { idea: DateIdea | null; close: () => void; onSave: (idea: Partial<DateIdea> & { title: string; description: string; tags: string[] }) => void; busy: boolean }) {
  const [title, setTitle] = useState(idea?.title ?? ''); const [description, setDescription] = useState(idea?.description ?? ''); const [tagText, setTagText] = useState(idea?.tags.join(', ') ?? '');
  return <Dialog title={idea ? 'Изменить идею' : 'Новая идея'} close={close}><form className="stack-form" onSubmit={(event) => { event.preventDefault(); onSave({ ...(idea ?? {}), title: title.trim(), description: description.trim(), tags: tagText.split(',').map((tag) => tag.trim()).filter(Boolean) }); }}><Field label="Название"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Например, пикник на закате" required /></Field><Field label="Описание"><textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2500} placeholder="Что понадобится или почему хочется попробовать?" /></Field><Field label="Теги"><input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="Природа, недорого, рядом" /></Field><div className="dialog-actions"><button className="button button-secondary" type="button" onClick={close}>Отмена</button><button className="button button-primary" disabled={busy || !title.trim()}>{busy && <LoaderCircle size={16} className="spin" />}{idea ? 'Сохранить' : 'Добавить идею'}</button></div></form></Dialog>;
}

function SettingsView({ user, profile, partner, avatars, couple, theme, palette, myEventColor, partnerEventColor, onAppearance, onProfile, onAvatar, onInvite, onSignOut, tags, onAddTag, onDeleteTag, importantDates, onAddDate, onDeleteDate, onImport, onExport, events, installPrompt, onInstall, onNotice, vapidPublicKey, openExport, onExportOpened }: {
  user: User; profile?: Profile; partner?: Profile; avatars: Record<string, string>; couple: CoupleInfo; theme: ThemeMode; palette: PaletteId; myEventColor: string | null; partnerEventColor: string | null;
  onAppearance: (theme: ThemeMode, palette: PaletteId, myColor: string | null, partnerColor: string | null) => Promise<void>; onProfile: (name: string) => Promise<void>; onAvatar: (file: File | null) => Promise<void>; openExport: boolean; onExportOpened: () => void;
  onInvite: () => Promise<string>; onSignOut: () => Promise<void>; tags: TagRow[]; onAddTag: (label: string, color: string) => Promise<void>; onDeleteTag: (tag: TagRow) => Promise<void>;
  importantDates: ImportantDate[]; onAddDate: (title: string, date: string, repeats: boolean, reminderDays: number) => Promise<void>; onDeleteDate: (item: ImportantDate) => Promise<void>;
  onImport: (file: File) => Promise<void>; onExport: (from: Date, to: Date, allowed: Visibility[]) => void; events: CalendarEvent[]; installPrompt: boolean; onInstall: () => void; onNotice: (text: string, kind?: 'success' | 'error' | 'info') => void; vapidPublicKey: string;
}) {
  const [displayName, setDisplayName] = useState(profile?.display_name ?? ''); const [profileBusy, setProfileBusy] = useState(false); const [link, setLink] = useState(''); const [inviteBusy, setInviteBusy] = useState(false);
  const [tagName, setTagName] = useState(''); const [tagColor, setTagColor] = useState('#a6e3b0'); const [tagBusy, setTagBusy] = useState(false);
  const [dateDialog, setDateDialog] = useState(false); const [exportDialog, setExportDialog] = useState(false); const [appearanceBusy, setAppearanceBusy] = useState(false); const [reminderPermission, setReminderPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const [pushState, setPushState] = useState<'checking' | 'enabled' | 'disabled' | 'not-saved' | 'unsupported'>('checking'); const [pushBusy, setPushBusy] = useState(false);
  const defaultColors = defaultCalendarColors(theme, palette);
  const [eventColorDraft, setEventColorDraft] = useState({ mine: myEventColor ?? defaultColors[0], partner: partnerEventColor ?? defaultColors[1] });
  useEffect(() => setDisplayName(profile?.display_name ?? ''), [profile?.display_name]);
  useEffect(() => setEventColorDraft({ mine: myEventColor ?? defaultColors[0], partner: partnerEventColor ?? defaultColors[1] }), [theme, palette, myEventColor, partnerEventColor]);
  useEffect(() => { if (openExport) { setExportDialog(true); onExportOpened(); } }, [openExport, onExportOpened]);
  useEffect(() => {
    let live = true;
    const check = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') { setPushState('unsupported'); return; }
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) { if (live) setPushState('unsupported'); return; }
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription) { if (live) setPushState('disabled'); return; }
        const { data, error } = await supabase!.from('push_subscriptions').select('id').eq('user_id', user.id).eq('endpoint', subscription.endpoint).maybeSingle();
        if (error) throw error;
        if (live) setPushState(data ? 'enabled' : 'not-saved');
      } catch { if (live) setPushState('not-saved'); }
    };
    void check(); return () => { live = false; };
  }, [user.id]);
  async function saveName(event: FormEvent) { event.preventDefault(); setProfileBusy(true); try { await onProfile(displayName.trim()); } catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { setProfileBusy(false); } }
  async function saveAppearance(nextTheme: ThemeMode, nextPalette: PaletteId, nextMine = myEventColor, nextPartner = partnerEventColor) {
    if (appearanceBusy) return;
    setAppearanceBusy(true);
    try { await onAppearance(nextTheme, nextPalette, nextMine, nextPartner); }
    catch (cause) { onNotice(`Не удалось сохранить оформление: ${errorMessage(cause)}`, 'error'); }
    finally { setAppearanceBusy(false); }
  }
  async function invite() { setInviteBusy(true); try { const value = await onInvite(); setLink(value); } catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { setInviteBusy(false); } }
  async function saveTag(event: FormEvent) { event.preventDefault(); setTagBusy(true); try { await onAddTag(tagName.trim(), tagColor); setTagName(''); onNotice('Тег добавлен.'); } catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { setTagBusy(false); } }
  async function chooseAvatar(event: React.ChangeEvent<HTMLInputElement>) { try { await onAvatar(event.target.files?.[0] ?? null); } catch (cause) { onNotice(errorMessage(cause), 'error'); } finally { event.target.value = ''; } }
  function pushKeyBytes(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const raw = atob(padded); return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }
  function pushStateChanged(active: boolean) { window.dispatchEvent(new CustomEvent('push-subscription-change', { detail: active })); }
  async function enablePush() {
    if (!supabase) { onNotice('Сначала подключите Supabase.', 'error'); return; }
    if (!vapidPublicKey || vapidPublicKey.includes('PASTE_PUBLIC')) { onNotice('Сначала настройте публичный VAPID-ключ в сборке приложения. См. раздел «Push-уведомления» в инструкции.', 'error'); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') { setPushState('unsupported'); onNotice('Этот браузер не поддерживает Web Push. Установите PWA и попробуйте Chrome на Android или Safari на iPhone.', 'error'); return; }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const installed = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (isIos && !installed) { onNotice('На iPhone сначала добавьте сайт на экран «Домой», затем откройте установленное приложение и включите push.', 'info'); return; }
    setPushBusy(true);
    try {
      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      setReminderPermission(permission);
      if (permission !== 'granted') { setPushState('disabled'); onNotice(permission === 'denied' ? 'Уведомления запрещены. Разрешите их в настройках сайта браузера и повторите.' : 'Чтобы получать push, разрешите уведомления.', 'info'); return; }
      const existingRegistration = await navigator.serviceWorker.getRegistration();
      if (!existingRegistration) throw new Error('Сначала откройте опубликованную версию сайта по HTTPS и дождитесь загрузки приложения.');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(vapidPublicKey) });
      const keys = subscription.toJSON().keys;
      if (!keys?.p256dh || !keys.auth) throw new Error('Браузер не вернул ключи push-подписки. Попробуйте обновить страницу.');
      const { error } = await supabase.from('push_subscriptions').upsert({
        user_id: user.id, endpoint: subscription.endpoint, p256dh: keys.p256dh, auth_secret: keys.auth,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', updated_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' });
      if (error) { await subscription.unsubscribe(); throw error; }
      setPushState('enabled'); pushStateChanged(true); onNotice('Push включён на этом устройстве. Партнёру нужно включить его отдельно.', 'success');
    } catch (cause) { setPushState('not-saved'); onNotice(`Не удалось включить push: ${errorMessage(cause)}`, 'error'); }
    finally { setPushBusy(false); }
  }
  async function disablePush() {
    setPushBusy(true);
    try {
      if (supabase && 'serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.getRegistration(); const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', subscription.endpoint);
          if (error) throw error;
          await subscription.unsubscribe();
        }
      }
      setPushState('disabled'); pushStateChanged(false); onNotice('Push выключен на этом устройстве.', 'info');
    } catch (cause) { onNotice(`Не удалось выключить push: ${errorMessage(cause)}`, 'error'); }
    finally { setPushBusy(false); }
  }
  const uploadInput = useRef<HTMLInputElement>(null); const importInput = useRef<HTMLInputElement>(null);

  return <div className="section-page settings-page"><section className="page-intro"><div><span className="eyebrow">ВАШ ПРОФИЛЬ И ОБЩЕЕ ПРОСТРАНСТВО</span><h2>Настройки</h2><p>Аккаунты, приватность, напоминания и перенос календаря.</p></div><Connection status="online" /></section>
    <div className="settings-grid">
      <section className="settings-card panel profile-settings"><div className="settings-card-heading"><span className="small-icon mint"><Users size={16} /></span><div><h3>Профиль</h3><p>Это имя увидит партнёр в общем календаре.</p></div></div><div className="profile-edit"><Avatar name={accountName(user, profile)} url={profile ? avatars[profile.id] : null} size="large" /><div className="profile-upload-actions"><input ref={uploadInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={chooseAvatar} /><button className="button button-secondary" onClick={() => uploadInput.current?.click()}><Upload size={15} /> Загрузить аватар</button>{profile?.avatar_path && <button className="text-button danger-text" onClick={() => void onAvatar(null).catch((cause) => onNotice(errorMessage(cause), 'error'))}>Удалить</button>}<small>JPG, PNG или WebP · до 5 МБ</small></div></div>
        <form className="settings-inline-form" onSubmit={saveName}><Field label="Имя"><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} placeholder="Ваше имя" /></Field><button className="button button-primary" disabled={profileBusy || !displayName.trim()}>{profileBusy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Сохранить</button></form><p className="account-email">{user.app_metadata?.telegram_login ? 'Аккаунт создан через Telegram' : `Аккаунт: ${user.email}`}</p></section>

      <TelegramLinkCard user={user} onNotice={onNotice} />

      <section className="settings-card panel couple-settings"><div className="settings-card-heading"><span className="small-icon rose"><Heart size={16} /></span><div><h3>Календарь пары</h3><p>{couple.name} · {partner ? 'Вы уже вместе в календаре' : 'Пригласите второго участника'}</p></div></div><div className="partner-row"><div className="pair-avatars"><Avatar name={accountName(user, profile)} url={profile ? avatars[profile.id] : null} /><Avatar name={partner?.display_name || 'Партнёр'} url={partner ? avatars[partner.id] : null} /></div><div><b>{partner?.display_name || 'Место для партнёра'}</b><small>{partner ? 'Участник календаря' : 'У каждого будет свой аккаунт'}</small></div></div>
        {!partner && <><button className="button button-primary" disabled={inviteBusy} onClick={() => void invite()}>{inviteBusy ? <LoaderCircle size={16} className="spin" /> : <Link2 size={16} />} Создать одноразовую ссылку</button><p className="settings-hint"><Shield size={14} /> Ссылка случайная, действует 7 дней и принимается один раз.</p>{link && <div className="invite-result"><label>Отправьте партнёру</label><div className="copy-row"><input readOnly value={link} /><button className="button button-secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); onNotice('Ссылка скопирована.'); } catch { onNotice('Скопируйте ссылку вручную.', 'info'); } }}>Копировать</button></div></div>}</>}
      </section>

      <section className="settings-card panel appearance-settings"><div className="settings-card-heading"><span className="small-icon lavender"><Palette size={16} /></span><div><h3>Оформление</h3><p>Настраивается отдельно для вашего аккаунта и синхронизируется между вашими устройствами.</p></div></div>
        <div className="appearance-group"><b>Режим</b><div className="theme-options">{[{ id: 'dark' as const, label: 'Тёмная', icon: Moon }, { id: 'light' as const, label: 'Светлая', icon: Sun }, { id: 'system' as const, label: 'Системная', icon: Settings2 }].map(({ id, label, icon: Icon }) => <button key={id} disabled={appearanceBusy} className={`theme-option ${theme === id ? 'active' : ''}`} onClick={() => void saveAppearance(id, palette)}><Icon size={17} /><span>{label}</span>{theme === id && <Check size={15} />}</button>)}</div></div>
        <div className="appearance-group"><div className="appearance-group-title"><b>Цветовая палитра</b>{appearanceBusy && <LoaderCircle size={14} className="spin" aria-label="Сохраняем оформление" />}</div><div className="palette-options">{palettes.map((item) => <button type="button" key={item.id} disabled={appearanceBusy} aria-pressed={palette === item.id} className={`palette-option ${palette === item.id ? 'active' : ''}`} onClick={() => void saveAppearance(theme, item.id)}><span className="palette-swatches">{item.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><span>{item.label}</span>{palette === item.id && <Check size={13} />}</button>)}</div></div>
        <div className="appearance-group"><div className="appearance-group-title"><b>Цвета событий</b></div><p className="appearance-copy">Можно выбрать любой оттенок отдельно для себя и партнёра. Выберите оба цвета и сохраните их вместе.</p><div className="event-color-pickers">
          <label className="event-color-picker"><input type="color" aria-label="Цвет моих событий" value={eventColorDraft.mine} disabled={appearanceBusy} onChange={(e) => setEventColorDraft((current) => ({ ...current, mine: e.target.value }))} /><span><b>Мои события</b><small>{eventColorDraft.mine.toUpperCase()}</small></span></label>
          <label className="event-color-picker"><input type="color" aria-label="Цвет событий партнёра" value={eventColorDraft.partner} disabled={appearanceBusy} onChange={(e) => setEventColorDraft((current) => ({ ...current, partner: e.target.value }))} /><span><b>Партнёра</b><small>{eventColorDraft.partner.toUpperCase()}</small></span></label>
        </div><div className="event-color-actions"><button className="button button-primary" disabled={appearanceBusy || (eventColorDraft.mine === (myEventColor ?? defaultColors[0]) && eventColorDraft.partner === (partnerEventColor ?? defaultColors[1]))} onClick={() => void saveAppearance(theme, palette, eventColorDraft.mine, eventColorDraft.partner)}>{appearanceBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Сохранить оба цвета</button><button className="text-button" disabled={appearanceBusy || (!myEventColor && !partnerEventColor)} onClick={() => void saveAppearance(theme, palette, null, null)}>Цвета палитры</button></div></div>
      </section>

      <section className="settings-card panel"><div className="settings-card-heading"><span className="small-icon amber"><Bell size={16} /></span><div><h3>Напоминания</h3><p>Push может приходить, когда приложение закрыто, после настройки Supabase.</p></div></div><div className="permission-row"><span className={`permission-indicator ${reminderPermission === 'granted' ? 'allowed' : ''}`} />Разрешение браузера: {reminderPermission === 'granted' ? 'получено' : reminderPermission === 'denied' ? 'запрещено в настройках сайта' : reminderPermission === 'unsupported' ? 'не поддерживается' : 'не запрашивалось'}</div><div className="permission-row"><span className={`permission-indicator ${pushState === 'enabled' ? 'allowed' : ''}`} />Подписка на этом устройстве: {pushState === 'checking' ? 'проверяем…' : pushState === 'enabled' ? 'включена' : pushState === 'not-saved' ? 'не сохранена в Supabase' : pushState === 'unsupported' ? 'не поддерживается этим браузером' : 'выключена'}</div>{pushState === 'enabled' ? <button className="button button-secondary" disabled={pushBusy} onClick={() => void disablePush()}>{pushBusy ? <LoaderCircle size={15} className="spin" /> : <Bell size={15} />} Выключить push на этом устройстве</button> : <button className="button button-primary" disabled={pushBusy || pushState === 'checking' || pushState === 'unsupported'} onClick={() => void enablePush()}>{pushBusy ? <LoaderCircle size={15} className="spin" /> : <Bell size={15} />} Включить push на этом устройстве</button>}{!vapidPublicKey && <p className="settings-hint">Сборка сайта пока не получила публичный VAPID-ключ. Администратору нужно выполнить шаги из раздела «Push-уведомления» в инструкции.</p>}<p className="settings-hint">Каждый участник включает push на своём телефоне отдельно. Уведомления требуют интернета, разрешения браузера и настроенного Supabase; система может задержать доставку. Простые уведомления только в открытой вкладке продолжают работать без push-подписки.</p></section>

      <section className="settings-card panel tags-settings"><div className="settings-card-heading"><span className="small-icon mint"><Tag size={16} /></span><div><h3>Теги</h3><p>Общие метки для событий, идей и опросов.</p></div></div><form className="tag-add-form" onSubmit={(e) => void saveTag(e)}><input aria-label="Название тега" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="Новый тег" maxLength={32} required /><input type="color" aria-label="Цвет тега" value={tagColor} onChange={(e) => setTagColor(e.target.value)} /><button className="button button-secondary" disabled={tagBusy || !tagName.trim()}><Plus size={15} /> Добавить</button></form><div className="tag-list settings-tag-list">{tags.map((tag) => <span className="tag-chip" key={tag.id} style={{ '--tag-color': tag.color } as React.CSSProperties}><i />{tag.label}<button aria-label={`Удалить тег ${tag.label}`} onClick={() => void onDeleteTag(tag).catch((cause) => onNotice(errorMessage(cause), 'error'))}><X size={12} /></button></span>)}{!tags.length && <small>Добавьте первый тег.</small>}</div></section>

      <section className="settings-card panel dates-settings"><div className="settings-card-heading"><span className="small-icon rose"><CalendarDays size={16} /></span><div><h3>Важные даты</h3><p>Годовщины, дни рождения и другие поводы.</p></div><button className="icon-button" aria-label="Добавить дату" onClick={() => setDateDialog(true)}><Plus size={18} /></button></div><div className="important-date-list">{importantDates.map((item) => <div className="important-date-row" key={item.id}><span className="important-date-icon"><Heart size={15} /></span><span><b>{item.title}</b><small>{formatDate(item.event_date, { day: 'numeric', month: 'long', year: 'numeric' })}{item.repeats_yearly ? ' · каждый год' : ''} · напомнить за {item.reminder_days} дн.</small></span><button className="icon-button subtle" aria-label={`Удалить ${item.title}`} onClick={() => void onDeleteDate(item).catch((cause) => onNotice(errorMessage(cause), 'error'))}><Trash2 size={14} /></button></div>)}{!importantDates.length && <p className="settings-hint">Добавьте дату, которую хочется помнить.</p>}</div></section>

      <section className="settings-card panel transfer-settings"><div className="settings-card-heading"><span className="small-icon lavender"><ArrowDownToLine size={16} /></span><div><h3>Импорт и экспорт</h3><p>Перенос событий через файл .ics для календарей телефона.</p></div></div><div className="transfer-actions"><button className="button button-secondary" onClick={() => importInput.current?.click()}><Upload size={15} /> Импорт .ics</button><input ref={importInput} type="file" accept=".ics,text/calendar" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void onImport(file); e.target.value = ''; }} /><button className="button button-secondary" onClick={() => setExportDialog(true)}><Download size={15} /> Экспорт .ics</button></div><p className="settings-hint">Это перенос файла, а не двусторонняя синхронизация с системным календарём. Личные события партнёра недоступны для экспорта.</p><small>{events.length} событий доступны в вашем аккаунте.</small></section>

      <section className="settings-card panel install-settings"><div className="settings-card-heading"><span className="small-icon mint"><Download size={16} /></span><div><h3>Установка приложения</h3><p>Добавьте «Вместе» на главный экран телефона.</p></div></div>{installPrompt ? <button className="button button-primary" onClick={onInstall}><Download size={15} /> Установить</button> : <div className="install-help"><p><b>Android</b> — откройте меню браузера ⋮ и выберите «Установить приложение» или «Добавить на главный экран».</p><p><b>iPhone</b> — в Safari нажмите «Поделиться» и выберите «На экран Домой».</p></div>}<p className="settings-hint">Без интернета загружается оболочка приложения; просмотр и сохранение данных требуют соединения с Supabase.</p></section>

      <section className="settings-card panel account-settings"><div className="settings-card-heading"><span className="small-icon slate"><Shield size={16} /></span><div><h3>Аккаунт и приватность</h3><p>Доступ к данным контролируют политики Row Level Security.</p></div></div><p className="settings-hint">Приватное событие и его детали читаются только его автором. Для партнёра событие «только занятое время» не отдаёт название или место из базы.</p><button className="button button-danger-outline" onClick={() => void onSignOut()}><LogOut size={15} /> Выйти из аккаунта</button></section>
    </div>
    {dateDialog && <ImportantDateDialog close={() => setDateDialog(false)} onSave={async (...args) => { try { await onAddDate(...args); setDateDialog(false); onNotice('Важная дата добавлена.'); } catch (cause) { onNotice(errorMessage(cause), 'error'); } }} />}
    {exportDialog && <ExportDialog close={() => setExportDialog(false)} onExport={(from, to, allowed) => { onExport(from, to, allowed); setExportDialog(false); }} />}
  </div>;
}

function ImportantDateDialog({ close, onSave }: { close: () => void; onSave: (title: string, date: string, repeats: boolean, reminderDays: number) => Promise<void> }) {
  const [title, setTitle] = useState(''); const [date, setDate] = useState(todayInput()); const [repeat, setRepeat] = useState(true); const [days, setDays] = useState(1); const [busy, setBusy] = useState(false);
  return <Dialog title="Важная дата" close={close}><form className="stack-form" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(title.trim(), date, repeat, days); } finally { setBusy(false); } }}><Field label="Название"><input autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Годовщина знакомства" required /></Field><Field label="Дата"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field><label className="check-row"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /><span>Повторять каждый год</span></label><Field label="Напоминать заранее"><select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[0, 1, 3, 7, 14, 30].map((value) => <option key={value} value={value}>{value === 0 ? 'В день события' : `За ${value} дн.`}</option>)}</select></Field><div className="dialog-actions"><button className="button button-secondary" type="button" onClick={close}>Отмена</button><button className="button button-primary" disabled={busy || !title.trim()}>{busy && <LoaderCircle size={15} className="spin" />} Добавить дату</button></div></form></Dialog>;
}

function ExportDialog({ close, onExport }: { close: () => void; onExport: (from: Date, to: Date, allowed: Visibility[]) => void }) {
  const [from, setFrom] = useState(todayInput()); const defaultEnd = dateInput(new Date(new Date().getFullYear(), new Date().getMonth() + 3, new Date().getDate())); const [to, setTo] = useState(defaultEnd); const [allowed, setAllowed] = useState<Visibility[]>(['full', 'busy', 'private']);
  const options: { value: Visibility; label: string }[] = [{ value: 'full', label: 'События с подробностями' }, { value: 'busy', label: 'Временные блоки' }, { value: 'private', label: 'Мои личные события' }];
  return <Dialog title="Экспорт календаря" close={close}><div className="stack-form"><p>Выберите даты и типы событий. Для партнёра личные события не включаются, даже если отметить этот пункт.</p><div className="form-grid"><Field label="С даты"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="По дату включительно"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div><div className="export-options">{options.map((option) => <label className="check-row" key={option.value}><input type="checkbox" checked={allowed.includes(option.value)} onChange={() => setAllowed(allowed.includes(option.value) ? allowed.filter((item) => item !== option.value) : [...allowed, option.value])} /><span>{option.label}</span></label>)}</div><p className="settings-hint"><Shield size={14} /> Экспорт .ics создаёт копию событий, он не подключает двустороннюю синхронизацию.</p><div className="dialog-actions"><button className="button button-secondary" onClick={close}>Отмена</button><button className="button button-primary" disabled={new Date(`${to}T23:59:59`) < new Date(`${from}T00:00:00`)} onClick={() => onExport(new Date(`${from}T00:00:00`), new Date(`${to}T23:59:59`), allowed)}><Download size={15} /> Скачать .ics</button></div></div></Dialog>;
}

interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>; }

export default App;

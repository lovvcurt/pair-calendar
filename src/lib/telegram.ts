type TelegramThemeParams = {
  bg_color?: string;
  header_bg_color?: string;
};

type TelegramWebApp = {
  /** Raw signed launch data. The server verifies this; never trust initDataUnsafe. */
  initData: string;
  colorScheme: 'light' | 'dark';
  viewportHeight: number;
  viewportStableHeight?: number;
  themeParams: TelegramThemeParams;
  ready: () => void;
  expand: () => void;
  onEvent: (event: 'viewportChanged' | 'themeChanged', callback: () => void) => void;
  offEvent: (event: 'viewportChanged' | 'themeChanged', callback: () => void) => void;
};

type TelegramLoginResult = { id_token?: string; error?: string };
type TelegramLoginOptions = { client_id: number; scope: string[]; lang: string; nonce: string };
type TelegramLoginSdk = { auth: (options: TelegramLoginOptions, callback: (result: TelegramLoginResult) => void) => void };

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp; Login?: TelegramLoginSdk };
  }
}

let loginSdkPromise: Promise<void> | null = null;

/** Load Telegram's official web login SDK only when the web sign-in screen needs it. */
export function loadTelegramLoginSdk(): Promise<void> {
  if (window.Telegram?.Login?.auth) return Promise.resolve();
  if (loginSdkPromise) return loginSdkPromise;

  loginSdkPromise = new Promise<void>((resolve, reject) => {
    let script = document.getElementById('telegram-login-sdk') as HTMLScriptElement | null;
    const isNewScript = !script;
    if (!script) {
      script = document.createElement('script');
      script.id = 'telegram-login-sdk';
      script.src = 'https://oauth.telegram.org/js/telegram-login.js?3';
      script.async = true;
    }
    const finish = () => {
      if (window.Telegram?.Login?.auth) { script!.dataset.loaded = 'true'; resolve(); }
      else { script!.remove(); reject(new Error('Не удалось загрузить окно входа Telegram. Проверьте интернет и попробуйте снова.')); }
    };
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => { script!.remove(); reject(new Error('Не удалось загрузить окно входа Telegram. Проверьте интернет и попробуйте снова.')); }, { once: true });
    if (script.dataset.loaded === 'true') finish();
    else if (isNewScript) document.head.appendChild(script);
  }).catch((error) => {
    loginSdkPromise = null;
    throw error;
  });
  return loginSdkPromise;
}

/** Open Telegram's official popup. Call directly from a button click so browsers allow the popup. */
export function openTelegramLogin(clientId: string, nonce: string): Promise<string> {
  const sdk = window.Telegram?.Login;
  const parsedClientId = Number(clientId);
  if (!sdk?.auth || !Number.isSafeInteger(parsedClientId) || parsedClientId <= 0) {
    return Promise.reject(new Error('Вход через Telegram на сайте ещё не настроен.'));
  }
  return new Promise((resolve, reject) => {
    sdk.auth({ client_id: parsedClientId, scope: ['profile'], lang: 'ru', nonce }, (result) => {
      if (result.error) reject(new Error('Telegram не подтвердил вход. Закройте окно и попробуйте снова.'));
      else if (typeof result.id_token !== 'string' || !result.id_token) reject(new Error('Telegram не вернул подтверждение входа. Попробуйте ещё раз.'));
      else resolve(result.id_token);
    });
  });
}

/** Initialize optional Telegram Web App behavior without using Telegram identity data. */
export function initializeTelegramMiniApp(): void {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return;

  webApp.ready();
  webApp.expand();
  document.documentElement.dataset.telegramMiniApp = 'true';

  const updateViewport = () => {
    const height = webApp.viewportStableHeight || webApp.viewportHeight;
    if (Number.isFinite(height) && height > 0) {
      document.documentElement.style.setProperty('--telegram-viewport-height', `${Math.round(height)}px`);
    }
  };
  const updateThemeColor = () => {
    const color = webApp.themeParams.header_bg_color || webApp.themeParams.bg_color;
    if (!color || !/^#[\da-f]{6}$/i.test(color)) return;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  };

  updateViewport();
  updateThemeColor();
  webApp.onEvent('viewportChanged', updateViewport);
  webApp.onEvent('themeChanged', updateThemeColor);
}

/** Telegram's signed launch string, or null when this page was opened elsewhere. */
export function getTelegramInitData(): string | null {
  const value = window.Telegram?.WebApp?.initData?.trim();
  return value || null;
}

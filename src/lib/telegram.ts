type TelegramThemeParams = {
  bg_color?: string;
  header_bg_color?: string;
};

type TelegramWebApp = {
  colorScheme: 'light' | 'dark';
  viewportHeight: number;
  viewportStableHeight?: number;
  themeParams: TelegramThemeParams;
  ready: () => void;
  expand: () => void;
  onEvent: (event: 'viewportChanged' | 'themeChanged', callback: () => void) => void;
  offEvent: (event: 'viewportChanged' | 'themeChanged', callback: () => void) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
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

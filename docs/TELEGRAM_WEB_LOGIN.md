# Вход через Telegram на обычном сайте

Эта настройка добавляет вход и регистрацию Telegram на сайте, открытом в обычном браузере. Вход по email и паролю продолжит работать. Mini App использует тот же аккаунт Telegram и ту же привязку.

Если календарь уже создан под email, сначала войдите в него обычным способом, откройте **Ещё → Настройки → Вход через Telegram** и нажмите **Привязать Telegram**. Если начать с кнопки Telegram до привязки, появится отдельный аккаунт без старого календаря. Система не объединяет аккаунты по совпадению имени или почты.

## Что понадобится

- Опубликованный HTTPS-адрес приложения на GitHub Pages.
- Telegram-бот, созданный через **@BotFather**.
- Настроенный проект Supabase.
- Доступ владельца к проекту Supabase и репозиторию GitHub.

Если вход из Telegram Mini App уже работает, пропустите этот раздел: таблица привязок и общий секрет уже настроены. Если Telegram ещё не подключали, откройте Supabase **SQL Editor → New query** и выполните целиком `supabase/migrations/20260929000002_telegram_auth.sql`. Затем создайте случайный секрет в PowerShell:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Сохраните строку в менеджере паролей. Позже добавьте её в **Supabase → Edge Functions → Secrets** как `TELEGRAM_AUTH_SECRET`.

## 1. Включите вход сайта в @BotFather

1. Откройте официальный **@BotFather** в Telegram и выберите бота приложения.
2. Откройте **Login Widget**.
3. Добавьте адрес сайта в **Allowed URLs**. Например, для `https://lovvcurt.github.io/pair-calendar/` укажите origin `https://lovvcurt.github.io` — без `/pair-calendar/` и завершающего `/`.
4. Скопируйте выданный **Client ID** в менеджер паролей. **Client Secret** сохраните там же, но не публикуйте и не отправляйте в чат. Эта интеграция использует официальный Telegram Login SDK и проверяет подписанный ID token, поэтому Client Secret не добавляется в код или настройки приложения.

В дополнительных настройках Login Widget оставьте алгоритм подписи **RS256** (значение по умолчанию).

Если вы используете собственный домен, добавьте его origin, например `https://calendar.example.com`. При смене домена добавьте новый адрес в Allowed URLs и обновите список origin в Supabase.

## 2. Добавьте Client ID в сборку сайта

Для опубликованного сайта откройте репозиторий GitHub → **Settings → Secrets and variables → Actions → Variables → New repository variable**. Добавьте:

| Имя | Значение |
| --- | --- |
| `VITE_TELEGRAM_LOGIN_CLIENT_ID` | Client ID, показанный @BotFather |

Это публичный идентификатор приложения Telegram, он попадёт в браузерную сборку. **Client Secret**, токен Telegram-бота и ключ `service_role` сюда не добавляйте.

Чтобы проверить с компьютера, добавьте в `.env` строку:

```ini
VITE_TELEGRAM_LOGIN_CLIENT_ID=ВАШ_CLIENT_ID
```

После изменения `.env` перезапустите `npm run dev`. Для локального входа origin `http://localhost:5173` также должен быть разрешён у Telegram и в Supabase; если Telegram не принимает локальный адрес, сначала опубликуйте сайт на HTTPS.

## 3. Добавьте Client ID в Supabase

В Supabase Dashboard откройте проект → **Edge Functions → Secrets** и добавьте или проверьте значения:

| Имя | Значение |
| --- | --- |
| `TELEGRAM_LOGIN_CLIENT_ID` | Тот же Client ID из @BotFather |
| `TELEGRAM_APP_ORIGINS` | Origin опубликованного сайта, например `https://lovvcurt.github.io` |
| `TELEGRAM_AUTH_SECRET` | Случайная строка из предыдущего раздела; уже добавлена, если Mini App вход работает |

Client ID нужен серверу для проверки, что подписанный Telegram token выдан именно вашему боту. В `TELEGRAM_APP_ORIGINS` укажите origin опубликованного сайта, например `https://lovvcurt.github.io`. Для GitHub Pages URL с путём репозитория указывается только домен-источник, без пути. Если нужен также Mini App вход, добавьте origin локального запуска и секрет `TELEGRAM_BOT_TOKEN` по инструкции [TELEGRAM_MINI_APP.md](TELEGRAM_MINI_APP.md).

`TELEGRAM_BOT_TOKEN` нужен Mini App и не требуется обычному сайту. `TELEGRAM_AUTH_SECRET` нужен общей серверной функции. Если Mini App уже работает, оставьте эти значения без изменений. Никакие секретные значения не вставляйте в GitHub, `.env`, код сайта или чат.

## 4. Опубликуйте функцию и сайт

Откройте PowerShell в папке проекта. Выполните команды по одной. В `ВАШ_PROJECT_REF` укажите только короткий код проекта из URL Supabase перед `.supabase.co`:

```powershell
npx supabase login
npx supabase link --project-ref ВАШ_PROJECT_REF
npx supabase functions deploy telegram-auth --no-verify-jwt
```

Затем отправьте изменения проекта в GitHub и дождитесь зелёного запуска **Actions → Deploy PWA to GitHub Pages**. Если вы тестируете локально, обновите страницу после перезапуска Vite.

## 5. Вход и привязка

- **Новый пользователь:** на сайте нажмите **Продолжить через Telegram**, подтвердите вход в окне Telegram — Supabase создаст аккаунт и откроет календарь. Telegram не передаёт приложению email; для такого аккаунта используется технический адрес, который не принимает письма. Восстановить его по почте нельзя, поэтому не теряйте доступ к Telegram.
- **Уже есть календарь:** войдите через email и пароль, откройте **Ещё → Настройки → Вход через Telegram → Привязать Telegram** и подтвердите вход в Telegram. После этого кнопка входа на сайте и в Mini App будет открывать тот же календарь.
- Если Telegram уже связан с другим аккаунтом, привязка остановится. Сначала войдите в тот аккаунт, где находятся нужные данные.

## Если кнопка не работает

- **«Вход через Telegram не настроен»** — проверьте GitHub Variable `VITE_TELEGRAM_LOGIN_CLIENT_ID`, сохраните, отправьте изменения и дождитесь новой сборки Actions.
- **«TELEGRAM_LOGIN_CLIENT_ID не настроен»** — добавьте этот секрет в Supabase **Edge Functions → Secrets** и повторно разверните `telegram-auth`.
- **Адрес не разрешён / окно входа не открывается** — проверьте **Allowed URLs** у выбранного бота и секрет `TELEGRAM_APP_ORIGINS`. Используйте origin без пути репозитория.
- **«Не удалось проверить подпись» или ошибка аудитории** — убедитесь, что один и тот же Client ID указан у @BotFather, в GitHub Variable и в Supabase Secret.
- **Открывается пустой календарь** — вероятно, создан новый аккаунт Telegram. Выйдите, войдите в старый аккаунт по email и привяжите к нему Telegram из настроек.

Официальные инструкции Telegram: [Login with Telegram](https://core.telegram.org/bots/telegram-login), [Allowed URLs и Client ID](https://core.telegram.org/bots/telegram-login#registering-your-allowed-urls), [проверка ID token](https://core.telegram.org/bots/telegram-login#validating-id-tokens).

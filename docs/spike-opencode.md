# Спайк: допущения A1–A10

Окружение спайка: `opencode` v2.2.0 (глобально, npm), Bun 1.4.4, **Docker недоступен**. Всё, что требует контейнеров, модели или живой сессии, помечено как не подтверждённое.

Статусы: `подтверждено` — проверено командой здесь; `не подтверждено` — проверка не выполнена или не дала результата; `запасной вариант` — выбран альтернативный путь из плана.

## A1
Команда запуска: `opencode serve --hostname 127.0.0.1 --port 4197`.
Результат: сервер поднимается и пишет `server listening on http://127.0.0.1:4197`. Флаги `--hostname` и `--port` из `opencode serve --help`.
Не проверено: привязка к `0.0.0.0` внутри контейнера, healthcheck.
Статус: частично подтверждено (запуск — да; контейнер — не проверено).

## A2
Плагин в v2 — Effect-based API. Из `@opencode/plugin@2.2.0` (`dist/effect/plugin.d.ts`): `Plugin.define({ id, effect: (ctx) => Effect })`, где `ctx` содержит `tool`, `permission`, `session`, `event` и др.
Это расходится с предположением плана (`Plugin.define({id})` с `setup`). Загрузка через `plugins:[{package: ...}]` в `opencode.json` не проверена.
Статус: не подтверждено (API прочитан по типам, загрузка не проверена).

## A3
Не проверено: нужна живая сессия с моделью, чтобы получить pending permission.
Статус: не подтверждено.

## A4
Не проверено: нужен `PATCH` session permissions на живой сессии.
Статус: не подтверждено.

## A5
Не проверено: нужна модель, которая попытается вызвать встроенный `shell`.
Статус: не подтверждено.

## A6
`ssh2` устанавливается и резолвится под Bun (`require.resolve` возвращает путь, `@opencode/client` импортируется через `import()`). Exec через jump-цепочку и `hostVerifier` не проверены — это тесты T9.
Статус: не подтверждено (зависимость установлена; поведение не проверено).

## A7
Сервер требует аутентификацию: без пароля отвечает 401 `UnauthorizedError`, заголовок `www-authenticate: Basic realm="Secure Area"`.
Пароль задаётся через `OPENCODE_SERVER_PASSWORD` (имя взято из бинарника, `OPENCODE_PASSWORD` имеет приоритет).
Проверено и не сработало (все 401): `Basic` с логином `opencode`, с пустым логином, с логином `admin`; `Bearer <пароль>`; `?auth_token=<пароль>`.
Формат проверки пароля в бинарнике не разобран до конца (проверка идёт через `Redacted`-обёртку).
Статус: запасной вариант не выбран — нужно решить, как передавать пароль клиенту (вероятно, через ключ, который выдаёт сам сервер, либо отключить аутентификацию для internal-сети). Блокирует T15.

## A8
Не проверено: нужен работающий SSE `/api/event` с активной сессией.
Статус: не подтверждено.

## A9
Тип `AssertInput` из `@opencode/plugin@2.2.0` (`dist/permission.d.ts`) содержит поля `sessionID`, `agent?`, `action`, `resources`, `save?`, `metadata?`, `source?` с `source = {type: "tool", messageID, id}`. Полная форма из плана совпадает.
Runtime (что pending-запрос появляется в `/api/session/{id}/permission`) не проверен.
Статус: подтверждено по типам; runtime не подтверждён.

## A10
`typeof Bun.YAML?.parse` в Bun 1.4.4 → `function`. Типы `Bun.YAML` есть в bun-types, `tsc --noEmit` проходит.
Статус: подтверждено.

## Итог
Подтверждено: A10, A9 (по типам), A1 (частично).
Блокер: A7 — нужно решение по аутентификации клиента.
Не проверено без Docker и модели: A2 (загрузка), A3, A4, A5, A6 (exec), A8.
Перед Wave 2 закрыть A7; перед T28b — все остальные.

## Rev3

### A7 (authMode)
Команда: `env -u OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD=s1pass opencode serve --hostname 127.0.0.1 --port 4305`.
Результат: без заголовка `GET /api/info` → 401; с `authorization: Basic base64("opencode:s1pass")` → 200.
Важно: если в окружении задан `OPENCODE_PASSWORD`, он имеет приоритет и заголовок с другим паролем даёт 401; в процесс его надо убрать (`env -u`).
Функция заголовка: `headers2` в `@opencode/client@2.2.0` → `Basic base64(username:password)`, совпадает с `authHeaders` в `apps/server/src/opencode.ts:12-14`.
Статус: подтверждено, `authMode=basic`.

### A2 (форма плагина)
Типы: `@opencode/plugin@2.2.0` содержат и promise-форму `{id, setup}` (`dist/promise/plugin.d.ts`), и effect-форму `{id, effect}`.
Проверено через API (`opencode serve`, сессия создана через `POST /api/session` с `location.directory`):
- `GET /api/config` видит `plugins` из `<infra>/opencode.json` (конфиг парсится);
- `GET /api/plugin` → `data: []` во всех вариантах: `package` = путь к файлу `dist/index.js`; `package` = каталог с `package.json` (`main: index.js`);
- в `serve.log` с `--log-level debug` нет строк про плагин и нет ошибок загрузки.
Документация (`opencode.ai/v2/docs/plugins`, `/v2/docs/build/plugins`):
- локальный путь в `plugins` должен быть **каталогом**; одиночный файл пропускается;
- форма `{ id, async setup(ctx) }` из `@opencode/plugin` — та же, что в примере доки, A2 по форме закрыт;
- без `exports` в каталоге ищется `server`/`index` в корне.

Проверено маркер-файлом (тестовый плагин пишет `MARKER` в `setup`), `opencode serve` + сессия в `location`:
- `plugins: ["file://<dir>"]`, каталог с `package.json` (`exports`) → маркера нет;
- `plugins: [{package: "<dir>"}]` без `exports` → маркера нет;
- авто-обнаружение `.opencode/plugins/probe.js` без `plugins` → маркера нет;
- то же после `git init` каталога проекта → маркера нет (projectID стал `global`).
- `opencode plugin list` (и с `--builtin`) → «No plugins found».
### A2: итог (подтверждено)
Причины, по которым всё не грузилось раньше:
1. Локация (каталог проекта) грузит плагины лениво: при создании сессии `setup` не вызывается. Нужен запрос с каталогом, например `GET /api/plugin`. Без него в логе `loading plugin` нет.
2. Каталог-плагин без `exports` берёт файл `index` в **корне** каталога; `main` в `package.json` не используется.
3. Рабочая форма (как в доке): `package.json` с `"exports": { ".": "./src/index.ts" }`, в `opencode.json` строка `"file://<каталог>"`.

Проверено: `packages/plugin` (реальный репо, после правки `exports`): `loading plugin` = 1, тесты и typecheck зелёные. Форма `{ id, async setup(ctx) }` из `@opencode/plugin` совпадает с доком.
Статус: подтверждено. Для продакшена в контейнере `PLUGIN_PATH` должен быть **каталогом** (`/app/packages/plugin`), а не `dist/index.js`.

### BIN
Команда: `command -v opencode` → `readlink -f`.
Результат: нативный ELF-бинарь `…/@opencode/cli/bin/opencode.exe` (~246 MB), не node-скрипт. Node в рантайм-образ не нужен.
Статус: подтверждено.

### INSTALL
Образ: стейдж `node:22-slim` с `npm install -g @opencode/cli@2.2.0`, в рантайм копируется только `/usr/local/lib/node_modules/@opencode/cli/bin/opencode.exe` в `/usr/local/bin/opencode`. Обе базы debian, glibc совпадает.
Статус: запасной вариант: образ не собирался (D1). Проверка `docker compose run … opencode --version` — владелец (П1).

### POLICY
Не проверено: применение `policies` из `<infra>/opencode.json` к сессии в подкаталоге не запускалось (нужна сессия с моделью для `tool.use`).
Статус: не подтверждено.

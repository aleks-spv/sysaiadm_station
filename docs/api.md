# SysAiAdm Station API

Публичный REST API. Тот же набор маршрутов, что использует веб-интерфейс: `/api/*`.

## Аутентификация

Два способа:

- **Cookie-сессия** администратора (пароль + TOTP через `/api/auth/login`). Мутации требуют заголовка `X-Requested-With: sysadm`. Все scope'ы доступны.
- **Bearer-токен**: `Authorization: Bearer sat_…`. Заголовок имеет приоритет над cookie: если он передан, cookie игнорируется. Заголовок `X-Requested-With` для токенов не нужен.

Токен создаётся и отзывается только в UI («Настройки → API-токены») под сессией администратора. Токен не может выпустить другой токен. Значение токена показывается один раз, в базе хранится только его sha256. Срок действия по умолчанию 90 дней, максимум 365. MCP-сервера нет.

## Scope'ы

| scope | что разрешает |
|---|---|
| `read` | чтение инвентаря, задач, аудита, событий, метаданных кредов, провайдеров и моделей, `system/health` |
| `tasks` | создать задачу, отправить промпт, остановить задачу |
| `approve` | ответить на запрос разрешения: только `once` или `reject` |
| `logs` | логи в памяти (`system/logs`) |
| `admin` | все мутации инвентаря, скиллов, кредов, импорта; ключ провайдера; перезапуск opencode |

`always` в ответе на запрос разрешения и включение autopilot доступны только cookie-сессии. Для токена они дают 403.

Правило по умолчанию: любой маршрут без записи в таблице для токена возвращает 403.

## Маршруты

| Метод | Путь | scope |
|---|---|---|
| GET | `/api/tree` | read |
| GET | `/api/nodes/:id` | read |
| POST | `/api/nodes` | admin |
| PATCH | `/api/nodes/:id` | admin |
| DELETE | `/api/nodes/:id` (`?recursive=1` — with the subtree and its tasks) | admin |
| POST | `/api/nodes/:id/move` | admin |
| POST | `/api/nodes/:id/reset-hostkey` | admin |
| PUT | `/api/nodes/:id/skills` | admin |
| GET | `/api/skills` | read |
| POST | `/api/skills` | admin |
| PUT | `/api/skills/:id` | admin |
| DELETE | `/api/skills/:id` | admin |
| POST | `/api/skills/:id/reset` | admin |
| GET | `/api/tasks` | read |
| GET | `/api/tasks/:id` | read |
| GET | `/api/tasks/:id/permissions` | read |
| POST | `/api/nodes/:id/tasks` | tasks |
| POST | `/api/tasks/:id/prompt` | tasks |
| POST | `/api/tasks/:id/stop` | tasks |
| POST | `/api/tasks/:id/permissions/:requestID` | approve |
| GET | `/api/audit` | read |
| GET | `/api/events` | read |
| GET | `/api/credentials` | read (только метаданные: id, name, type, createdAt) |
| POST | `/api/credentials` | admin |
| PUT | `/api/credentials/:id` | admin |
| DELETE | `/api/credentials/:id` | admin |
| POST | `/api/import/preview` | admin |
| POST | `/api/import/apply` | admin |
| GET | `/api/settings/providers` | read |
| POST | `/api/settings/providers/:id/key` | admin |
| GET | `/api/settings/disabled-providers` | read |
| PUT | `/api/settings/disabled-providers` | admin |
| GET | `/api/settings/models` | read |
| GET | `/api/system/health` | read |
| GET | `/api/system/logs` | logs |
| POST | `/api/system/opencode/restart` | admin |
| GET | `/api/system/opencode/version` | read |
| POST | `/api/system/opencode/upgrade` | admin |
| GET | `/api/tasks/:id/forms` | read |
| GET | `/api/tasks/:id/pins` | read |
| PUT | `/api/tasks/:id/pins/:messageId` | tasks |
| DELETE | `/api/tasks/:id/pins/:messageId` | tasks |
| POST | `/api/tasks/:id/forms/:formID/reply` | approve |
| POST | `/api/tasks/:id/forms/:formID/cancel` | approve |
| GET | `/api/settings/websearch` | read |
| PUT | `/api/settings/websearch` | admin |
| POST | `/api/settings/websearch/test` | admin |
| POST | `/api/inventory/export` | admin |
| POST | `/api/inventory/import` | admin |
| GET | `/api/backups` | admin |
| PUT | `/api/backups/settings` | admin |
| POST | `/api/backups` | admin |
| GET | `/api/backups/:name` | admin |
| DELETE | `/api/backups/:name` | admin |

Вопросы агента (инструмент question, в opencode V2 это «формы»): `GET .../forms` отдаёт ожидающие, ответ — `{answer: {ключ поля: строка | число | boolean | список строк}}`. Пока вопрос ждёт, задача в статусе `waiting_permission`.

Экспорт: `POST /api/inventory/export` с `{rootId: string|null, withSecrets: boolean, passphrase: string}` (пароль не короче 12 символов) отдаёт файл `.sysaiadm`: JSON-конверт, тело зашифровано AES-256-GCM ключом из scrypt(пароль). Импорт: multipart `file`, `passphrase`, `parentId?`. Обновление opencode (`POST .../upgrade`) идёт в фоне и отвечает 202; состояние смотреть через `GET .../version` (`busy`).

Вне таблицы: `GET /api/health` (без токена, отдаёт только `{"ok": true}` или 503), `/api/auth/*` (вход), `/api/tokens*` (только cookie-сессия).

## Ответы и коды ошибок

- `401` — нет или неверный токен, либо неверная cookie-сессия.
- `403` — токен не имеет нужного scope, маршрут вне таблицы, или `/api/tokens*` с токеном. Также: `always` или autopilot с токеном, либо мутация без `X-Requested-With` при cookie.
- `404` — не найден объект или маршрут (cookie-сессия на незарегистрированный путь).
- `413` — тело больше лимита (1 MiB, для импорта 5 MiB).
- `429` — больше 20 неудачных Bearer-попыток с одного IP за 15 минут.

## Примеры

Здоровье с деталями (scope `read`):

```sh
curl -s -H "Authorization: Bearer $SYSADM_TOKEN" https://sysadm.example/api/system/health
```

Создать задачу (scope `tasks`):

```sh
curl -s -X POST -H "Authorization: Bearer $SYSADM_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"uptime","prompt":"выполни uptime"}' \
  https://sysadm.example/api/nodes/<node-id>/tasks
```

Ответить на запрос разрешения `once` (scope `approve`):

```sh
curl -s -X POST -H "Authorization: Bearer $SYSADM_TOKEN" -H "Content-Type: application/json" \
  -d '{"decision":"once"}' \
  https://sysadm.example/api/tasks/<task-id>/permissions/<request-id>
```

## Версии

Версионирования (`/api/v1`) нет. Ломающие изменения появятся с новым префиксом, а не с заменой текущих путей.

# Плагины

Плагин даёт агентам инструменты одной системы (CRM, почта, склад), свои таблицы и события. Методики работы с системой — не часть плагина: их собирают скиллом (`skills/<имя>/` → `pnpm skills:pack` → файл `.skill`) и загружают в админке, в «Скиллах», где выбирают, кому скилл доступен. Он лежит в `plugins/<имя>/` и подключается агенту строкой в `plugins` его паспорта. Пример со всеми частями — `plugins/example-notes/`.

## Устройство папки

```text
plugins/<имя>/
├─ plugin.ts          паспорт: definePlugin({ ... })
├─ plugin.test.ts     тесты рядом с кодом
└─ migrations/        свои таблицы: 0001_<что>.sql, …  (схема plugin_<имя>)
```

Плагин берёт из ядра только открытые части: `core/plugins/public/` и для тестов `core/testing/public/`. Импорт чего-то ещё из `core/` остановит `pnpm lint` (проверка границ `tooling/architecture`).

## Паспорт

```ts
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { definePlugin, pluginSchemaName, requireUserId } from '../../core/plugins/public/index.ts';

export default definePlugin({
  name: 'warehouse',                 // имя папки и ключ в config/plugins.ts
  title: 'Склад',                    // так система называется в интерфейсе: «Ищу в «Склад»…»
  settings: z.object({ baseUrl: z.url() }),   // проверяется при запуске по config/plugins.ts
  secrets: ['WAREHOUSE_TOKEN'],       // переменные .env; без них запуск остановится с APP_CONFIG_INVALID
  readOnly: ['stock_find'],           // только чтение: без «Да»; всё остальное ждёт подтверждения
  tools: ({ settings, secrets, db }) => ({
    stock_find: createTool({ id: 'stock_find', description: 'Найти остаток товара по названию.', inputSchema: z.object({ q: z.string() }), execute: async ({ q }, context) => { /* … */ } }),
    order_create: createTool({ /* меняет данные в системе — сотрудник подтвердит «Да» */ }),
  }),
});
```

- **Подтверждения ядро добавляет само.** Каждый инструмент вне `readOnly` выполняется только после «Да» сотрудника (в чате или на экране «Ждёт подтверждения») и пишется в журнал действий. Объявлять «только чтение» можно лишь то, что ничего не меняет.
- **От чьего имени.** `requireUserId(context)` даёт сотрудника, от которого идёт запуск. Данные храните и ищите по нему: агент видит ровно то, что видит этот человек.
- **Имена инструментов** уникальны среди плагинов агента. Имена блоков ядра (`show_table`, `show_chart`, `show_card`, `ask_choice`, `ask_form`) заняты.
- **Таблица в чате без перепечатывания.** Если результат инструмента — `{ table: { title?, columns: [{ key, label }], rows: [...] } }` (до 500 строк), чат рисует таблицу прямо из результата; модель не тратит токены на перепечатку.
- **Ошибки.** Бросайте ошибку с понятным текстом; ядро вернёт её модели, а сотрудник увидит «Действие «…» не выполнилось». Секреты в ошибки и результаты не попадают.

## Свои таблицы

`migrations/*.sql` выполняются при запуске по порядку имени, каждая в своей транзакции; применённую миграцию не меняют — добавляют новую. Схема — `pluginSchemaName('<имя>')`, то есть `plugin_<имя>` (дефисы → подчёркивания). Ссылка на сотрудника — `app."user"("id")` с `ON DELETE CASCADE`: при удалении сотрудника его данные уходят вместе с ним.

## Подключение по MCP с личным доступом

Если у системы есть MCP-сервер, плагин описывает подключение вместо своих инструментов:

```ts
connection: { mode: 'personal', auth: 'oauth' },   // или 'static' (личный ключ), или mode: 'shared' + auth: 'identity'
mcp: ({ settings, secrets }) => ({
  url: settings.mcpUrl,
  oauth: { authorizeUrl, tokenUrl, clientId: secrets.CRM_CLIENT_ID, clientSecret: secrets.CRM_CLIENT_SECRET, scopes: ['crm'] },
}),
```

- `personal` + `oauth` — каждый сотрудник входит на сайте системы в «Настройках → Подключения»; токен хранится зашифрованным и обновляется сам. Приложение в системе заводится один раз, адрес возврата — `APP_PUBLIC_URL` + `/app/api/connections/oauth/callback` (один на все подключения); секрет приложения уходит в теле запроса (`client_secret_post`).
- `personal` + `static` — сотрудник вводит свой ключ (`staticFields`); `headers(credential)` превращает его в заголовки запроса.
- `shared` + `identity` — одно подключение установки; ядро подписывает в каждом запросе, кто спрашивает (`identitySecret`).
- Нет личного подключения — агент получает инструмент, который отвечает «подключите систему в настройках», а сотрудник видит ссылку туда.

## События

`triggers: (ctx) => [{ start, stop }]` — источник событий (опрос ящика заявок, очередь вебхуков). На событие вызовите `ctx.startAgentRun({ agentId, userId, prompt, title })`: агент работает без чата от имени сотрудника, в своём разговоре, с его доступами и лимитом; действия ждут «Да» на экране «Ждёт подтверждения». Отмечайте событие обработанным только после того, как `startAgentRun` завершился, — тогда перезапуск ничего не потеряет.

## Тесты

Тесты лежат рядом (`plugin.test.ts`) и запускаются общим `pnpm test`.

```ts
import { createPool, createTestDatabase, migrate, toolContextFor } from '../../core/testing/public/index.ts';
// своя пустая база: createTestDatabase(); миграции плагина: migrate(url, undefined, [{ prefix: 'plugin:<имя>', dir }]);
// вызов инструмента от имени сотрудника: tool.execute(input, toolContextFor('u1'))
```

Настоящие ключи систем в тестах не нужны: внешние сервисы заменяются тестовыми серверами (см. `core/connections/test/`), модель — заглушкой.

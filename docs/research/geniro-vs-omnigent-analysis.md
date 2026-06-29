# Geniro vs Omnigent — анализ для переписывания (geniro-app)

> Цель: переписать Geniro как **локальное macOS-приложение**, которое
> авто-обновляется, само поднимает БД/серверы, и позволяет строить **граф
> агентов-команды**, где агенты подключаются **только через CLI** (старт: Claude,
> Cursor по подписке, Cursor по API-токену — по образцу Omnigent).
>
> Источники: свежие клоны `github.com/geniro-io/geniro` и
> `github.com/omnigent-ai/omnigent`. Все цитаты — `file:line` в этих клонах.
> Документ собран из многоагентного исследования (9 ридеров + синтез) и
> добивки (4 ридера) по состоянию на 2026-06-29.

---

## 0. Главный вывод (одной фразой)

**У Geniro есть то, чего нет у Omnigent — настоящий движок графа.** У Omnigent
есть то, что у Geniro слабее — зрелый **общий слой CLI-агентов** + локальная
инфраструктура (single-binary демон, SQLite, авто-обновление). Новое приложение
= **поженить движок графа Geniro с CLI-слоем Omnigent** в тонкой Electron-оболочке
над локальным демоном.

---

## 1. Что такое Geniro сегодня

Открытая серверная платформа для построения и запуска **графов AI-агентов**
(`geniro/README.md:7`). Цикл: **Define → Compile → Run → Observe**
(`README.md:34-37`).

**Стек:** TypeScript/Node 24, **NestJS 11 на Fastify**, рантайм агентов на
**LangGraph + LangChain**, **Postgres+pgvector** через MikroORM, Qdrant (вектора),
Redis+BullMQ (очереди), фронт **React 19 + Vite + `@xyflow/react`** (канвас графа).
Монорепо pnpm+Turborepo: `apps/api`, `apps/web`, `packages/*`. Деплой —
`docker compose up` или Helm.

**Движок графа реальный и сильный:**
- Граф = JSONB `{nodes, edges}` (`graph.entity.ts:21`); узел `{id, template, config}`,
  ребро `{from, to, label?}` — **без payload**, инвертированная зависимость
  (`edge.from` зависит от `edge.to`, `graph-compiler.ts:594`).
- Виды узлов: `runtime, tool, simpleAgent, claudeAgent, trigger, resource, mcp,
  instruction` (`graphs.types.ts:11-20`).
- `GraphCompiler.compile()` (`graph-compiler.ts:235`): валидация схемы → топосорт
  (Kahn, бросает на циклах) → инстанцирование узлов из шаблонов → проводка
  tools→agents и nodes→runtimes по рёбрам → резолв секретов в env → регистрация
  живого `CompiledGraph` в process-singleton `GraphRegistry`.
- Ревизии event-sourced (`fast-json-patch`), **горячее применение к живому графу**
  (`applyLiveUpdate`, `graph-revision.service.ts:794`) — пересобираются только
  затронутые узлы.

**Агенты:** `BaseAgent` (`base-agent.ts:103`) — карта инструментов, `EventEmitter`,
`buildLLM()` → `ChatOpenAI` на LiteLLM, абстрактный `run()`. Два типа:
- **SimpleAgent** — LangGraph-машина (summarize → invoke_llm → tools → guard, явные
  `FinishTool`/`WaitForTool`).
- **ClaudeAgent** — гоняет Claude Code через Anthropic Agent SDK **внутри
  sandbox-рантайма** по newline-JSON stdio-мосту (`packages/claude-bridge`).

**Мульти-агентность** = синхронные tool-вызовы, не шина: `subagents-tool` плодит
детей, `agent-communication-tool` шлёт сообщения соседям через `runOrAppend`
(`agent-communication-tool.template.ts:123-161`).

**Модель доступа к LLM:** всё через **LiteLLM** (OpenAI-совместимый прокси), а
**CLIProxyAPI** (`cliproxy.yaml`) даёт OAuth-шим, чтобы гонять по **подписке
Claude** без API-ключа (`README.md:314-345`) — паттерн полезен для consumer-Mac.

### Что взять / что выбросить при переписывании

| Взять (портировать) | Выбросить / заменить |
|---|---|
| Схема `{nodes,edges}` + `GraphCompiler` (топосорт) + `GraphRegistry` | NestJS DI + process-singleton связность |
| Канвас React Flow + ELK из `apps/web` (zustand/immer/react-query/zod) | Postgres + MikroORM + JSONB-ревизии → **SQLite** |
| Реестр шаблонов с правилами соединений; `applyLiveUpdate` (hot-reload) | Keycloak/Zitadel auth (локально — single-user) |
| `packages/claude-bridge` stdio-JSON протокол | Docker/K8s/Daytona рантаймы → **локальный subprocess** |
| Синхронные tool-комуникации агентов; `Finish`/`Wait` контракт завершения | LiteLLM как хард-зависимость → опциональный локальный прокси |
| Персоны: `system-agents/*.md`, `instruction-blocks/*.md` | BullMQ/Redis, Qdrant, WS-фан-аут → локальная шина событий |

---

## 2. Что такое Omnigent

Databricks, Apache-2.0, v0.3.0, Python ≥3.12 — *«open-source meta-harness для всех
твоих AI-агентов»*. Регистрирует уже установленные CLI-агенты (Claude Code, Codex,
Cursor, OpenCode, Goose, Qwen, Kimi, Copilot, Antigravity, Hermes, Pi), даёт писать
агентов коротким YAML, заставляет их супервизить друг друга, и ведёт одну живую
сессию через terminal → browser → phone → нативный macOS-апп.

**Архитектура — 3 Python-процесса + JS-фронт, всё локально:**
- **Server** — FastAPI (`server/app.py`, `create_app`), отдаёт `/v1` (sessions,
  hosts, runner_tunnel, terminal_attach, policies, mcp_servers) и встроенный
  web-UI на `:6767`. Auth/OIDC, реестр хостов, MCP-пул, presence.
- **Host** — зарегистрированная машина. `host/connect.py` (`HostProcess`) поднимает
  **Runner**-subprocess и коннектится к серверу (опц. через WS-туннель).
- **Runner** — свой FastAPI (`runner/app.py`): *«владеет harness-подпроцессами»*.
  Резолвит тип харнесса и spawn-env из спеки, диспатчит tools, гейтит политики,
  считает стоимость.
- **Runtime + harnesses** — исполнение на агента. `runtime/workflow.py` — цикл
  одного агента (load → prompt → LLM → tools → repeat, durable-checkpoint).
- **Frontend / Electron** — React-UI, встроенный в сервер; macOS-апп оборачивает
  тот же UI в нативное окно.

Состояние — в `~/.omnigent/` (`chat.db` SQLite, `config.yaml`, `agents/`, `daemons/`).

---

## 3. ЯДРО — общий слой CLI-агентов (то, ради чего всё)

### 3.1 Один контракт = класс `Executor`

`omnigent/inner/executor.py:518`. Главный метод:
`async run_turn(messages, tools, system_prompt, config) -> AsyncIterator[ExecutorEvent]`
плюс флаги-возможности: `supports_streaming`, `supports_tool_calling`,
`handles_tools_internally`, `supports_live_message_queue`, `interrupt_session`,
`enqueue_session_message`, `close_session`. **Любой агент = реализация `Executor`.**

### 3.2 Одна нормализованная событийная модель («один API»)

`server/schemas.py` — `ServerStreamEvent` (`:3669`), Pydantic discriminated union:
- `session.*` lifecycle: `SessionStatusEvent` (idle/launching/running/waiting/failed),
  `SessionUsageEvent`, `SessionModelEvent`, `SessionChildSessionUpdatedEvent`, …
- `response.*` (форма OpenAI Responses API): `OutputTextDeltaEvent`,
  `ReasoningTextDeltaEvent`, `OutputItemDoneEvent`, `ElicitationRequestEvent`
  (карточки апрува), `Turn*`/`Compaction*`.

Персистентная таксономия — `entities/conversation.py`, `ITEM_TYPE_TO_DATA_CLS`:
`MessageData, FunctionCallData, FunctionCallOutputData, ReasoningData,
CompactionData, NativeToolData, ResourceEventData, RoutingDecisionData,
SlashCommandData, TerminalCommandData, ErrorData`. **Любой гетерогенный вывод CLI
сводится в этот фиксированный набор** → UI и слой политик агенто-агностичны.

### 3.3 Два стиля интеграции на агента

`harness_aliases.py` чётко делит:
- **headless / SDK** (`claude-sdk`, `cursor` (SDK), `codex`, `qwen`, `kimi`,
  `copilot`, `antigravity`, `openai-agents`, `pi`, `goose`, `hermes`) — гоняют
  агента и нормализуют в свою модель.
- **native** (`NATIVE_HARNESSES`: `claude-native`, `cursor-native`, `codex-native`,
  `opencode-native`, `goose-native`, …) — поднимают **настоящий вендорский TUI** в
  терминале, печатают в живой процесс и зеркалят транскрипт назад.

Реестр «модуль на агента» — `native_coding_agents.py`: dataclass `NativeCodingAgent`
(`key, display_name, agent_name, harness, wrapper_label, terminal_name`) +
lookup-карты по harness/name/wrapper/terminal.

### 3.4 Паттерн файлов на агента (переиспользуемый шаблон)

Для каждого агента — `<agent>_native_*.py` с фиксированным разделением:
- **`_bridge.py`** — точка инъекции + ввод **web→agent**. Владеет per-session
  uid-scoped bridge-директорией c `bridge.json` (bearer-токен, session id,
  workspace, model), строит launch-аргументы / MCP-конфиг / hook-настройки.
  (Claude: `prepare_bridge_dir`, `build_mcp_config`, `build_hook_settings`,
  `augment_claude_args`; Cursor: `inject_user_message` через tmux bracketed paste.)
- **`_forwarder.py`** — вывод **agent→web**. Долгоживущий async-цикл, тейлит родной
  вывод агента и POST-ит нормализованные `external_*` события на
  `/v1/sessions/{id}/events`. **Источник тейла различается по агенту**, схема — одна.
- **`_hook.py`** — управление (subprocess). Агент вызывает его как ребёнка на
  lifecycle-событиях; читает hook-JSON из stdin, роутит
  `permission-request`/`ask-user-question`/`evaluate-policy` на сервер.
- **`_state.py`** — durable per-conversation состояние под `~/.omnigent/` (не `/tmp`),
  id хешируется `sha256(conv_id)[:32]` (защита от traversal).
- **`_permissions.py`** — зеркалирование TUI-подтверждений для агентов **без
  хук-системы** (Cursor, Goose): тейлит состояние, ловит pending-апрув, POST-ит на
  сервер, ждёт web-вердикт, затем **бьёт по TUI нажатиями** (`y`/`Escape`).

### 3.5 Инъекция «по сильнейшему доступному каналу»

| Агент | Канал инъекции |
|---|---|
| **Claude Code** | CLI-флаги: `--mcp-config` (Omnigent MCP stdio) + `--settings` (hooks: SessionStart/Stop/UserPromptSubmit/Pre/PostToolUse/PermissionRequest/MessageDisplay → `python -m omnigent.claude_native_hook`); негибкие гейты пред-засеяны в `~/.claude.json` |
| **Codex** | TOML `--config` overrides → `mcp_servers.omnigent` (тот же serve-mcp) + JSON-RPC app-server по Unix-socket |
| **OpenCode** | синтезированный `opencode.json` с инжектнутым плагином `omnigent-policy.js` + HTTP REST для ввода ходов |
| **Cursor / Goose** | **никакого API** — tmux: `load-buffer`/`paste-buffer`+Enter для ввода; `_permissions.py` скрейпит и бьёт по TUI |

### 3.6 Процессная и транспортная модель

- **Один subprocess на разговор**: `HarnessProcessManager` (`process_manager.py`)
  лениво спавнит `python -m omnigent.runtime.harnesses._runner --socket <path>`,
  общается по **per-conversation Unix-socket**, idle-reaper + orphan-sweep.
- **Executor-адаптер** (`_executor_adapter.py`, `HarnessApp`): транслирует
  `CreateResponseRequest` → inner messages, а inner `ExecutorEvent` → типизованные
  Omnigent SSE через `TurnContext.emit` (**точка нормализации**).
- **`NativeServerHarness` + `NativeServerTransport`** (`send_prompt`/`abort`) — общая
  тонкая база для native-server агентов (codex-native = WS JSON-RPC,
  opencode-native = HTTP+SSE).
- **Терминальный мост** (`terminals/ws_bridge.py`, `bridge_tmux_pty_to_websocket`):
  форкает `tmux attach` на PTY ↔ WebSocket. Бинарные кадры = сырые нажатия, текст =
  JSON-контрол (`resize`→`ioctl TIOCSWINSZ`); коалесинг до 64KiB, но 2KiB сразу
  после нажатия для отзывчивого эха; различает detach (4405) и exit (4404).

### 3.7 Мульти-агентность сегодня — НЕ граф

`runtime/workflow.py` — цикл **одного** агента. Мульти-агент = **рекурсивное дерево
sub-agent'ов, вызываемых как tools** (`AgentSpec.sub_agents`, `workflow.py:2220`),
каждый ребёнок — отдельная child-session (`session.child_session.updated`,
`tool_dispatch.py:768`). **DAG, явных рёбер, fan-in/join, условного роутинга —
НЕТ.** Это ключевой пробел, который закрывает движок графа Geniro.

---

## 4. Авто-обновление (требование пользователя #1)

- **Продукт = Python-пакет.** 3 синхронных PyPI-вилы (`omnigent`, `omnigent-client`,
  `omnigent-ui-sdk`), `==`-пины (`RELEASING.md:3-15`). Установка `uv tool install` /
  `pip` / `pipx`. **Homebrew нет.**
- `omni upgrade` (`cli.py:3601-3748`) НЕ несёт своего апдейтера — определяет форму
  установки и делегирует пользовательскому установщику (`uv tool upgrade` /
  `pip install -U` / `pipx upgrade`). Перед сменой кода: drain → stop сервера, после
  — ленивый респавн (читает версию в свежем subprocess).
- **Детект «отстал на N версий»** (`update_check.py`): dev-clone → `git rev-list`
  count; installed-wheel → Simple Repository API того же индекса, из которого ставят
  (резолв: `OMNIGENT_INDEX_URL`→`UV_*`→`PIP_INDEX_URL`→`uv.toml`/`pip.conf`→pypi).
  Кэш 4ч, фон-рефреш, нотис раз на релиз.
- **Electron сам себя НЕ обновляет.** В `web/electron` нет electron-updater /
  autoUpdater / feed (`package.json` без `build.publish`). Оболочка тонкая: грузит
  **SPA, отдаваемую сервером** (`README.md:71-82`), и **спавнит внешний `omnigent`
  CLI с PATH**, Python не встраивает. Значит: **UI обновляется бесплатно** вместе с
  бэкендом; бинарь оболочки — только пере-скачкой `.dmg`.
- **Версии НЕ залочены** между оболочкой и бэком, runtime-handshake нет (выписано в
  out-of-scope). Внутренний трюк: `server_config_signature()` вшивает версию пакета
  → после апгрейда сигнатура не совпадает → сервер сам респавнится на новом коде;
  состояние переживает в `chat.db`.

**Вывод для нового приложения:** расцепить оболочку и движок — демон обновляется
своим пакетным менеджером, оболочка тонкая и грузит served-SPA, версия в сигнатуре
для горячего цикла; для true in-app-update оболочки — добавить electron-updater +
подписанный feed (то, что Omnigent сознательно опустил).

---

## 5. Авто-запуск БД/сервера локально (требование пользователя #2)

- **БД = SQLite `~/.omnigent/chat.db`** (`local_server.py:591-599`), переопределяемо
  `OMNIGENT_DATABASE_URI` (Postgres опционален). Миграции — **Alembic, автоматически
  при первом обращении** (`db/utils.py:292-489`): свежая БД → `upgrade head` +
  `create_all(checkfirst)`; отстала → авто-апгрейд. 43 миграции. SQLite в WAL +
  busy_timeout — чтобы REPL+сервер+раннер делили один файл.
- **Сервер** — `subprocess.Popen([... "server", "--host","127.0.0.1","--port",6767,
  "--database-uri", uri], start_new_session=True)` — **detached**, переживает выход
  CLI. Предпочтительный порт **6767**, фолбэк на свободный. Обнаружение — через
  **pidfile `~/.omnigent/local_server.pid`** (pid+port), здоровье — `GET /health`.
  Сигнатура-сайдкар: смена auth/версии → респавн.
- **Демон владеет жизненным циклом сервера** (`_daemon_entry.py --local`); раннеры —
  **по требованию** через WS-туннель со scrubbed-env allowlist (секреты шелла не
  утекают).
- **Auth локально:** бутстрап одного admin на loopback, session-JWT в
  `~/.omnigent/auth_tokens.json`, **ре-минт на каждый запуск** (порт может меняться),
  шлётся как `Bearer`. Пароль не генерируется.
- **launchd НЕТ.** Только detached-subprocess + pidfile-reuse. Переживает выход CLI,
  **но не перезагрузку** — следующий запуск просто респавнит. (Это поправка: ранний
  синтез ошибочно предположил launchd-резидентность.)

---

## 6. macOS-оболочка (Electron)

- **Тонкая оболочка**, грузит origin сервера по сети (`win.loadURL`), бандлит лишь
  `setup/index.html`. `contextIsolation:true`, `nodeIntegration:false`, preload c
  двумя замороженными `contextBridge`-мирами (`window.omnigentDesktop` /
  `omnigentSetup`).
- `server_manager.js` **шеллит в установленный CLI** (не бандлит Python): резолв
  `settings.omnigent_path` → PATH (`command -v`) → well-known dirs (GUI-запуск даёт
  бедный PATH). **Reuse-or-spawn c владением:** health-проба (pidfile+PID-liveness+
  `/health`); своё помечает `owned`, чужое **адаптирует, не дублирует/не убивает**;
  на `before-quit` SIGTERM→SIGKILL только своим.
- **Порт/токен — с диска** (pidfile + `auth_tokens.json` по URL), без env-handshake;
  ждёт stdout-маркер `"✓ Connected"` с таймаутом.
- **Trust-boundary = pinned origin:** проверка sender-фрейма на каждом IPC, гейт
  OS-возможностей на pinned origin, **нативный consent-диалог** для host-enrollment
  (страница не подделает).
- **Упаковка:** electron-builder, `hardenedRuntime`, Developer ID
  (`Databricks, Inc.`), provisioning profile (для Touch-ID keychain-группы),
  entitlements (JIT + mic), минимальный inherit-plist для хелперов, `notarize` на
  release, **DMG** (`${productName}-${version}-${arch}.dmg`, фон, иконка+/Applications).

---

## 7. Чертёж нового приложения (черновой)

```
Electron shell (main)                         ← тонкая, net-new
  • спавн+супервизия локального демона
  • (опц.) electron-updater (latest.yml) — гейтит оболочку+демон
  • грузит served React-UI
        │ loopback HTTP/WS + token
Renderer (React)            Local daemon (Node/TS)        ← движок = Geniro
  • React Flow + ELK          ┌ Graph engine: {nodes,edges} DAG,
    канвас (из Geniro)        │   GraphCompiler+топосорт, Registry, applyLiveUpdate
  • xterm-зеркало TUI         ├ Agent-adapter layer (на агента):  ← паттерн = Omnigent
    (из Omnigent ws_bridge)   │   bridge/forwarder/hook/state/permissions
  • карточки апрувов          │   • 1 subprocess/узел, нормализованные события
                             ├ SQLite + миграции; in-proc шина; policy/cost
                             └ seatbelt-песочница (опц.)
        │ spawn + inject
   Claude CLI            Cursor CLI (subscription)      Cursor SDK (API token)
   (flags+MCP+hooks)     (tmux paste + TUI-drive)       (cursor-sdk, CURSOR_API_KEY)
```

### 7.1 Минимальный интерфейс «модуля агента» (определить ПЕРВЫМ)

```ts
interface CliAgentModule {
  id: string;                                  // "claude" | "cursor"
  resolveSpawn(ctx: NodeContext): SpawnPlan;   // bin, args, cwd, env, model, credential

  // INJECT (web→agent): сильнейший доступный канал
  inject(ctx, plan): InjectedLaunch;           // augmented args/config | tmux-инжектор
  sendUserMessage(s, text): Promise<void>;
  interrupt(s): Promise<void>;
  shutdown(s): Promise<void>;

  // OUTPUT (agent→web): тейлить родной источник, эмитить ОДНУ схему
  startForwarder(s, emit): Disposable;

  // GOVERNANCE: всё на единый policy-эндпоинт (hook | TUI-mirror)
  onPermissionRequest?(req): Promise<PolicyVerdict>;

  // STATE: durable, hashed conv-id под app-support
  loadState(convId): AgentState | null;
  saveState(convId, s): void;
}
```
+ **один словарь событий** (lifecycle: `session.status/usage/model/child`; content:
`output_text.delta`, `reasoning.delta`, `output_item.done`, `elicitation.request`)
+ **один governance-эндпоинт** (`evaluatePolicy` с fail-closed на tool-calls,
fail-open на prompts).

Порядок: **Claude** (богатейшая инъекция) → **Cursor (подписка, TUI)** → **Cursor
(API, SDK)** — последние два доказывают обе нетривиальные ветки.

### 7.2 Что откуда брать

| Слой | Источник |
|---|---|
| Схема графа, компилятор, топосорт, реестр, hot-reload | **Geniro** |
| Канвас React Flow + ELK, паттерны клиента | **Geniro** `apps/web` |
| Синхронные tool-комуникации + Finish/Wait | **Geniro** |
| Персоны system-agents/instruction-blocks | **Geniro** |
| Форма адаптера CLI (bridge/forwarder/hook/state/permissions) | **Omnigent** |
| Нормализованная событийная схема + единый policy-эндпоинт | **Omnigent** `schemas.py` |
| 1 subprocess/узел + UDS + idle-reaper/orphan-sweep | **Omnigent** `process_manager.py` |
| Терминальное зеркало (xterm↔tmux PTY↔WS) | **Omnigent** `ws_bridge.py` |
| SQLite + миграции + `~/.app/`-лейаут; pidfile-резидентность | **Omnigent** |
| stdio JSON-line мост (альтернатива subprocess+UDS) | **Geniro** `claude-bridge` |
| Electron-оболочка, spawn, sign/notarize/DMG, update-feed | **Net-new** (форма от Omnigent.app) |
| **Движок графа НАД CLI-агентами** | **Net-new** — то, чего нет ни у кого |

### 7.3 Самое трудное / риски

1. **Граф над CLI-агентами — новизна.** У Omnigent — дерево sub-agent'ов как tools,
   у Geniro — DAG но над LangGraph/SDK, не над произвольными CLI. Склейка компилятора
   Geniro с per-node харнессами Omnigent + реальные fan-in/join — главное изобретение.
2. **Общий CLI-слой гетерогенен по природе.** Cursor/Goose без хуков → хрупкий
   TUI-скрейп + нажатия (ломается при смене вендорского TUI).
3. **Языковая граница.** Адаптеры Omnigent — Python; Geniro — TypeScript.
   **Развилка:** портировать адаптеры в TS (один язык, чистый Electron) **или** гонять
   Python-sidecar (переиспользовать код Omnigent, но версионить+спавнить Python в
   Electron). Гейтит всё остальное.
4. **Вынуть движок Geniro из NestJS DI** (GraphRegistry, scoped-агенты, EventEmitter2).
5. **Версионная связка оболочка↔демон + подписанное авто-обновление.**
6. **Хрупкость TUI-зеркала + корректность seatbelt-песочницы на macOS.**

---

## 8. Открытые вопросы к планированию

1. **Язык адаптерного слоя — TS-порт или Python-sidecar?** Главная развилка.
2. **Cursor — подтверждено:** подписка = native-TUI (tmux, `~/.cursor`, без ключа),
   API-токен = SDK-харнесс (`cursor-sdk`, `CURSOR_API_KEY`). Это два разных кода —
   надо ли v1 поддерживать оба сразу?
3. **Авто-обновление оболочки:** как у Omnigent (тонкая, served-SPA, бэк через uv/pip)
   или полноценный electron-updater + подписанный feed?
4. **Семантика графа в v1:** чистый DAG fan-out, или условный роутинг + join + циклы?
5. **Как рёбра графа маппятся в коммуникации агентов** — модель Geniro
   (`runOrAppend`) или child_sessions+inbox Omnigent?
6. **Единый стор:** одна SQLite-схема под граф+ревизии Geniro И conversation/items
   Omnigent — или два стора?
7. **Песочница на узел** по умолчанию или opt-in?
8. **Роутинг модели/кредов:** локальный LiteLLM/CLIProxy для OAuth-подписки или
   прямые вызовы CLI/провайдеров? (consumer-Mac хочет подписку без ключа.)
9. **Авто-старт демона:** detached+pidfile (как Omnigent) или всё-таки launchd для
   переживания перезагрузки?

---

### Приложение — карта проверенных файлов

**Geniro:** `graph-compiler.ts:235`, `graph.entity.ts:21`, `graphs.types.ts:11-20`,
`base-agent.ts:103`, `simple-agent.ts:249`, `claude-agent.ts:154`,
`packages/claude-bridge/bridge.ts:230`, `agent-communication-tool.template.ts:123`,
`graph-revision.service.ts:794`.

**Omnigent:** `inner/executor.py:518`, `server/schemas.py:3669`,
`entities/conversation.py:583/682`, `native_coding_agents.py`, `harness_aliases.py`,
`native_server_harness.py:45`, `native_server_transport.py`,
`runtime/harnesses/process_manager.py:578`, `runtime/harnesses/_executor_adapter.py`,
`runtime/session_stream.py`, `runtime/workflow.py:2220`, `runner/routing.py:88`,
`claude_native_bridge.py:1279/993/1024`, `claude_native_hook.py:83`,
`cursor_native.py:147`, `cursor_native_bridge.py:668`, `cursor_native_permissions.py:423`,
`cursor_native_usage.py`, `inner/cursor_executor.py:478`, `inner/cursor_harness.py`,
`terminals/ws_bridge.py:455`, `host/local_server.py:437/579/591`,
`host/_daemon_entry.py:56`, `host/connect.py:734`, `db/utils.py:292-489`,
`server/accounts_bootstrap.py:184`, `update_check.py`, `cli.py:3601-3748`,
`web/electron/src/main.js:1941`, `web/electron/src/server_manager.js:129/365`,
`web/electron/package.json:23-99`.

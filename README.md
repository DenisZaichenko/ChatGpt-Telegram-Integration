# Codex Telegram Remote

A private Telegram remote for local Codex App chats, with a mobile Mini App for browsing conversations, sending prompts, managing queues, and reviewing changes. The bot uses long polling and starts its own `codex app-server` over stdio. The optional Mini App listens on localhost behind an HTTPS tunnel or reverse proxy.

## Requirements

- Node.js 22+
- a working local Codex installation under the same non-admin macOS user as Codex App
- one private Telegram bot and one numeric Telegram user id
- company approval to send repository-derived text through Telegram

Telegram bot chats are **not end-to-end encrypted**. Existing Codex App chats can be listed and read after they are persisted. Only turns started by this service have guaranteed live streaming, approval, steering, and interruption through the bot. Desktop-owned turns remain controlled by the app; messages for them are passed through its native queue on the supported modern build.

The desktop app can hold a chat's writer even while idle. On the verified modern build, an `already has an active writer` refusal routes the prompt to Codex's native `thread/queue/add` queue. The desktop app watches this queue and executes the prompt in the original chat; it must stay running. The Mini App can view, edit, reorder, and cancel these entries until the app consumes them. Those turns use the desktop app's model, permissions, and approval UI, not the bot's full-access setting. No writer lock is stolen and no duplicate chat is created. Legacy builds report the conflict and preserve the draft instead. Definitive failures before submission permit retry; uncertain delivery still remains protected against automatic replay.

## Setup

```sh
pnpm install
pnpm build
pnpm hash-pairing 'generate-a-long-random-one-time-code'
```

Copy `config.example.toml`, then set owner-only secret environment values (for example in a `0600` launch-agent environment file):

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=123456789
PAIRING_SECRET_HASH=$argon2id$...
CONFIG_FILE=/absolute/path/to/config.toml
```

Environment values override TOML. `PROJECT_ROOTS` are explicit projects. `PROJECT_PARENT_DIRS` permit read-only direct-child discovery and allow existing chats only within their canonical boundaries. Symlinks are resolved before access checks.

Run `pnpm doctor`, then `pnpm start`. In the authorized private Telegram chat, send `/pair <the-original-one-time-code>`. The code message is deleted where Telegram permits and cannot be reused.

For custom providers that need environment secrets, name only the required variables in `CODEX_CHILD_ENV_ALLOWLIST`. The service otherwise passes a minimal environment plus the same `CODEX_HOME`; it never stores provider credentials. Codex App/ChatGPT login and keychain access are inherited from the same OS user.

## Commands

`/app`, `/projects`, `/project`, `/chats [all]`, `/queue [all]`, `/find`, `/use`, `/new`, `/where`, `/history`, `/status`, `/stop`, `/steer`, `/diff`, `/fullaccess on|off`, and `/help` are implemented. Plain text starts a turn, or queues the next turn when the selected chat is busy.

## Telegram Mini App

The Mini App uses the same service and queue as the bot. It provides project filters, search, favorites, unread/running indicators, conversation history (last 50 turns), prompt submission, queue editing/reordering/cancellation, recovery actions, and diff downloads. The UI refreshes every four seconds while visible. Approvals and full-access controls remain available in the bot conversation.

Messages render sanitized Markdown (headings, lists, tables, code and links), without avatars. Wide tables and code scroll horizontally inside the message. Raw HTML is displayed as text, remote images are not loaded, and structured question replies show the question and answer instead of internal JSON. Tapping outside an editor dismisses the mobile keyboard; the compact prompt composer keeps its draft.

In landscape windows at least 560px wide, the chat title and tabs share one 44px toolbar. Project details move to the title tooltip, and the running status uses a small dot. Portrait layout and scrollbar positioning are unchanged.

On the single-pane mobile layout, swipe right to return to the chat list without losing a draft. Gestures on inputs, buttons, links, code blocks and tables are excluded, so horizontal content scrolling remains available.

The Changes tab reads the latest turn with applied file changes from persisted chat history, including turns run by the desktop app before the bot connected. It skips newer conversation-only turns and pages older history when needed. Historical downloads contain the recorded edits in execution order (including repeated edits to a file), not the repository's current net Git diff. Failed, declined and pending file changes are excluded. A captured live aggregate is used when available for that same turn. Download links are scoped to the selected chat and turn and work without a bot-side diff cache.

Diffs are displayed in collapsible file cards with old/new line numbers, addition/deletion counts, file status and themed line highlighting. Repeated edits to a file stay in ordered steps inside its card. The wrap toggle switches between wrapped lines and horizontal code scrolling. Cards load their line views when opened; previews are limited to 1,200 rows per file, while the `.diff` download remains complete.

Each queued entry has **Отправить сейчас**. For the bot's queue, this starts the selected entry when capacity is available, or steers a bot-owned active turn without stopping it. For Codex's native queue it starts the original entry by ID, without copying its text. If the desktop app holds the writer lock, immediate start must be done in that app; the Mini App reports the limitation and leaves the entry untouched. Uncertain local deliveries cannot be replayed with this button.

For a temporary public URL, install `cloudflared` and add this to the private environment file:

```text
MINI_APP_TUNNEL_BIN=/opt/homebrew/bin/cloudflared
MINI_APP_PORT=8787
```

Restart the service when no bot-owned turn is active. The service starts the local HTTP server and a Cloudflare quick tunnel, then registers the new HTTPS URL in the authorized user's Telegram menu. Tap **Open / Открыть** or send `/app`. The Mac must stay awake and online. Quick-tunnel URLs change on restart; use the current menu button instead of an old link. Cloudflare terminates HTTPS and carries Mini App traffic.

For a stable deployment, omit `MINI_APP_TUNNEL_BIN`, provide `MINI_APP_URL=https://your-domain.example` (an origin with no path), and proxy it to `127.0.0.1:8787`. With neither variable set, the service opens no HTTP port. Never point a tunnel at another local service.

API calls require Telegram-signed `initData`, the configured numeric user id, and completed bot pairing. Launch data expires after one hour; reopen the Mini App to renew it. No bot token or authentication bypass is shipped to the browser. Submission ids are persisted so a network retry cannot silently submit the same prompt twice. If delivery is uncertain, check history before creating a new prompt.

While a turn runs, progress is streamed with Bot API `sendMessageDraft` (Bot API 10.0+) rather than posted as messages. A draft is an ephemeral 30-second preview that leaves nothing in history, so a turn persists exactly one message: the final answer. Drafts are re-sent every 20 seconds to outlive that window during quiet stretches, and updates are throttled to at most one per 1.5 seconds. Only the newest chunk is previewed when output exceeds one message; the final message carries the whole body. If the Bot API rejects drafts with `404`, the service falls back for the rest of the process to the previous behaviour — one progress message, edited in place.

Approval prompts offer `Allow once`, `Allow for session` for the current Codex session, and a confirmed per-chat `Enable full access` mode. Full access applies to future Telegram-started turns, uses Codex `dangerFullAccess` with approval policy `never`, and therefore grants the agent the same filesystem and network reach as the macOS user. Use `/fullaccess off` to return future turns to workspace-write with approvals. Managed Codex policy remains authoritative and can reject the requested mode.

## Service installation

Copy and edit `launchd/run-service.sh.example`, keeping its referenced environment file mode `0600`. Edit the plist with absolute paths, copy it into `~/Library/LaunchAgents`, ensure configuration/log directories are mode `0700`, then load it with `launchctl bootstrap gui/$(id -u) ...`. The launch agent runs as the logged-in user and keeps the service alive without placing tokens in process arguments or the plist.

## Development

The version-matched app-server TypeScript schema is in `generated/` and can be refreshed with `pnpm generate:protocol`. Tests use fakes and never access the developer's real Codex store.

Tested Codex versions: `>=0.145.0 <0.146.0` for legacy history, and the ChatGPT App bundled `0.166.0-alpha.6` for paginated history. Recent chats require the latter: set `codex_bin` to `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`. The newer client reads `thread/turns/list` and resumes with `excludeTurns: true`, following the [App Server protocol](https://learn.chatgpt.com/docs/app-server). Other versions fail closed until their protocol is verified. Regenerate the schema and update contract tests before widening support.

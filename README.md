# Codex Telegram Remote

A private, long-polling Telegram remote for local Codex App chats. It opens no inbound port and starts its own `codex app-server` over stdio.

## Requirements

- Node.js 22+
- a working local Codex installation under the same non-admin macOS user as Codex App
- one private Telegram bot and one numeric Telegram user id
- company approval to send repository-derived text through Telegram

Telegram bot chats are **not end-to-end encrypted**. Existing Codex App chats can be listed and read after they are persisted. Only turns started by this service have guaranteed live streaming, approval, steering, and interruption; do not operate the same chat simultaneously in Codex App.

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

`/projects`, `/project`, `/chats [all]`, `/find`, `/use`, `/new`, `/where`, `/history`, `/status`, `/stop`, `/steer`, `/diff`, `/fullaccess on|off`, and `/help` are implemented. Plain text starts a turn, or queues the next turn when the selected chat is busy.

Approval prompts offer `Allow once`, `Allow for session` for the current Codex session, and a confirmed per-chat `Enable full access` mode. Full access applies to future Telegram-started turns, uses Codex `dangerFullAccess` with approval policy `never`, and therefore grants the agent the same filesystem and network reach as the macOS user. Use `/fullaccess off` to return future turns to workspace-write with approvals. Managed Codex policy remains authoritative and can reject the requested mode.

## Service installation

Copy and edit `launchd/run-service.sh.example`, keeping its referenced environment file mode `0600`. Edit the plist with absolute paths, copy it into `~/Library/LaunchAgents`, ensure configuration/log directories are mode `0700`, then load it with `launchctl bootstrap gui/$(id -u) ...`. The launch agent runs as the logged-in user and keeps the service alive without placing tokens in process arguments or the plist.

## Development

The version-matched app-server TypeScript schema is in `generated/` and can be refreshed with `pnpm generate:protocol`. Tests use fakes and never access the developer's real Codex store.

This release fails closed outside the generated/tested Codex CLI range `>=0.145.0 <0.146.0`. Regenerate the protocol types and update contract tests before widening that range.

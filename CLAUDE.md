# wopr-plugin-whatsapp

WhatsApp channel plugin for WOPR using Baileys (WhatsApp Web protocol).

## Commands

```bash
npm run build     # tsc
npm run check     # biome check + tsc --noEmit (run before committing)
npm run lint:fix  # biome check --fix src/
npm run format    # biome format --write src/
npm test          # vitest run
```

## Architecture

```
src/
  index.ts              # Plugin entry — thin orchestrator
  types.ts              # Plugin-local types + re-exports
  logger.ts             # Winston logger singleton (lazy-initialized)
  connection.ts         # Baileys socket lifecycle (create, login, logout)
  credentials.ts        # Auth directory helpers + migration
  commands.ts           # !command handlers, session state
  message-handler.ts    # Incoming message pipeline
  messaging.ts          # Send logic with chunking
  media.ts              # Media download/send, DM policy, file validation
  typing.ts             # Typing indicator management
  channel-provider.ts   # Cross-plugin channel provider + command/parser registry
```

## Key Details

- **Framework**: Baileys (`@whiskeysockets/baileys`) — WhatsApp Web reverse-engineered protocol
- **No official API** — this uses the unofficial Baileys library. WhatsApp can block accounts.
- Auth state (session credentials) must be persisted between restarts — Baileys provides `useMultiFileAuthState`
- QR code pairing on first run — user scans from WhatsApp mobile app
- **Gotcha**: Baileys session files must survive restarts. If lost, QR re-pairing is required.
- **Gotcha**: Baileys API changes frequently between versions — pin the version and test before upgrading

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-whatsapp`.

## Session Memory

At the start of every WOPR session, **read `~/.wopr-memory.md` if it exists.** It contains recent session context: which repos were active, what branches are in flight, and how many uncommitted changes exist. Use it to orient quickly without re-investigating.

The `Stop` hook writes to this file automatically at session end. Only non-main branches are recorded — if everything is on `main`, nothing is written for that repo.
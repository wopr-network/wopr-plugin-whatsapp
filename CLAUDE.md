# wopr-plugin-whatsapp

WhatsApp channel plugin for WOPR using Baileys (WhatsApp Web protocol).

## Commands

```bash
npm run build      # tsc
npm run check      # biome check --config-path=. src/ && tsc --noEmit (run before committing)
npm run lint       # biome check --config-path=. src/
npm run lint:fix   # biome check --config-path=. --fix src/
npm run format     # biome format --config-path=. --write src/
npm run typecheck  # tsc --noEmit
npm test           # vitest run
```

## Architecture

```
src/
  index.ts   # Plugin entry — Baileys connection lifecycle
  types.ts   # Plugin-local types
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
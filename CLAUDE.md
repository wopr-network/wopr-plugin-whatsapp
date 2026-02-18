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

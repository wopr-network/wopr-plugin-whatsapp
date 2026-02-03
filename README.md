# wopr-plugin-whatsapp

[![npm version](https://img.shields.io/npm/v/wopr-plugin-whatsapp.svg)](https://www.npmjs.com/package/wopr-plugin-whatsapp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)
[![Baileys](https://img.shields.io/badge/Powered%20by-Baileys-25D366?logo=whatsapp)](https://github.com/WhiskeySockets/Baileys)

> WhatsApp integration for [WOPR](https://github.com/TSavo/wopr) using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web).

Connect your WOPR AI agent to the world's most popular messaging platform. Chat with your AI through WhatsApp DMs or groups, with fine-grained access controls and multi-account support.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Self-Chat Mode](#self-chat-mode-for-personal-phones)
- [Configuration](#configuration)
- [Multi-Account Setup](#multi-account-setup)
- [Commands](#commands)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Related Projects](#related-projects)

---

## Features

| Feature | Description |
|---------|-------------|
| **WhatsApp Web Connection** | QR code pairing with your WhatsApp account |
| **Group Support** | Full group chat integration |
| **DM Policies** | Control access: allowlist, open, or disabled |
| **Self-Chat Mode** | Use your personal number without spamming contacts |
| **Identity Reactions** | Reacts with your agent's emoji when processing messages |
| **Smart Message Chunking** | Automatically splits long responses (4000 char limit) |
| **Multi-Account** | Run multiple WhatsApp numbers from one WOPR instance |
| **Credential Backup Restore** | Restore credentials from backup if primary is lost |

---

## Installation

### Via WOPR CLI (Recommended)

```bash
wopr channels add whatsapp
```

### Via NPM

```bash
npm install wopr-plugin-whatsapp
```

### Requirements

- Node.js 18+
- WOPR ^2.0.0 (peer dependency)
- WhatsApp app on your phone (iOS/Android)
- Terminal that supports QR codes (most modern terminals)

---

## Quick Start

### 1. Login to WhatsApp

```bash
wopr channels login whatsapp
```

You'll see a QR code in your terminal. Scan it with WhatsApp:

| Platform | Steps |
|----------|-------|
| **iOS** | Settings -> Linked Devices -> Link a Device |
| **Android** | Menu -> Linked Devices -> Link a Device |

### 2. Test Your Connection

Send a message to your WhatsApp number (or to a group where your account is present). Your WOPR agent should respond!

### 3. Configure (Optional)

```bash
wopr configure --plugin whatsapp
```

---

## Self-Chat Mode (For Personal Phones)

**Important:** If you're using your personal WhatsApp number, enable **Self-Chat Mode** to prevent accidentally spamming your contacts.

### What is Self-Chat Mode?

Self-Chat Mode restricts WOPR to only respond to messages from a specific phone number (typically yours). This creates a private chat interface between you and your AI agent using your existing WhatsApp account.

### Why Use It?

- **Prevents accidental spam** - WOPR won't reply to friends/family
- **Private AI assistant** - Only you can interact with the bot
- **No secondary phone needed** - Use your main number safely

### Configuration

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"  # Your phone number in E.164 format
    selfChatMode: true
    ownerNumber: "+1234567890"
```

---

## Configuration

### Quick Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accountId` | string | `"default"` | Unique identifier for multi-account support |
| `dmPolicy` | string | `"allowlist"` | DM handling: `allowlist`, `open`, or `disabled` |
| `allowFrom` | string[] | `[]` | Allowed phone numbers (E.164 format). Use `["*"]` to allow all. |
| `selfChatMode` | boolean | `false` | Enable for personal phone numbers |
| `ownerNumber` | string | - | Your number for self-chat mode |
| `verbose` | boolean | `false` | Enable detailed Baileys logging |
| `authDir` | string | `~/.wopr/credentials/whatsapp` | Custom credentials directory |

### Policy Modes Explained

- **`allowlist`** - Only respond to numbers in `allowFrom` (recommended). Use `["*"]` in allowFrom to allow everyone.
- **`open`** - Respond to all DMs (use with caution)
- **`disabled`** - Ignore all DMs (groups still work)

**Note:** Group messages are always processed regardless of DM policy.

---

## Multi-Account Setup

Run multiple WhatsApp accounts by setting different `accountId` values. Each account stores credentials separately:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accountId: "personal"
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"
    selfChatMode: true
```

Credentials are stored per account:
```
~/.wopr/credentials/whatsapp/
├── default/
│   └── creds.json
├── personal/
│   └── creds.json
└── business/
    └── creds.json
```

---

## Commands

| Command | Description |
|---------|-------------|
| `wopr channels login whatsapp` | Login with QR code |
| `wopr channels logout whatsapp` | Logout and clear credentials |
| `wopr channels status whatsapp` | Check connection status |
| `wopr configure --plugin whatsapp` | Interactive configuration |

---

## Security

### Data Storage

- Credentials stored locally in `~/.wopr/credentials/whatsapp/<accountId>/`
- Auth state uses Baileys multi-file JSON storage
- If `creds.json` is lost, the plugin attempts to restore from `creds.json.bak`

### Access Control

- DM policies control who can message the bot
- Self-chat mode prevents accidental responses to contacts
- Phone number allowlisting with E.164 format validation

### Best Practices

1. Use `allowlist` policy with `selfChatMode` for personal numbers
2. Keep credentials directory secure (`chmod 700`)
3. Use separate accounts for personal/business use
4. Regularly backup `~/.wopr/credentials/`

---

## Troubleshooting

### QR Code Issues

**QR code not appearing?**
- Ensure your terminal supports Unicode and has sufficient width (80+ chars)
- Try resizing your terminal window
- Enable verbose logging in config to see more details

**QR code scanning fails?**
- Clean your phone camera lens
- Ensure good lighting
- Hold phone steady for 2-3 seconds
- Try generating a fresh QR: logout and login again

### Connection Issues

**"Connection dropped" errors?**
WhatsApp Web sessions can expire. Simply run:
```bash
wopr channels login whatsapp
```

**Messages not received?**
- Check DM policy and `allowFrom` configuration
- Verify the bot is added to the group (for group chats)
- Check logs: `~/.wopr/logs/whatsapp-plugin.log`

### Logging

The plugin writes logs to:
- `~/.wopr/logs/whatsapp-plugin.log` - All debug logs
- `~/.wopr/logs/whatsapp-plugin-error.log` - Errors only
- Console shows warnings and above

---

## Architecture

```
+------------------+     +---------------+     +------------------+
|   WhatsApp App   |<--->|    Baileys    |<--->|  WOPR WhatsApp   |
|   (Your Phone)   |     |  (WhatsApp    |     |     Plugin       |
|                  |     |   Web API)    |     |                  |
+------------------+     +---------------+     +--------+---------+
                                                        |
                            +---------------------------+
                            v
                     +--------------+
                     |     WOPR     |
                     |     Core     |
                     +--------------+
```

### Components

| Component | Description |
|-----------|-------------|
| **Baileys** | WhatsApp Web library for Node.js (no Puppeteer/Chrome needed) |
| **Multi-file auth state** | Credentials stored as JSON files via Baileys |
| **qrcode-terminal** | Displays QR codes directly in terminal |
| **Winston logger** | Structured logging to file and console |
| **Pino** | Internal logger used by Baileys (silent by default) |

### Dependencies

```json
{
  "@whiskeysockets/baileys": "^6.7.9",
  "qrcode-terminal": "^0.12.0",
  "pino": "^9.0.0",
  "winston": "^3.11.0"
}
```

### Message Flow

1. User sends message via WhatsApp
2. Baileys receives message via WhatsApp Web protocol
3. Plugin checks DM policy for authorization
4. Plugin sends reaction (agent emoji) as acknowledgment
5. Message is injected into WOPR for processing
6. Response is chunked (if > 4000 chars) and sent back via Baileys

---

## API

### Exported Functions

```typescript
// Login with QR code - displays QR in terminal
export async function login(): Promise<void>

// Logout and clear credentials
export async function logout(): Promise<void>
```

### Plugin Interface

The plugin exports a default `WOPRPlugin` object:

```typescript
export default {
  name: "whatsapp",
  version: "1.0.0",
  description: "WhatsApp integration using Baileys (WhatsApp Web)",
  init: (context: WOPRPluginContext) => Promise<void>,
  shutdown: () => Promise<void>
}
```

---

## Related Projects

| Project | Description |
|---------|-------------|
| [WOPR](https://github.com/TSavo/wopr) | Main WOPR project - Self-sovereign AI session management |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | WhatsApp Web API library |

---

## License

MIT

---

[Back to Top](#wopr-plugin-whatsapp)

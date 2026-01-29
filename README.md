# wopr-plugin-whatsapp

[![npm version](https://img.shields.io/npm/v/wopr-plugin-whatsapp.svg)](https://www.npmjs.com/package/wopr-plugin-whatsapp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)
[![Baileys](https://img.shields.io/badge/Powered%20by-Baileys-25D366?logo=whatsapp)](https://github.com/WhiskeySockets/Baileys)

> WhatsApp integration for [WOPR](https://github.com/TSavo/wopr) using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web).

Connect your WOPR AI agent to the world's most popular messaging platform. Chat with your AI through WhatsApp DMs or groups, with fine-grained access controls and multi-account support.

---

## 📋 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Self-Chat Mode](#-self-chat-mode-for-personal-phones)
- [Configuration](#-configuration)
- [Multi-Account Setup](#-multi-account-setup)
- [Commands](#-commands)
- [Documentation](#-documentation)
- [Security](#-security)
- [Troubleshooting](#-troubleshooting)
- [Related Projects](#-related-projects)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 📱 **WhatsApp Web Connection** | Seamless QR code pairing with your WhatsApp account |
| 👥 **Group Support** | Full group chat integration with mention detection |
| 🔒 **DM Policies** | Granular control: allowlist, blocklist, open, or disabled |
| 💬 **Self-Chat Mode** | Use your personal number without spamming contacts |
| 👀 **Identity Reactions** | Reacts with your agent's emoji when processing messages |
| 📝 **Smart Message Chunking** | Automatically splits long responses (4000 char limit) |
| 🔧 **Multi-Account** | Run multiple WhatsApp numbers from one WOPR instance |
| 💾 **Auto-Backup** | Credentials backed up automatically to prevent data loss |
| 🔄 **Auto-Reconnect** | Handles connection drops and session restoration |

---

## 📦 Installation

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
- WhatsApp app on your phone (iOS/Android)
- Terminal that supports QR codes (most modern terminals)

---

## 🚀 Quick Start

### 1. Login to WhatsApp

```bash
wopr channels login whatsapp
```

You'll see a QR code in your terminal. Scan it with WhatsApp:

| Platform | Steps |
|----------|-------|
| **iOS** | Settings → Linked Devices → Link a Device |
| **Android** | ⋮ Menu → Linked Devices → Link a Device |

### 2. Test Your Connection

Send a message to your WhatsApp number (or to a group where your account is present). Your WOPR agent should respond!

### 3. Configure (Optional)

```bash
wopr configure --plugin whatsapp
```

---

## 💬 Self-Chat Mode (For Personal Phones)

**⚠️ Important:** If you're using your personal WhatsApp number, enable **Self-Chat Mode** to prevent accidentally spamming your contacts.

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

> 📖 See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for all options.

---

## ⚙️ Configuration

### Quick Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accountId` | string | `default` | Unique identifier for multi-account support |
| `dmPolicy` | string | `allowlist` | DM handling: `allowlist`, `blocklist`, `open`, `disabled` |
| `allowFrom` | string[] | `[]` | Allowed phone numbers (E.164 format) |
| `blockFrom` | string[] | `[]` | Blocked phone numbers (E.164 format) |
| `selfChatMode` | boolean | `false` | Enable for personal phone numbers |
| `ownerNumber` | string | - | Your number for self-chat mode |
| `verbose` | boolean | `false` | Enable detailed Baileys logging |
| `authDir` | string | `~/.wopr/credentials/whatsapp` | Custom credentials directory |

### Policy Modes Explained

- **`allowlist`** - Only respond to numbers in `allowFrom` (recommended)
- **`blocklist`** - Respond to everyone except numbers in `blockFrom`
- **`open`** - Respond to all DMs (use with caution)
- **`disabled`** - Ignore all DMs (groups still work)

> 📖 Detailed configuration guide: [docs/CONFIGURATION.md](./docs/CONFIGURATION.md)

---

## 👥 Multi-Account Setup

Run multiple WhatsApp accounts from a single WOPR instance:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accounts:
      personal:
        accountId: "personal"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"
        selfChatMode: true
      business:
        accountId: "business"
        dmPolicy: "open"
```

Credentials are stored separately:
```
~/.wopr/credentials/whatsapp/
├── personal/
│   └── creds.json
└── business/
    └── creds.json
```

> 📖 Complete multi-account guide: [docs/MULTI_ACCOUNT.md](./docs/MULTI_ACCOUNT.md)

---

## 🖥️ Commands

| Command | Description |
|---------|-------------|
| `wopr channels login whatsapp` | Login with QR code |
| `wopr channels login whatsapp --account business` | Login specific account |
| `wopr channels logout whatsapp` | Logout and clear credentials |
| `wopr channels logout whatsapp --account business` | Logout specific account |
| `wopr channels status whatsapp` | Check connection status |
| `wopr configure --plugin whatsapp` | Interactive configuration |

---

## 📚 Documentation

- **[CONFIGURATION.md](./docs/CONFIGURATION.md)** - Complete configuration reference
- **[TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[MULTI_ACCOUNT.md](./docs/MULTI_ACCOUNT.md)** - Multi-number setup guide
- **[SECURITY.md](./docs/SECURITY.md)** - Security best practices

### Example Configurations

- **[Personal Phone Setup](./examples/personal-phone-config.json)** - Safe self-chat configuration
- **[Business Setup](./examples/business-config.json)** - Open business bot configuration

---

## 🔒 Security

### Data Storage

- Credentials stored locally in `~/.wopr/credentials/whatsapp/`
- Automatic backup of credentials to prevent data loss
- Auth state uses multi-file JSON storage

### Access Control

- DM policies to control message access
- Self-chat mode to prevent accidental spam
- Phone number allowlisting/blocklisting

### Best Practices

1. ✅ Use `allowlist` policy with `selfChatMode` for personal numbers
2. ✅ Keep credentials directory secure (`chmod 700`)
3. ✅ Use separate accounts for personal/business use
4. ✅ Regularly backup `~/.wopr/credentials/`

> 📖 Full security guide: [docs/SECURITY.md](./docs/SECURITY.md)

---

## 🔧 Troubleshooting

### QR Code Issues

**QR code not appearing?**
- Ensure your terminal supports Unicode and has sufficient width (80+ chars)
- Try resizing your terminal window
- Use `wopr channels login whatsapp --verbose` for details

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

> 📖 Complete troubleshooting: [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   WhatsApp App  │◄───►│   Baileys    │◄───►│  WOPR WhatsApp  │
│   (Your Phone)  │     │  (WhatsApp   │     │     Plugin      │
│                 │     │    Web API)  │     │                 │
└─────────────────┘     └──────────────┘     └────────┬────────┘
                                                      │
                           ┌──────────────────────────┘
                           ▼
                    ┌──────────────┐
                    │     WOPR     │
                    │    Core      │
                    └──────────────┘
```

### Components

- **Baileys** - WhatsApp Web library for Node.js (no Puppeteer/Chrome needed)
- **Multi-file auth state** - Credentials stored in JSON files
- **QR Terminal** - Display QR codes directly in terminal
- **Winston logger** - Structured logging with file rotation

---

## 🤝 Related Projects

| Project | Description |
|---------|-------------|
| [WOPR](https://github.com/TSavo/wopr) | 🎯 Main WOPR project - Self-sovereign AI session management |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | 📱 WhatsApp Web API library |
| [wopr-plugin-discord](https://github.com/TSavo/wopr-plugin-discord) | 💬 Discord integration for WOPR |
| [wopr-plugin-slack](https://github.com/TSavo/wopr-plugin-slack) | 💼 Slack integration for WOPR |
| [wopr-plugin-telegram](https://github.com/TSavo/wopr-plugin-telegram) | ✈️ Telegram integration for WOPR |

---

## 📄 License

MIT © [TSavo](https://github.com/TSavo)

---

<div align="center">

**[⬆ Back to Top](#wopr-plugin-whatsapp)**

Made with 💚 for the WOPR ecosystem

</div>

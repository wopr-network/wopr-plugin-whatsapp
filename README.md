# wopr-plugin-whatsapp

WhatsApp integration for [WOPR](https://github.com/TSavo/wopr) using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web).

## Features

- 📱 **WhatsApp Web Connection** - Scan QR code to link your WhatsApp account
- 👥 **Group Support** - Works in WhatsApp groups with mention detection
- 🔒 **DM Policies** - Control who can message the bot (allowlist, open, disabled)
- 💬 **Self-Chat Mode** - Use your personal WhatsApp number without spamming contacts
- 👀 **Identity Reactions** - Reacts with your agent's emoji when processing messages
- 📝 **Message Chunking** - Automatically splits long responses (4000 char limit)

## Installation

```bash
wopr channels add whatsapp
```

Or manually:

```bash
npm install wopr-plugin-whatsapp
```

## Setup

### 1. Login to WhatsApp

```bash
wopr channels login whatsapp
```

This will display a QR code. Scan it with WhatsApp:
- **iOS**: Settings → Linked Devices → Link a Device
- **Android**: Menu → Linked Devices → Link a Device

### 2. Configure (Optional)

```bash
wopr configure --plugin whatsapp
```

### 3. Using with Personal Phone

If using your personal WhatsApp number, enable **self-chat mode**:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"  # Your phone number
    selfChatMode: true
```

This prevents WOPR from accidentally spamming your contacts.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accountId` | string | `default` | Unique identifier for multi-account support |
| `dmPolicy` | string | `allowlist` | DM handling: `allowlist`, `open`, `disabled` |
| `allowFrom` | string[] | `[]` | Allowed phone numbers (E.164 format) |
| `selfChatMode` | boolean | `false` | Enable for personal phone numbers |
| `ownerNumber` | string | - | Your number for self-chat mode |
| `verbose` | boolean | `false` | Enable detailed Baileys logging |

## Commands

| Command | Description |
|---------|-------------|
| `wopr channels login whatsapp` | Login with QR code |
| `wopr channels logout whatsapp` | Logout and clear credentials |
| `wopr channels status whatsapp` | Check connection status |

## Multi-Account Support

Use multiple WhatsApp accounts:

```yaml
channels:
  whatsapp:
    accountId: "business"
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"
```

Credentials are stored in:
```
~/.wopr/credentials/whatsapp/<accountId>/
```

## Architecture

The plugin uses:
- **Baileys** - WhatsApp Web library for Node.js
- **Multi-file auth state** - Credentials stored in JSON files
- **QR Terminal** - Display QR codes in terminal
- **Pino logger** - Structured logging (when verbose)

## Security

- Credentials stored locally in `~/.wopr/credentials/whatsapp/`
- Automatic backup of credentials to prevent data loss
- DM policies to control message access
- Self-chat mode to prevent accidental spam

## Troubleshooting

### QR Code not appearing
Check that your terminal supports QR codes. The plugin uses `qrcode-terminal` which works in most modern terminals.

### Connection dropped
WhatsApp Web sessions can expire. Run `wopr channels login whatsapp` again to re-link.

### Messages not received
Check DM policy and `allowFrom` configuration. The bot ignores unknown senders in `allowlist` mode.

### Credentials corrupted
The plugin automatically backs up credentials. Delete `creds.json` and restart to restore from backup.

## License

MIT

## See Also

- [WOPR](https://github.com/TSavo/wopr) - The main WOPR project
- [Baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web library

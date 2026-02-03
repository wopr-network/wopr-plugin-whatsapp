# WhatsApp Plugin Identity

**Name**: whatsapp
**Version**: 1.0.0
**Description**: WhatsApp integration using Baileys (WhatsApp Web)

## Role

The WhatsApp integration for WOPR, connecting to WhatsApp via the Baileys library (WhatsApp Web protocol).

## Capabilities

- WhatsApp Web connection via QR code
- Group chat support (always processed)
- Configurable DM policies (allowlist, open, disabled)
- Self-chat mode for personal phone numbers
- Identity-aware reactions (uses agent emoji)
- Message chunking for long responses (4000 char limit)
- Credential backup restore (restores from .bak if primary lost)

## Login Flow

1. Run `wopr channels login whatsapp`
2. Scan the QR code in WhatsApp (Settings -> Linked Devices)
3. Auth stored in `~/.wopr/credentials/whatsapp/<accountId>/`

## Security

- DM policy controls who can message the bot
- Self-chat mode prevents spamming contacts when using personal number
- Credentials can be restored from backup if primary file is corrupted

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accountId` | string | `"default"` | Unique identifier for multi-account support |
| `dmPolicy` | string | `"allowlist"` | DM handling: allowlist, open, or disabled |
| `allowFrom` | string[] | `[]` | Allowed phone numbers (E.164 format) |
| `selfChatMode` | boolean | `false` | Enable for personal phone numbers |
| `ownerNumber` | string | - | Your number for self-chat mode |
| `verbose` | boolean | `false` | Enable detailed Baileys logging |
| `authDir` | string | - | Custom credentials directory |

## Multi-Account

Support multiple WhatsApp accounts using `accountId` in config:
```yaml
channels:
  whatsapp:
    accountId: "business"
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"
```

# Configuration Guide

> Complete configuration reference for the WOPR WhatsApp Plugin

---

## Table of Contents

- [Configuration File Location](#configuration-file-location)
- [Configuration Options](#configuration-options)
- [Policy Modes](#policy-modes)
- [Phone Number Formats](#phone-number-formats)
- [Configuration Examples](#configuration-examples)
- [Environment Variables](#environment-variables)
- [Advanced Configuration](#advanced-configuration)

---

## Configuration File Location

The WhatsApp plugin configuration is stored in the main WOPR config file:

```
~/.wopr/config.yaml
```

Or if using a custom WOPR home directory:

```
$WOPR_HOME/config.yaml
```

---

## Configuration Options

### Core Options

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `accountId` | `string` | `default` | No | Unique identifier for this WhatsApp account |
| `dmPolicy` | `string` | `allowlist` | No | Direct message handling policy |
| `allowFrom` | `string[]` | `[]` | No | Allowed phone numbers (E.164 format) |
| `blockFrom` | `string[]` | `[]` | No | Blocked phone numbers (E.164 format) |
| `selfChatMode` | `boolean` | `false` | No | Enable self-chat mode for personal phones |
| `ownerNumber` | `string` | - | No* | Your phone number (required for self-chat mode) |
| `verbose` | `boolean` | `false` | No | Enable detailed Baileys logging |
| `authDir` | `string` | `~/.wopr/credentials/whatsapp` | No | Custom credentials directory |

### Option Details

#### `accountId`

Unique identifier for multi-account support. Each account gets its own credentials directory.

```yaml
channels:
  whatsapp:
    accountId: "business"  # Creates ~/.wopr/credentials/whatsapp/business/
```

#### `dmPolicy`

Controls who can send direct messages to the bot.

| Value | Description |
|-------|-------------|
| `allowlist` | Only respond to numbers in `allowFrom` (most secure) |
| `blocklist` | Respond to all except numbers in `blockFrom` |
| `open` | Respond to all DMs (least secure) |
| `disabled` | Ignore all DMs, groups only |

```yaml
channels:
  whatsapp:
    dmPolicy: "allowlist"  # Recommended for most use cases
```

#### `allowFrom`

Array of phone numbers allowed to DM the bot when using `allowlist` policy.

```yaml
channels:
  whatsapp:
    allowFrom:
      - "+1234567890"
      - "+441234567890"
      - "*"  # Wildcard - allows all (same as open policy)
```

#### `blockFrom`

Array of phone numbers blocked from DMing the bot when using `blocklist` policy.

```yaml
channels:
  whatsapp:
    dmPolicy: "blocklist"
    blockFrom:
      - "+19998887777"
      - "+16665554444"
```

#### `selfChatMode`

**Critical for personal phone use.** When enabled, WOPR:
- Only responds to messages from `ownerNumber`
- Prevents accidental responses to friends/family
- Creates a private AI assistant interface

```yaml
channels:
  whatsapp:
    selfChatMode: true
    ownerNumber: "+1234567890"
```

#### `ownerNumber`

Your phone number in E.164 format. Required when `selfChatMode` is enabled.

```yaml
channels:
  whatsapp:
    ownerNumber: "+1234567890"  # US number example
```

#### `verbose`

Enable detailed logging from Baileys. Useful for debugging connection issues.

```yaml
channels:
  whatsapp:
    verbose: true  # Enables Baileys debug logs
```

**Log locations:**
- `~/.wopr/logs/whatsapp-plugin.log` - General logs
- `~/.wopr/logs/whatsapp-plugin-error.log` - Error logs only

#### `authDir`

Custom directory for storing WhatsApp credentials. Useful for:
- Shared credential storage
- Docker volumes
- Custom backup strategies

```yaml
channels:
  whatsapp:
    authDir: "/mnt/secure/whatsapp-auth"
```

---

## Policy Modes

### Allowlist Mode (Recommended)

Only respond to explicitly allowed numbers.

```yaml
channels:
  whatsapp:
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"
      - "+0987654321"
```

**Use cases:**
- Personal AI assistant
- Family bot
- Small team access

### Blocklist Mode

Respond to everyone except blocked numbers.

```yaml
channels:
  whatsapp:
    dmPolicy: "blocklist"
    blockFrom:
      - "+19998887777"  # Known spammer
```

**Use cases:**
- Public business bot
- Community bot with banned users

### Open Mode

Respond to all incoming DMs.

```yaml
channels:
  whatsapp:
    dmPolicy: "open"
```

**⚠️ Warning:** Anyone who gets your WhatsApp number can use your AI. Monitor usage and costs.

**Use cases:**
- Public customer support bot
- Marketing bot with dedicated number

### Disabled Mode

Ignore all DMs. Groups still work.

```yaml
channels:
  whatsapp:
    dmPolicy: "disabled"
```

**Use cases:**
- Group-only bot
- Temporary DM suspension

---

## Phone Number Formats

### E.164 Format

All phone numbers must be in E.164 format:
- `+` followed by country code
- No spaces, dashes, or parentheses
- 10-15 digits total

| Country | Local Format | E.164 Format |
|---------|-------------|--------------|
| USA | (555) 123-4567 | `+15551234567` |
| UK | 07700 900123 | `+447700900123` |
| Germany | 01512 3456789 | `+4915123456789` |
| India | +91 98765 43210 | `+919876543210` |
| Brazil | (11) 91234-5678 | `+5511912345678` |

### Conversion Examples

```javascript
// Good
+15551234567
+447700900123

// Bad - will not work
15551234567        // Missing +
+1 (555) 123-4567  // Contains spaces and punctuation
555-123-4567       // Missing country code
```

---

## Configuration Examples

### Personal Phone Setup (Self-Chat)

Safest configuration for using your personal WhatsApp number:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    # Account identification
    accountId: "personal"
    
    # Security - only you can chat
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"  # Replace with your number
    
    # Self-chat mode for safety
    selfChatMode: true
    ownerNumber: "+1234567890"
    
    # Optional: verbose logging for debugging
    verbose: false
```

### Business Bot Setup

Open configuration for customer support:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accountId: "business"
    
    # Open for customer inquiries
    dmPolicy: "open"
    
    # Optional: block known spammers
    blockFrom:
      - "+19998887777"
    
    # No self-chat mode - this is a dedicated business number
    selfChatMode: false
```

### Team Access Setup

Limited access for a specific group:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accountId: "team"
    
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"  # Alice
      - "+2345678901"  # Bob
      - "+3456789012"  # Charlie
    
    # Groups are always allowed regardless of DM policy
```

### Multi-Account Setup

Run personal and business accounts simultaneously:

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
        ownerNumber: "+1234567890"
      
      business:
        accountId: "business"
        dmPolicy: "open"
        selfChatMode: false
```

### Docker/Container Setup

Store credentials on a persistent volume:

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accountId: "docker"
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"
    
    # Store auth on mounted volume
    authDir: "/data/whatsapp-auth"
    selfChatMode: true
    ownerNumber: "+1234567890"
```

---

## Environment Variables

These environment variables can override configuration:

| Variable | Description | Example |
|----------|-------------|---------|
| `WOPR_HOME` | WOPR configuration directory | `/home/user/.wopr` |
| `WOPR_WHATSAPP_VERBOSE` | Force verbose logging | `1` or `true` |
| `WOPR_WHATSAPP_ACCOUNT` | Default account ID | `business` |

---

## Advanced Configuration

### Credentials Backup

The plugin automatically backs up credentials to prevent data loss:

```
~/.wopr/credentials/whatsapp/<accountId>/
├── creds.json          # Active credentials
├── creds.json.bak      # Automatic backup
└── app-state-sync/     # Sync tokens
```

To manually backup:
```bash
cp -r ~/.wopr/credentials/whatsapp ~/backups/whatsapp-creds
```

To restore from backup:
```bash
cp ~/backups/whatsapp-creds/* ~/.wopr/credentials/whatsapp/default/
```

### Log Rotation

Logs are automatically rotated by Winston:

- `whatsapp-plugin.log` - All logs (debug level)
- `whatsapp-plugin-error.log` - Error logs only
- Max size: 5MB per file
- Max files: 5 backups

### Custom Logger

To use a custom logger configuration, set `verbose: false` and handle logging externally.

---

## Validation

Test your configuration:

```bash
# Validate YAML syntax
wopr config validate

# Check WhatsApp configuration specifically
wopr channels config whatsapp

# Test connection with current config
wopr channels status whatsapp
```

---

## See Also

- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
- [SECURITY.md](./SECURITY.md) - Security best practices
- [MULTI_ACCOUNT.md](./MULTI_ACCOUNT.md) - Multi-number setup

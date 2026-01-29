# Multi-Account Setup Guide

> Run multiple WhatsApp accounts from a single WOPR instance

---

## Table of Contents

- [Overview](#overview)
- [Use Cases](#use-cases)
- [Configuration](#configuration)
- [Account Management](#account-management)
- [Directory Structure](#directory-structure)
- [Examples](#examples)
- [Best Practices](#best-practices)

---

## Overview

The WOPR WhatsApp Plugin supports running multiple WhatsApp accounts simultaneously. Each account:
- Has its own unique `accountId`
- Stores credentials separately
- Can have different configuration
- Operates independently

### Supported Scenarios

- ✅ Personal + Business numbers
- ✅ Multiple business lines
- ✅ Testing + Production environments
- ✅ Different regions/countries
- ✅ Client account management

---

## Use Cases

### Personal & Business Separation

Use your personal WhatsApp for private AI assistant while running a business bot:

```yaml
channels:
  whatsapp:
    accounts:
      personal:
        accountId: "personal"
        dmPolicy: "allowlist"
        allowFrom: ["+1234567890"]
        selfChatMode: true
        ownerNumber: "+1234567890"
      
      business:
        accountId: "business"
        dmPolicy: "open"
```

### Multi-Regional Support

Run separate accounts for different countries:

```yaml
channels:
  whatsapp:
    accounts:
      us_support:
        accountId: "us-support"
        dmPolicy: "open"
      
      eu_support:
        accountId: "eu-support"
        dmPolicy: "open"
```

### Testing & Production

Test configuration changes without affecting production:

```yaml
channels:
  whatsapp:
    accounts:
      production:
        accountId: "prod"
        dmPolicy: "allowlist"
        allowFrom: ["+1234567890"]
      
      staging:
        accountId: "staging"
        dmPolicy: "open"  # More permissive for testing
        verbose: true     # Detailed logging
```

---

## Configuration

### Basic Multi-Account Config

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accounts:
      <account-key>:
        accountId: "<unique-id>"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"
        selfChatMode: true
        ownerNumber: "+1234567890"
        verbose: false
```

### Configuration Options per Account

Each account supports all standard options:

| Option | Account-Specific | Description |
|--------|-----------------|-------------|
| `accountId` | ✅ Required | Unique identifier for the account |
| `dmPolicy` | ✅ | DM policy for this account |
| `allowFrom` | ✅ | Allowed numbers for this account |
| `blockFrom` | ✅ | Blocked numbers for this account |
| `selfChatMode` | ✅ | Self-chat for this account |
| `ownerNumber` | ✅ | Owner number for this account |
| `verbose` | ✅ | Verbose logging for this account |
| `authDir` | ✅ | Custom auth directory (optional) |

---

## Account Management

### Adding a New Account

1. **Add to configuration**
   ```yaml
   channels:
     whatsapp:
       accounts:
         newaccount:
           accountId: "newaccount"
           dmPolicy: "allowlist"
           allowFrom: ["+1234567890"]
   ```

2. **Login the new account**
   ```bash
   wopr channels login whatsapp --account newaccount
   ```

3. **Verify connection**
   ```bash
   wopr channels status whatsapp --account newaccount
   ```

### Switching Between Accounts

Most commands support an `--account` flag:

```bash
# Login specific account
wopr channels login whatsapp --account business

# Logout specific account
wopr channels logout whatsapp --account business

# Check status of specific account
wopr channels status whatsapp --account personal

# Configure specific account
wopr configure --plugin whatsapp --account personal
```

### Default Account

When no `--account` is specified, the plugin uses:
1. The account marked as `default: true` (if any)
2. The account with `accountId: "default"`
3. The first account in the config (alphabetically)

```yaml
channels:
  whatsapp:
    accounts:
      personal:
        accountId: "personal"
        default: true  # Makes this the default
```

### Removing an Account

1. **Logout and remove credentials**
   ```bash
   wopr channels logout whatsapp --account oldaccount
   ```

2. **Remove from configuration**
   ```yaml
   # Edit ~/.wopr/config.yaml and remove the account section
   ```

3. **Clean up credentials (optional)**
   ```bash
   rm -rf ~/.wopr/credentials/whatsapp/oldaccount
   ```

---

## Directory Structure

Multi-account credentials are stored separately:

```
~/.wopr/credentials/whatsapp/
├── default/                    # Default account
│   ├── creds.json
│   ├── creds.json.bak
│   └── app-state-sync/
│       └── ...
├── personal/                   # Personal account
│   ├── creds.json
│   ├── creds.json.bak
│   └── app-state-sync/
└── business/                   # Business account
    ├── creds.json
    ├── creds.json.bak
    └── app-state-sync/
```

### Log Files

Each account has separate log entries:

```
~/.wopr/logs/
├── whatsapp-plugin.log         # All accounts
└── whatsapp-plugin-error.log   # All accounts (errors only)
```

Log entries are tagged with the account ID for filtering:

```bash
# View logs for specific account
grep "business" ~/.wopr/logs/whatsapp-plugin.log
```

---

## Examples

### Example 1: Personal + Business

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accounts:
      # Personal number - private AI assistant
      personal:
        accountId: "personal"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"  # Your number
        selfChatMode: true
        ownerNumber: "+1234567890"
        verbose: false
      
      # Business number - customer support
      business:
        accountId: "business"
        dmPolicy: "open"
        blockFrom:
          - "+19998887777"  # Block spammers
        selfChatMode: false
        verbose: true
```

### Example 2: Multi-Department

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accounts:
      # Sales team
      sales:
        accountId: "sales-dept"
        dmPolicy: "open"
        ownerNumber: "+18001234567"
      
      # Support team
      support:
        accountId: "support-dept"
        dmPolicy: "open"
        ownerNumber: "+18009876543"
      
      # Billing team (restricted)
      billing:
        accountId: "billing-dept"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"  # Manager only
        ownerNumber: "+18005551234"
```

### Example 3: Development Environment

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accounts:
      # Production - careful configuration
      production:
        accountId: "prod"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"
          - "+0987654321"
        verbose: false
      
      # Staging - open for testing
      staging:
        accountId: "staging"
        dmPolicy: "open"
        verbose: true  # Debug logging
      
      # Development - local testing
      development:
        accountId: "dev"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"  # Developer only
        verbose: true
```

### Example 4: Client Management

```yaml
# ~/.wopr/config.yaml
channels:
  whatsapp:
    accounts:
      # Client A
      client_a:
        accountId: "client-a"
        dmPolicy: "allowlist"
        allowFrom:
          - "+11112223333"  # Client A contacts
        authDir: "/secure/clients/a/whatsapp"
      
      # Client B
      client_b:
        accountId: "client-b"
        dmPolicy: "allowlist"
        allowFrom:
          - "+14445556666"  # Client B contacts
        authDir: "/secure/clients/b/whatsapp"
      
      # Internal
      internal:
        accountId: "internal"
        dmPolicy: "allowlist"
        allowFrom:
          - "+1234567890"  # Staff
```

---

## Best Practices

### Security

1. **Use descriptive account IDs**
   ```yaml
   # Good
   accountId: "acme-corp-support"
   
   # Bad
   accountId: "acc2"
   ```

2. **Separate credentials by sensitivity**
   ```yaml
   personal:
     dmPolicy: "allowlist"  # Very restrictive
   
   business:
     dmPolicy: "open"       # More permissive
   ```

3. **Use custom auth directories for isolation**
   ```yaml
   sensitive:
     accountId: "confidential"
     authDir: "/encrypted/whatsapp-confidential"
   ```

### Maintenance

1. **Regular backup script**
   ```bash
   #!/bin/bash
   # backup-whatsapp.sh
   for account in personal business; do
     tar czf "backup-$account-$(date +%Y%m%d).tar.gz" \
       ~/.wopr/credentials/whatsapp/$account
   done
   ```

2. **Monitor account health**
   ```bash
   # Check all accounts
   for account in personal business; do
     echo "Checking $account..."
     wopr channels status whatsapp --account $account
   done
   ```

3. **Rotate credentials periodically**
   - Logout and re-login every 3-6 months
   - Prevents unexpected session expiry

### Performance

1. **Limit number of accounts**
   - Each account uses memory/CPU
   - Recommended max: 5-10 accounts per instance
   - For more, consider multiple WOPR instances

2. **Use appropriate logging levels**
   ```yaml
   production:
     verbose: false  # Less disk I/O
   
   development:
     verbose: true   # Debug info
   ```

---

## Troubleshooting Multi-Account Issues

### "Account not found"

**Cause:** Account ID mismatch

**Solution:**
```bash
# List configured accounts
grep -A1 "accountId" ~/.wopr/config.yaml

# Use exact account ID
wopr channels login whatsapp --account exact-id
```

### Credentials mixed between accounts

**Cause:** Wrong auth directory configuration

**Solution:**
```yaml
# Ensure each account has unique authDir or unique accountId
account1:
  accountId: "acc1"  # Creates ~/.wopr/credentials/whatsapp/acc1

account2:
  accountId: "acc2"  # Creates ~/.wopr/credentials/whatsapp/acc2
```

### One account affects another

**Cause:** Shared configuration options

**Solution:**
Each account is independent - check for global settings overriding account settings.

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration options
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
- [SECURITY.md](./SECURITY.md) - Security considerations

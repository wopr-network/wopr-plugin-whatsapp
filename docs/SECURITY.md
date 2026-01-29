# Security Guide

> Security best practices for the WOPR WhatsApp Plugin

---

## Table of Contents

- [Overview](#overview)
- [Data Storage](#data-storage)
- [Access Control](#access-control)
- [Best Practices](#best-practices)
- [Threat Model](#threat-model)
- [Incident Response](#incident-response)
- [Compliance](#compliance)

---

## Overview

The WOPR WhatsApp Plugin handles sensitive credentials and messaging data. This guide covers security considerations and best practices.

### Security Philosophy

- **Local-first**: All credentials stored locally, never in cloud
- **Explicit access**: Default-deny for all incoming messages
- **Defense in depth**: Multiple layers of protection
- **Minimal privilege**: Only request necessary permissions

---

## Data Storage

### Credentials Storage

WhatsApp authentication credentials are stored in:

```
~/.wopr/credentials/whatsapp/<accountId>/
├── creds.json              # Encrypted auth tokens
├── creds.json.bak          # Automatic backup
└── app-state-sync/         # Session state
```

### What is Stored

| Data | Location | Encrypted | Notes |
|------|----------|-----------|-------|
| Auth tokens | `creds.json` | ✅ (by Baileys) | WhatsApp Web credentials |
| Session keys | `app-state-sync/` | ✅ | Message encryption keys |
| Config | `~/.wopr/config.yaml` | ❌ | YAML configuration |
| Logs | `~/.wopr/logs/` | ❌ | Activity logs |

### Automatic Backup

The plugin automatically creates backups:

- **Trigger**: Before credential updates
- **Location**: `creds.json.bak` in same directory
- **Restoration**: Automatic on corruption detection

### Securing Credentials

#### File Permissions

```bash
# Set secure permissions
chmod 700 ~/.wopr
chmod 700 ~/.wopr/credentials
chmod 700 ~/.wopr/credentials/whatsapp
chmod 600 ~/.wopr/credentials/whatsapp/*/creds.json

# Verify permissions
ls -la ~/.wopr/credentials/whatsapp/
# Should show: drwx------ for directories, -rw------- for files
```

#### Full Disk Encryption

Ensure your system uses full disk encryption:

- **macOS**: FileVault (enabled by default)
- **Windows**: BitLocker
- **Linux**: LUKS/dm-crypt

#### Encrypted Home Directory

For additional protection:

```bash
# Linux - encrypted home directory
# Use ecryptfs or similar

# macOS - encrypted disk image
hdiutil create -encryption -size 100m -volname "WOPR-Secure" -fs APFS secure.dmg
# Mount and store credentials there
```

---

## Access Control

### DM Policies

Control who can message your bot:

#### Recommended: Allowlist Mode

```yaml
channels:
  whatsapp:
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"  # Only these numbers can DM
```

**Security level:** ⭐⭐⭐⭐⭐ Highest

#### Blocklist Mode

```yaml
channels:
  whatsapp:
    dmPolicy: "blocklist"
    blockFrom:
      - "+19998887777"  # Block specific spammers
```

**Security level:** ⭐⭐⭐ Medium

#### Open Mode (Use with Caution)

```yaml
channels:
  whatsapp:
    dmPolicy: "open"  # Anyone can DM
```

**Security level:** ⭐ Low - Monitor usage closely

### Self-Chat Mode

**Critical for personal phone numbers:**

```yaml
channels:
  whatsapp:
    dmPolicy: "allowlist"
    allowFrom:
      - "+1234567890"
    selfChatMode: true       # ⭐ Enable this!
    ownerNumber: "+1234567890"
```

**What it prevents:**
- ❌ Accidental replies to friends/family
- ❌ Bot responding in group chats unexpectedly
- ❌ Unintended message exposure

### Group Security

Groups bypass DM policies (intentional design):

```yaml
# This only affects DMs, groups are always allowed
channels:
  whatsapp:
    dmPolicy: "disabled"  # DMs disabled
    # Groups still work!
```

**Group considerations:**
- Anyone in the group can trigger the bot
- Bot sees all group messages (respects `selfChatMode`)
- Use with trusted groups only

---

## Best Practices

### 1. Use Dedicated Phone Numbers

For production/business use:

```yaml
# ✅ Good - dedicated business number
business:
  accountId: "business"
  dmPolicy: "open"
  # No selfChatMode - this IS the dedicated bot number
```

```yaml
# ⚠️ Acceptable - personal number with protection
personal:
  accountId: "personal"
  dmPolicy: "allowlist"
  allowFrom: ["+1234567890"]
  selfChatMode: true
```

### 2. Verify Configuration

Before starting:

```bash
# Check current config (sanitized)
wopr channels config whatsapp

# Verify phone numbers in allowlist
grep -A10 "allowFrom" ~/.wopr/config.yaml
```

### 3. Monitor Logs

```bash
# Watch for unauthorized access attempts
tail -f ~/.wopr/logs/whatsapp-plugin.log | grep -i "blocked\|unauthorized"

# Check for unusual activity
wc -l ~/.wopr/logs/whatsapp-plugin.log  # Message volume
```

### 4. Regular Backups

```bash
#!/bin/bash
# secure-backup.sh

# Backup credentials
BACKUP_DIR="~/secure-backups/whatsapp-$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"
cp -r ~/.wopr/credentials/whatsapp "$BACKUP_DIR/"

# Encrypt backup
gpg --symmetric --cipher-algo AES256 "$BACKUP_DIR/whatsapp.tar.gz"

# Remove unencrypted
rm -rf "$BACKUP_DIR/whatsapp"
```

### 5. Keep Software Updated

```bash
# Update plugin
npm update wopr-plugin-whatsapp

# Update Baileys (peer dependency)
npm update @whiskeysockets/baileys

# Update WOPR
npm update -g wopr
```

### 6. Network Security

```bash
# Use firewall to restrict outgoing connections if needed
# WhatsApp Web uses:
# - web.whatsapp.com (HTTPS/443)
# - Various WhatsApp CDN endpoints
```

### 7. Secure Configuration Files

```yaml
# ~/.wopr/config.yaml
# Add to .gitignore if in a git repo!
# Never commit credentials
```

---

## Threat Model

### Threats Addressed

| Threat | Mitigation |
|--------|------------|
| Unauthorized access | DM policies, allowlists |
| Credential theft | Local storage, file permissions |
| Session hijacking | Baileys encryption |
| Accidental spam | Self-chat mode |
| Data loss | Automatic backup |
| Eavesdropping | WhatsApp E2E encryption |

### Threats NOT Addressed

| Threat | Mitigation Required |
|--------|---------------------|
| Phone compromise | Device security |
| WhatsApp account theft | 2FA on WhatsApp |
| Physical server access | Disk encryption |
| Memory dumps | Encrypted swap |
| Network sniffing | TLS (handled by WhatsApp) |

### Risk Assessment

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Personal use, self-chat, allowlist | Low | Default config |
| Business use, dedicated number | Low | DM policy monitoring |
| Personal use, open policy | High | Enable self-chat mode |
| Multi-account, shared server | Medium | Account isolation |

---

## Incident Response

### Suspicious Activity Detected

**If you notice unauthorized access:**

1. **Immediate response**
   ```bash
   # Stop the bot
   wopr daemon stop
   
   # Or logout immediately
   wopr channels logout whatsapp
   ```

2. **Revoke access**
   - Open WhatsApp on your phone
   - Settings → Linked Devices
   - Remove the WOPR device

3. **Investigate**
   ```bash
   # Check logs for suspicious activity
   grep -i "error\|unauthorized\|blocked" ~/.wopr/logs/whatsapp-plugin.log
   
   # Check last login time
   stat ~/.wopr/credentials/whatsapp/default/creds.json
   ```

4. **Reset credentials**
   ```bash
   # Clear all credentials
   rm -rf ~/.wopr/credentials/whatsapp/default/
   
   # Re-login with fresh session
   wopr channels login whatsapp
   ```

5. **Review configuration**
   ```bash
   # Check current policies
   cat ~/.wopr/config.yaml | grep -A5 "whatsapp"
   ```

### Credentials Compromised

**If credentials directory is accessed:**

1. Revoke all Linked Devices in WhatsApp
2. Delete credentials: `rm -rf ~/.wopr/credentials/whatsapp/`
3. Re-login to generate new credentials
4. Review and tighten DM policies
5. Check for unauthorized messages sent

### Data Breach Response

**If server is compromised:**

1. Revoke WhatsApp Web sessions (from phone)
2. Change WhatsApp 2FA PIN
3. Rotate all API keys
4. Review message history for unauthorized activity
5. File incident report if required by compliance

---

## Compliance

### GDPR Considerations

If operating in EU:

- **Message logs** may contain personal data
- **Right to erasure**: Delete logs on request
- **Data minimization**: Don't log more than necessary

```bash
# Delete specific user data
# (Requires manual log editing or custom script)
```

### Data Retention

Recommended retention periods:

| Data | Retention | Action |
|------|-----------|--------|
| Credentials | Until logout | Delete on account removal |
| Logs | 30 days | Rotate automatically |
| Backups | 7 days | Secure deletion |

### Audit Logging

Enable verbose logging for audit trail:

```yaml
channels:
  whatsapp:
    verbose: true  # Logs all connections
```

---

## Security Checklist

Before deploying to production:

- [ ] DM policy set to `allowlist` or `blocklist` (not `open`)
- [ ] `allowFrom` numbers verified and minimal
- [ ] `selfChatMode` enabled for personal numbers
- [ ] File permissions set correctly (600/700)
- [ ] Full disk encryption enabled
- [ ] Credentials directory backed up securely
- [ ] WhatsApp 2FA enabled on phone
- [ ] Logs monitored regularly
- [ ] Update process documented
- [ ] Incident response plan ready

---

## Reporting Security Issues

If you discover a security vulnerability:

1. **DO NOT** open a public GitHub issue
2. Email: security@wopr.dev (or project maintainer)
3. Include:
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration reference
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
- [MULTI_ACCOUNT.md](./MULTI_ACCOUNT.md) - Multi-number setup

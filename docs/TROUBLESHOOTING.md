# Troubleshooting Guide

> Common issues and solutions for the WOPR WhatsApp Plugin

---

## Table of Contents

- [QR Code Issues](#qr-code-issues)
- [Connection Problems](#connection-problems)
- [Message Delivery Issues](#message-delivery-issues)
- [Authentication Issues](#authentication-issues)
- [Performance Issues](#performance-issues)
- [Error Codes](#error-codes)
- [Getting Help](#getting-help)

---

## QR Code Issues

### QR Code Not Appearing

**Symptoms:**
- Terminal shows blank space where QR should be
- Only see text prompts but no QR code

**Solutions:**

1. **Check terminal width**
   ```bash
   # QR codes need at least 80 characters width
   stty size
   # Output: rows columns (e.g., 24 80)
   ```
   Resize terminal to be wider if needed.

2. **Enable verbose mode**
   ```bash
   wopr channels login whatsapp --verbose
   ```

3. **Try a different terminal**
   - iTerm2 (macOS) - Recommended
   - Windows Terminal (Windows)
   - GNOME Terminal / Konsole (Linux)
   - Avoid: Default Windows CMD, some VS Code terminals

4. **SSH/Remote sessions**
   ```bash
   # Ensure UTF-8 support
   export LANG=en_US.UTF-8
   export TERM=xterm-256color
   ```

### QR Code Scanning Fails

**Symptoms:**
- QR code appears but WhatsApp says "Couldn't scan code"
- Code scans but nothing happens
- "Invalid QR code" error

**Solutions:**

1. **Clean camera lens**
   - Smudges prevent scanning

2. **Improve lighting**
   - Too dark or too bright causes issues

3. **Adjust distance**
   - Hold phone 6-12 inches from screen

4. **Refresh QR code**
   ```bash
   # QR codes expire after ~20 seconds
   # Press Ctrl+C and login again for fresh code
   wopr channels login whatsapp
   ```

5. **Check WhatsApp version**
   - Update to latest WhatsApp version
   - Linked Devices feature required

### QR Code Too Small/Large

**Symptoms:**
- QR code is unreadable due to size
- Terminal text wraps breaking the QR pattern

**Solutions:**

1. **Zoom terminal**
   - macOS: `Cmd + +/-`
   - Windows/Linux: `Ctrl + +/-`

2. **Change terminal font**
   - Use monospace font (Consolas, Menlo, Fira Code)
   - Font size: 10-14pt optimal

3. **Maximize terminal window**
   - Fullscreen or large window mode

---

## Connection Problems

### "Connection Dropped" / "Disconnected"

**Symptoms:**
- Bot was working but stopped responding
- Log shows "connection closed"
- Status shows disconnected

**Solutions:**

1. **Simple reconnection**
   ```bash
   wopr channels login whatsapp
   ```
   WhatsApp Web sessions expire periodically and need re-linking.

2. **Check internet connection**
   ```bash
   ping web.whatsapp.com
   ```

3. **Restart WOPR daemon**
   ```bash
   wopr daemon restart
   ```

4. **Clear and reconnect**
   ```bash
   wopr channels logout whatsapp
   wopr channels login whatsapp
   ```

### "Logged Out" Error

**Symptoms:**
- Error message: "WhatsApp session logged out"
- Status code 401 or 403

**Causes:**
- Logged out from phone's Linked Devices
- Session expired
- Multiple logins from same account

**Solutions:**

1. **Re-link device**
   ```bash
   wopr channels logout whatsapp
   wopr channels login whatsapp
   ```

2. **Check Linked Devices on phone**
   - iOS: Settings → Linked Devices
   - Android: ⋮ Menu → Linked Devices
   - Look for and remove duplicate entries

### "Connection Timed Out"

**Symptoms:**
- Login hangs at "Waiting for connection"
- Timeout after 60 seconds

**Solutions:**

1. **Check firewall/proxy**
   ```bash
   # WhatsApp Web needs these ports
   # 443 (HTTPS)
   # 5222 (XMPP - sometimes used)
   ```

2. **Disable VPN temporarily**
   - Some VPNs block WhatsApp Web

3. **Check DNS resolution**
   ```bash
   nslookup web.whatsapp.com
   ```

### "Multi-Device Not Supported"

**Symptoms:**
- Error about multi-device beta
- Cannot link device

**Solutions:**

1. **Enable Multi-Device on phone**
   - WhatsApp → Settings → Linked Devices
   - Ensure "Multi-Device Beta" is enabled

2. **Update WhatsApp**
   - Multi-device is standard in newer versions

---

## Message Delivery Issues

### Messages Not Received by Bot

**Symptoms:**
- You send messages but bot doesn't respond
- No reaction emoji appears
- Logs don't show incoming messages

**Solutions:**

1. **Check DM policy**
   ```yaml
   # ~/.wopr/config.yaml
   channels:
     whatsapp:
       dmPolicy: "allowlist"
       allowFrom:
         - "+1234567890"  # Ensure your number is here
   ```

2. **Verify phone number format**
   - Must be E.164 format: `+1234567890`
   - No spaces, dashes, or parentheses

3. **Check group membership**
   - For groups, bot must be added to the group
   - Bot can't see messages before it joined

4. **Test with verbose logging**
   ```bash
   wopr channels login whatsapp --verbose
   # Check logs: ~/.wopr/logs/whatsapp-plugin.log
   ```

### Bot Not Responding in Groups

**Symptoms:**
- Works in DMs but not groups
- No reaction in groups

**Solutions:**

1. **Verify group membership**
   ```bash
   # Check if bot is in group
   wopr channels status whatsapp
   ```

2. **Check group privacy settings**
   - Group might restrict bot messages
   - Admin approval might be needed

3. **Re-add to group**
   - Remove bot from group
   - Add bot back

### Messages Sending but Not Delivering

**Symptoms:**
- Bot generates response
- Message appears sent but recipient doesn't receive it

**Solutions:**

1. **Check for blocks**
   - Recipient may have blocked the number
   - Check on phone: Settings → Account → Privacy → Blocked

2. **Check rate limits**
   - WhatsApp may rate-limit spam-like behavior
   - Wait 1-2 hours and retry

3. **Verify phone is online**
   - WhatsApp Web requires phone to be connected
   - Phone must have internet access

---

## Authentication Issues

### "Credentials Corrupted"

**Symptoms:**
- Error about invalid credentials
- Cannot start session
- Authentication fails repeatedly

**Solutions:**

1. **Automatic restore**
   The plugin automatically tries to restore from backup:
   ```
   ~/.wopr/credentials/whatsapp/default/creds.json.bak
   ```

2. **Manual restore**
   ```bash
   cd ~/.wopr/credentials/whatsapp/default
   cp creds.json.bak creds.json
   ```

3. **Fresh login**
   ```bash
   wopr channels logout whatsapp
   wopr channels login whatsapp
   ```

### "Authentication Failed"

**Symptoms:**
- Login fails with auth error
- Credentials rejected

**Solutions:**

1. **Clear credentials directory**
   ```bash
   rm -rf ~/.wopr/credentials/whatsapp/default/*
   wopr channels login whatsapp
   ```

2. **Check file permissions**
   ```bash
   ls -la ~/.wopr/credentials/whatsapp/default/
   # Should be readable by your user
   chmod -R 700 ~/.wopr/credentials/
   ```

3. **Check disk space**
   ```bash
   df -h ~/.wopr/
   ```

### "Already Logged In"

**Symptoms:**
- Cannot login, says already logged in
- But bot not responding

**Solutions:**

1. **Force logout**
   ```bash
   wopr channels logout whatsapp
   ```

2. **Kill existing session**
   ```bash
   # Find and kill WOPR processes
   pkill -f "wopr daemon"
   
   # Then logout and re-login
   wopr channels logout whatsapp
   wopr channels login whatsapp
   ```

---

## Performance Issues

### High Memory Usage

**Symptoms:**
- Node.js process using excessive RAM
- System slows down

**Solutions:**

1. **Enable verbose logging**
   Check for memory leaks in logs

2. **Restart periodically**
   ```bash
   # Add to crontab for daily restart
   0 4 * * * wopr daemon restart
   ```

3. **Limit history sync**
   ```yaml
   channels:
     whatsapp:
       # Already disabled by default
       # syncFullHistory: false
   ```

### Slow Response Times

**Symptoms:**
- Bot takes 10+ seconds to respond
- Reactions appear slowly

**Solutions:**

1. **Check AI provider latency**
   ```bash
   # WOPR processes messages through AI
   # Check AI provider status
   ```

2. **Reduce message complexity**
   - Very long prompts take longer
   - Break complex requests into smaller ones

3. **Check internet speed**
   ```bash
   speedtest-cli
   ```

### High CPU Usage

**Symptoms:**
- CPU usage constantly high
- Fans running loud

**Solutions:**

1. **Disable verbose logging**
   ```yaml
   channels:
     whatsapp:
       verbose: false
   ```

2. **Check for loops**
   - Bot might be in message loop
   - Check logs for repeated messages

---

## Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| 401 | Unauthorized/Logged out | Re-login with QR code |
| 403 | Forbidden | Check if blocked by WhatsApp |
| 404 | Not found | Check phone number format |
| 408 | Request timeout | Check internet connection |
| 428 | Precondition required | Update WhatsApp app |
| 440 | Connection closed | Reconnect |
| 500 | Server error | Wait and retry |
| 503 | Service unavailable | WhatsApp servers may be down |
| 515 | Session terminated | Re-login required |

---

## Getting Help

### Gather Debug Information

```bash
# 1. System info
uname -a
node --version
npm list wopr-plugin-whatsapp

# 2. WOPR config (remove sensitive info)
cat ~/.wopr/config.yaml | grep -v "password\|secret\|token"

# 3. Recent logs
tail -100 ~/.wopr/logs/whatsapp-plugin.log

# 4. Connection status
wopr channels status whatsapp

# 5. Process status
ps aux | grep wopr
```

### Support Channels

1. **GitHub Issues**: [wopr-plugin-whatsapp/issues](https://github.com/TSavo/wopr-plugin-whatsapp/issues)
2. **WOPR Discord**: Check #whatsapp-plugin channel
3. **Baileys Issues**: [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys/issues)

### Before Opening an Issue

1. Search existing issues
2. Include debug information (above)
3. Describe exact steps to reproduce
4. Include error messages (sanitized)
5. Note your environment (OS, Node version, etc.)

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration reference
- [SECURITY.md](./SECURITY.md) - Security considerations
- [MULTI_ACCOUNT.md](./MULTI_ACCOUNT.md) - Multi-number setup

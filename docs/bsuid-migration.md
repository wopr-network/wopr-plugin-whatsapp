# BSUID Migration Design Document

## Context

WhatsApp is rolling out usernames that will hide phone numbers by default, replacing
them with BSUID (Business-Scoped User ID) in webhook payloads. Test countries start
June 2026 with gradual expansion.

Reference: https://sanuker.com/whatsapp-api-2026_updates-pacing-limits-usernames/

This document audits `wopr-plugin-whatsapp` for phone-number-dependent code paths and
proposes a migration plan to support BSUID as the primary user identifier.

## Current Architecture

The plugin uses the Baileys library (`@whiskeysockets/baileys`) for WhatsApp Web
connectivity. Baileys uses JID (Jabber ID) format for user identification:

- Individual users: `<phone>@s.whatsapp.net`
- Groups: `<group-id>@g.us`
- Participants in groups: `<phone>@s.whatsapp.net`

The phone number is embedded in every JID and is the sole user identifier throughout
the plugin.

## Audit: Phone-Number-Dependent Code Paths

### 1. JID Construction — `toJid()` (src/index.ts:205-211)

```typescript
function toJid(phoneOrJid: string): string {
  if (phoneOrJid.includes("@")) return phoneOrJid;
  const normalized = phoneOrJid.replace(/[^0-9]/g, "");
  return `${normalized}@s.whatsapp.net`;
}
```

**Impact: HIGH** — This function assumes all non-JID inputs are phone numbers. It
strips everything except digits and appends the WhatsApp individual suffix. BSUIDs
are not numeric and would be destroyed by `replace(/[^0-9]/g, "")`.

**Migration:** Must detect whether input is a phone number or BSUID and construct
the appropriate JID format (once WhatsApp defines the BSUID JID suffix).

### 2. DM Policy / Allowlist — `isAllowed()` (src/index.ts:214-237)

```typescript
case "allowlist": {
  const allowed = config.allowFrom || [];
  if (allowed.includes("*")) return true;
  const phone = from.split("@")[0];
  return allowed.some(num => {
    const normalized = num.replace(/[^0-9]/g, "");
    return phone === normalized || phone.endsWith(normalized);
  });
}
```

**Impact: HIGH** — The allowlist is configured as phone numbers in E.164 format
(config field `allowFrom`). Matching logic extracts the phone portion from the JID
and compares against configured phone numbers. If `from` is a BSUID-based JID, the
extracted portion will not match any phone-number-based allowlist entry.

**Migration:** The allowlist must support both phone numbers and BSUIDs. A
BSUID-to-phone mapping (or vice versa) may be needed if admins continue to configure
allowlists by phone number.

### 3. Incoming Message Handling — `handleIncomingMessage()` (src/index.ts:259-339)

```typescript
const from = msg.key.remoteJid || "";
const participant = msg.key.participant || undefined;
const isGroup = from.endsWith("@g.us");
```

**Impact: MEDIUM** — `remoteJid` is assumed to be phone-based for DMs. Group
detection via `@g.us` suffix should remain stable. The `participant` field in group
messages is currently phone-based and may switch to BSUID.

**Migration:** Must handle the case where `remoteJid` contains a BSUID instead of a
phone number. Group detection logic is safe (suffix-based).

### 4. Sender Name Resolution (src/index.ts:281-288)

```typescript
if (participant) {
  const contact = contacts.get(participant);
  sender = contact?.notify || contact?.name || participant.split("@")[0];
} else {
  const contact = contacts.get(from);
  sender = contact?.notify || contact?.name || from.split("@")[0];
}
```

**Impact: MEDIUM** — Falls back to `split("@")[0]` which extracts the phone number
as a display name when no contact name is available. With BSUIDs, this fallback
would show a BSUID string instead of a phone number. Not broken, but the display
value changes.

**Migration:** Consider showing "Unknown User" or using the BSUID directly as
fallback. The contact object may still contain a display name.

### 5. Session Key Construction (src/index.ts:325)

```typescript
const sessionKey = `whatsapp-${from}`;
```

**Impact: HIGH** — Session continuity depends on this key. If a user's JID changes
from phone-based to BSUID-based, their conversation history will split into two
separate sessions. WOPR will treat them as a new user.

**Migration:** Need a session migration strategy. Either:
- Maintain a mapping of phone-JID to BSUID-JID and alias old sessions
- Use a stable internal user ID that maps to both JID formats

### 6. Outbound Messages — `sendMessageInternal()` (src/index.ts:387-401)

```typescript
async function sendMessageInternal(to: string, text: string): Promise<void> {
  const jid = toJid(to);
  // ...
  await socket.sendMessage(jid, content);
}
```

**Impact: HIGH** — Uses `toJid()` which will mangle BSUID inputs (see item 1).
All outbound messaging flows through this function.

**Migration:** Fix `toJid()` to handle BSUIDs.

### 7. Contact Map (src/index.ts:65, 486-489)

```typescript
let contacts: Map<string, Contact> = new Map();
// ...
sock.ev.on("contacts.upsert", (newContacts) => {
  for (const contact of newContacts) {
    contacts.set(contact.id, contact);
  }
});
```

**Impact: LOW-MEDIUM** — Keyed by `contact.id` which Baileys provides. If Baileys
updates `contact.id` to use BSUIDs, this will naturally transition. However, lookups
in sender resolution (item 4) use `from`/`participant` as keys, which must match.

**Migration:** Should work automatically if Baileys updates both the contact ID and
the message JID fields consistently. Monitor Baileys releases.

### 8. Configuration Fields (src/index.ts:102-114)

```typescript
{ name: "allowFrom", type: "array", label: "Allowed Numbers",
  placeholder: "+1234567890", description: "Phone numbers allowed to DM (E.164 format)" },
{ name: "ownerNumber", type: "text", label: "Owner Number",
  placeholder: "+1234567890", description: "Your phone number for self-chat mode" },
```

**Impact: MEDIUM** — Config schema labels, placeholders, and descriptions all
reference phone numbers. The `ownerNumber` field is used for self-chat mode to
identify the owner.

**Migration:** Config schema must support both formats. `ownerNumber` may need a
companion `ownerBsuid` field or auto-detection logic.

### 9. Pairing Requests (src/index.ts:57)

```typescript
pairingRequests?: Record<string, { code: string; name: string; requestedAt: number }>;
```

**Impact: LOW** — The key is likely used during device pairing. Pairing may still
use phone numbers since it is a device-linking flow.

**Migration:** Monitor WhatsApp API changes to pairing flow.

### 10. Channel Info ID (src/index.ts:313-317)

```typescript
const channelInfo: ChannelInfo = {
  type: "whatsapp",
  id: from,
  name: groupName || (isGroup ? "Group" : "WhatsApp DM"),
};
```

**Impact: MEDIUM** — `ChannelInfo.id` is set to the JID. Other WOPR subsystems
that key on this ID (logging, session routing, peer injection) will see a different
ID when it switches from phone-JID to BSUID-JID.

**Migration:** Downstream consumers of `ChannelInfo.id` must handle the format
change. Consider normalizing to a stable internal ID.

## Summary Table

| # | Code Path | Location | Impact | Phone Dependency |
|---|-----------|----------|--------|-----------------|
| 1 | `toJid()` | index.ts:205 | HIGH | Strips non-digits, assumes phone input |
| 2 | `isAllowed()` | index.ts:214 | HIGH | Allowlist matches on phone numbers |
| 3 | `handleIncomingMessage()` | index.ts:259 | MEDIUM | Uses `remoteJid` as user identity |
| 4 | Sender name fallback | index.ts:281 | MEDIUM | Falls back to phone from JID |
| 5 | Session key | index.ts:325 | HIGH | Session identity tied to phone-JID |
| 6 | `sendMessageInternal()` | index.ts:387 | HIGH | Routes through `toJid()` |
| 7 | Contact map | index.ts:65 | LOW-MEDIUM | Keyed by Baileys contact.id |
| 8 | Config fields | index.ts:102 | MEDIUM | Labels/values assume phone numbers |
| 9 | Pairing requests | index.ts:57 | LOW | Key format TBD |
| 10 | ChannelInfo.id | index.ts:313 | MEDIUM | Set to phone-based JID |

## Proposed Migration Design

### Phase 1: Abstraction Layer (Pre-BSUID, can start now)

Introduce a `UserIdentifier` abstraction that wraps the raw JID and provides
normalized access:

```typescript
interface UserIdentifier {
  /** The raw JID as received from Baileys */
  raw: string;
  /** The JID suffix (@s.whatsapp.net, @g.us, or future BSUID suffix) */
  type: "phone" | "group" | "bsuid";
  /** The local part before @ */
  localPart: string;
  /** Phone number if available (from JID or BSUID mapping) */
  phone?: string;
  /** BSUID if available */
  bsuid?: string;
}
```

This layer would:
- Parse any JID format into a structured identifier
- Provide `toJid()` replacement that handles both phone and BSUID formats
- Centralize all phone-number extraction logic

### Phase 2: Dual-Format Support (When BSUID format is published)

1. **Update `toJid()`** to detect and handle BSUID inputs without stripping
   non-digit characters.

2. **Update `isAllowed()`** to:
   - Accept both phone numbers and BSUIDs in the allowlist
   - Optionally resolve BSUID-to-phone for backward compatibility
   - Support a `*` wildcard that works regardless of ID format

3. **Update session key construction** to use a stable identifier:
   ```typescript
   const sessionKey = `whatsapp-${normalizeUserId(from)}`;
   ```
   Where `normalizeUserId` prefers BSUID when available, falls back to phone.

4. **Add session migration** to link old phone-based sessions to new BSUID-based
   sessions when the same user is seen with both identifiers during the transition
   period.

### Phase 3: Configuration Migration

1. Update config schema to accept BSUIDs alongside phone numbers in `allowFrom`.
2. Add `ownerBsuid` config field as an alternative to `ownerNumber`.
3. Update labels and descriptions to reference both formats.

### Phase 4: Baileys Dependency Tracking

The plugin depends on `@whiskeysockets/baileys` which implements the WhatsApp Web
protocol directly. BSUID support requires Baileys to update its protocol handling.

**Action items:**
- Watch `@whiskeysockets/baileys` releases for BSUID-related changes
- Track the JID format Baileys will use for BSUID users
- Test with Baileys beta releases when BSUID support lands
- Consider whether Baileys will provide a phone-to-BSUID mapping API

### Dependencies and Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Baileys does not support BSUID | Medium | Blocks migration | Monitor; consider alternative libraries |
| BSUID format not yet published | High (as of Feb 2026) | Cannot implement Phase 2 | Phase 1 abstraction is safe to start |
| Session continuity during rollout | High | Users lose conversation history | Session migration logic in Phase 2 |
| Mixed phone/BSUID in same group | High | Inconsistent participant IDs | Handle both formats in same group context |
| Config breaking change | Low | Admin reconfiguration needed | Backward-compatible config with dual support |

### Timeline Alignment

- **Now**: This audit document (Phase 0)
- **Q1 2026**: Phase 1 — Abstraction layer (safe, no behavioral change)
- **When BSUID format published**: Phase 2 — Dual-format support
- **June 2026 (test countries)**: Phase 3 — Config migration, testing with real BSUIDs
- **Post-rollout**: Phase 4 — Deprecate phone-only paths once BSUID is universal

# Data storage

## Workers KV (`MEETING_CACHE`)

| Key pattern | Purpose | Retention |
|---|---|---|
| `meeting:{id}:meta` | Creator identity, title, creation time | Persistent |
| `meeting:{id}:participants` | Participant names and identity addresses | Persistent |
| `meeting:{id}:recordings` | Verified R2 recording-reference cache | Persistent, refreshed |
| `meeting:{id}:session:{sid}:result` | Transcript and current summary | Persistent |
| `meeting:{id}:session:{sid}:history` | Summary versions | Persistent |
| `meeting:{id}:session:{sid}:partial` | Transcript checkpoint | Until superseded |
| `meeting:{id}:session:{sid}:email-sent` | Delivery de-duplication marker | Persistent |
| `meeting:{id}:session:{sid}:email-failed` | Last delivery failure | 90 days |
| `meeting:{id}:prompt` | Meeting-specific prompt | Persistent |
| `user:{identity}:meetings` | Meeting index for one identity | Persistent |
| `user:{identity}:prompt` | Default identity prompt | Persistent |
| `meeting:{id}:lock:*` | Short-lived pipeline locks | 90–120 seconds |
| `ratelimit:{ip}` | Fixed-window rate counter | Window length |

KV is eventually consistent. It is suitable for derived meeting state and soft rate limits, not payment balances or strict quotas. Billing-grade counters are planned for D1.

## R2 (`RECORDINGS_BUCKET`)

Canonical recording keys use:

```text
<meetingId>/<sessionId>/composite.mp3
```

Legacy deployments may also contain meeting-level or flat timestamped keys. The R2 object is the durable media source of truth. KV stores only a verified reference cache.

No automatic retention policy is imposed by the application. Operators must choose a retention period appropriate for consent, privacy, cost, and applicable law.

## RealtimeKit

RealtimeKit owns active meeting state, participant sessions, and temporary recording/transcript URLs. Do not rely on those URLs for long-term storage. Copy required media to R2 promptly.

## Browser storage

| Key | Store | Purpose |
|---|---|---|
| `ve_rooom_identity` | `localStorage` | Persistent pseudonymous UUID and display name |
| `rtk_token_<roomId>` | `sessionStorage` | Per-tab RealtimeKit participant token |

The local identity token is not a password or strong credential. Browser storage can be read by scripts executing in the same origin, so maintain strict dependency and XSS hygiene.

## Optional external services

- An external PocketBase gateway may validate OAuth identities when `FORMSDB_URL` is set.
- Resend or a custom SMTP API may deliver summaries.
- Gemini, OpenRouter, and Ollama may process transcript text when configured.

Operators are responsible for disclosing those processors and configuring data retention appropriately.

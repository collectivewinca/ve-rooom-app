# User flows

## First visit

1. The browser creates a random local UUID and stores it in `localStorage` under `ve_rooom_identity`.
2. The user enters a display name.
3. The display name is attached to the existing UUID; it does not create an account at an external service.

Resetting the local identity creates a new UUID and disconnects the browser from meeting indexes associated with the old ID.

## Create a meeting

1. Enter a display name and optional title.
2. The client calls `POST /api/rooms` with the local identity token.
3. The Worker creates the RealtimeKit meeting and host participant.
4. Metadata and the identity-to-meeting index are written to KV.
5. The RealtimeKit participant token is stored in `sessionStorage` and the browser opens `/meeting/:id`.

## Join a meeting

1. Open a shared URL containing the meeting ID.
2. Enter a display name.
3. The Worker creates a RealtimeKit participant and indexes the meeting for the local identity.
4. The browser joins with the returned participant token.

## Recording

The client requests recording shortly after joining. The Worker first lists existing recordings and returns the active one when present, preventing multiple participants from starting duplicate composite recordings.

When the meeting ends, RealtimeKit emits events to `/api/webhook`. The Worker copies available audio to R2 and starts transcription/summary processing.

## Summary and downloads

`/summary/:id` resolves the latest ended session, checks KV for a cached transcript/summary, reconciles recording references with R2, and returns a status the client can poll. Recording playback uses a ranged R2 proxy so browser seeking works.

## Dashboard

The dashboard sends the current identity token to `/api/meetings`. The Worker joins RealtimeKit meeting/session data with KV metadata and returns only meetings created or joined by that identity. Emails listed in `ADMIN_EMAILS` may view all meetings when external authentication is enabled.

## Failure paths

| Failure | Behavior |
|---|---|
| RealtimeKit media URL expired | The temporary URL is omitted; a verified R2 copy is used when available |
| R2 object missing/unreadable | No broken download is advertised; reconciliation can be retried |
| Empty transcript | Session is marked silent/no-summary rather than polled forever |
| Summary provider fails | The next configured provider is tried |
| Email provider absent | Meeting processing succeeds; delivery failure is recorded separately |
| Invalid webhook URL or meeting ID | Request is rejected before fetch or storage access |

# Recordings

VE Rooom runs **two recording types concurrently** for every meeting: composite (mixed video+audio) and track (per-participant audio). Both auto-start 5 seconds after the meeting becomes ready, with server-side dedup to prevent duplicate recordings when multiple participants join.

## Recording Types

| Type | Endpoint | Output | Use Case |
|---|---|---|---|
| Composite | `POST /recordings` | `.mp4` (video+audio) + `.mp3` (audio-only) | Full meeting playback, mixed audio for transcription |
| Track | `POST /recordings/track` | `.webm` per participant (audio-only) | Per-speaker transcription without diarization |

## Composite Recording

**File:** `functions/api/recordings/start.ts`

### Request Body (to CF API)
```json
{
  "meeting_id": "bbbf4706-...",
  "allow_multiple_recordings": true,
  "realtimekit_bucket_config": {
    "upload_prefix": "ve-rooom"
  },
  "audio_config": {
    "codec": "MP3",
    "export_file": true
  }
}
```

### Response
```json
{
  "recordingId": "fff3c771-...",
  "status": "RECORDING",
  "type": "composite"
}
```

### Download URLs (when `status: "UPLOADED"`)
- `download_url` — string URL to `.mp4` (R2 signed, 7-day expiry)
- `audio_download_url` — string URL to `.mp3` (R2 signed, 7-day expiry)

## Track Recording (legacy — no longer started)

> **Removed from the app in commit `2ccc1f8`** ("remove track recording, add R2
> long-term recording storage"). The endpoint `POST /api/recordings/track` no
> longer exists, and the app now starts only the **composite** recording. The
> 10 WebM files still visible in RealtimeKit all date from July 2026, before
> the removal. The schema below is kept for reference (it is the only
> documentation of the `TRACK` output shape).

**File:** `functions/api/recordings/track.ts`

### Request Body (to CF API)
```json
{
  "meeting_id": "bbbf4706-...",
  "layers": {
    "default": {
      "file_name_prefix": "participant",
      "outputs": [
        {
          "type": "REALTIMEKIT_BUCKET"
        }
      ]
    }
  }
}
```

### ⚠️ API Schema Quirks

The CF docs say `layers` is **optional** and only shows `file_name_prefix` + `media_kind`. In practice:

1. **`layers` is required** — omitting it returns `422: "layers" is required`
2. **`layers.default.outputs` is required** — must be an array
3. **`outputs[0].type` is required** — must be one of: `REALTIMEKIT_BUCKET`, `DYTE_BUCKET`, `STORAGE_CONFIG`, `RTMP_OUT`, `WEBSOCKET`
4. **`layers.default.media_kind` is NOT allowed** — including it returns `422: "layers.default.media_kind" is not allowed` (track recording is audio-only by default)
5. **`file_name_prefix` is optional** — defaults to `"default"`

### `storage_config` (external bucket transfer)

Verified against the RealtimeKit API on **2026‑10‑27**:

| Endpoint | Behaviour of `storage_config` |
|---|---|
| `POST /meetings` | **Accepted but ignored.** A create with `storage_config.type: "bogus"` returns `201` and creates the meeting — there is no enum validation and no 400 risk. `rooms.ts` therefore omits it because it would have no effect, not because it would be rejected. |
| `POST /recordings` | **Honoured.** `type: "cloudflare"` (R2) is accepted with `access_key`, `secret`, `bucket`, `path`, `account_id`. Bad credentials do not fail the request — the upload fails afterwards with `[ERROR:0003] Recording failed to upload to external bucket`. |

Consequences for this project:

- External-bucket transfer needs an Account R2 API token (dashboard → R2 → Manage R2 API Tokens) and the Cloudflare account ID. Credentials must never be committed to source.
- Credentials live in Worker secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (default `ve-rooom-recordings`), and `R2_ACCOUNT_ID` (defaults to `CF_ACCOUNT_ID`). Without them, `recordings/start.ts` omits `storage_config`; the webhook remains the primary durable-copy path.
- `realtimekit_bucket_config.enabled: true` must stay enabled either way: the webhook copies from RTK's bucket using RTK's 7-day download URL.
- **`[ERROR:0003]` can come from RealtimeKit's app-level external-bucket configuration.** Diagnose the dashboard bucket configuration separately from the per-recording request. The webhook copy is the primary path and makes native transfer optional.

### Response
```json
{
  "recordingId": "fffe1f82-...",
  "status": "INVOKED",
  "type": "TRACK"
}
```

### Track File Format

Filename: `{{file_name_prefix}}_{{user_id}}_{{peer_id}}_{{stream_kind}}_{{media_kind}}_{{date_time}}.webm`

Example: `participant_aaa708b8-1488-4344-9a08-186457e6908f_0c2dd5dd-137d-4da4-88c0-c83b607c44ec_peer_media_kind_audio_1783406002832.webm`

Parsed fields:
- `file_name_prefix` — `"participant"` (our custom prefix)
- `user_id` — RealtimeKit user UUID
- `peer_id` — Peer connection UUID
- `stream_kind` — `"peer"`
- `media_kind` — `"audio"` (video track recording is in development)
- `date_time` — Unix timestamp in milliseconds

### Download URL Structure (when `status: "UPLOADED"`)

**Unlike composite, `download_url` is an ARRAY for track recordings:**

```json
{
  "download_url": [
    {
      "layer_name": "default",
      "download_urls": {
        "participant_aaa708b8-..._audio_1783406002832.webm": {
          "download_url": "https://storage.googleapis.com/..."
        }
      }
    }
  ]
}
```

Each participant gets one `.webm` file. Multiple participants = multiple entries in `download_urls`.

## Server-Side Dedup

Both recording endpoints check for existing active recordings before starting new ones:

### Composite Dedup (`recordings/start.ts`)
```typescript
const activeComposite = recordings.find(
  (r) => (r.status === "INVOKED" || r.status === "RECORDING") && typeof r.download_url === "string"
);
if (activeComposite) {
  return { alreadyStarted: true, status: activeComposite.status };
}
```

### Track Dedup (legacy — `recordings/track.ts`, removed)
```typescript
const activeTrack = recordings.find(
  (r) =>
    (r.status === "INVOKED" || r.status === "RECORDING") &&
    (r.type === "TRACK" || (r.output_file_name || "").endsWith(".webm"))
);
if (activeTrack) {
  return { alreadyStarted: true, recordingId: activeTrack.id, status: activeTrack.status };
}
```

### Why dedup by `.webm` extension?

The CF list recordings endpoint (`GET /recordings?meeting_id=`) returns `type` as an **empty string** for all recordings — not `"TRACK"` as documented. The only reliable way to identify track recordings is by checking `output_file_name` for `.webm` extension, or checking if `download_url` is an array (composite = string, track = array).

## Auto-Start Flow

**File:** `src/pages/Meeting.tsx`

```
Meeting ready (RtkMeeting rendered)
        │
        ▼
5s setTimeout (meetingRef pattern, survives StrictMode double-mount)
        │
        ├──→ POST /api/recordings/start { meetingId, authToken }
        │    ← { recordingId, status } or { alreadyStarted: true }
        │
        └──→ POST /api/recordings/track { meetingId, authToken }
             ← { recordingId, status, type: "TRACK" } or { alreadyStarted: true }
        │
        ▼
Recording indicator shows (red pulsing dot + "Recording..." text)
```

### Why `record_on_start: false` in rooms.ts?

CF's built-in `record_on_start: true` starts recording immediately when the first participant joins. We set it to `false` and manually start recordings 5s after join because:

1. **Server-side dedup** — If 5 participants join, we only want 1 composite + 1 track recording, not 5
2. **`allow_multiple_recordings: true`** — Needed to run composite + track concurrently
3. **Control over timing** — 5s delay ensures the meeting UI is fully loaded before recording

## Track File Duration vs Composite Duration

Track files are **time-aligned to the meeting start** (silence is preserved, not concatenated speech). However, track files may be **shorter** than the composite recording:

- **Composite**: Records continuously from start to stop (full meeting duration)
- **Track**: Records per-participant — if a participant leaves early, their WebM file ends when they leave

Example from test meeting:
- Composite: 209s (full meeting)
- Track: 137s (participant left at ~137s)

This is correct behavior. For transcript merging, each track's timestamps are relative to the meeting start, so they can be aligned with the composite timeline.

## Storage & Expiry

- **Composite**: R2 bucket (`rtk-prod-recording.*.r2.cloudflarestorage.com`), 7-day signed URLs
- **Track**: GCS bucket (`storage.googleapis.com/prod-iad-dyte-gcp-streamline/...`), 7-day signed URLs
- **No deletion API** — recordings auto-expire after 7 days
- **`file_size` is 0 for track recordings** in the API response (CF quirk — actual size is in the storage bucket but not reflected in the API)

## API Response Shape Differences

| Field | Composite | Track |
|---|---|---|
| `download_url` | string (MP4 URL) | array of `{ layer_name, download_urls }` |
| `audio_download_url` | string (MP3 URL) | empty |
| `file_size` | actual bytes | always `0` |
| `type` | empty string | empty string (not `"TRACK"`) |
| `output_file_name` | `{meetingId}_{timestamp}.mp4` | `{{prefix}}_{{user_id}}_..._audio_{{timestamp}}.webm` |

## SDK Version Requirements

Track recording (`user_ids` for specific participants) requires:
- Web Core: `@cloudflare/realtimekit` 1.4.0+
- React UI Kit: `@cloudflare/realtimekit-react-ui` 1.1.2+

We record all participants (no `user_ids` filter), so SDK version is not a constraint.

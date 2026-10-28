# Cloudflare RealtimeKit — Overview & Integration

## What is RealtimeKit?

Cloudflare RealtimeKit (RTK) is a managed, serverless platform for building real-time audio/video applications. It provides everything needed for video conferencing without managing WebRTC infrastructure, SFU servers, or media pipelines:

| Component | Managed by RealtimeKit |
|---|---|
| SFU (Selective Forwarding Unit) | Routes audio/video/screen-share between participants, scales to multiple participants |
| Composite Recording | Mixed MP4 video + separate MP3 audio, stored in Cloudflare R2 |
| Track Recording (legacy) | Per-participant WebM audio files — **no longer started by the app** since `2ccc1f8` |
| Transcription | Batch via Whisper Large v3 Turbo (~46 Neurons/min); live via Deepgram Nova-3 WebSocket (~836 Neurons/min) |
| Summary | Built-in AI summary engine (optional, can be overridden by external LLMs) |
| Authentication | Per-participant scoped tokens with role-based presets |
| Storage | Recordings and transcripts auto-expire from R2 after 7 days |

It is accessed via a REST API at:
```
https://api.cloudflare.com/client/v4/accounts/{account_id}/realtime/kit/{app_id}/...
```

---

## Free vs Paid Limits

RealtimeKit is currently in **open beta** — there is no separate pricing for RealtimeKit itself. It runs on Cloudflare's global network and uses underlying Cloudflare services that have their own free and paid tiers:

| Resource | Free Tier | Paid (Pro/Business) |
|---|---|---|---|
| **RealtimeKit API calls** | Unlimited (beta) | Unlimited |
| **Simultaneous meetings** | Unlimited (beta) | Unlimited |
| **Participants per meeting** | Limited by Workers AI transcription queue (beta) | No documented limit |
| **Recording storage** | Up to 7 days in R2 (auto-expires) | Up to 7 days in R2 (auto-expires) |
| **Workers AI (Whisper batch)** | ~46 Neurons/min; **10,000 Neurons/day** free → **~215 min/day (3.6 hr)** | $0.011 / 1,000 additional Neurons ($0.00051/audio-min) |
| **Workers AI (Deepgram live)** | ~836 Neurons/min (WebSocket); **10,000 Neurons/day** free → **~12 min/day** | $0.011 / 1,000 additional Neurons ($0.0092/audio-min) |
| **Cloudflare Workers** | Consult the current Workers pricing page | Paid Workers plan (higher limits) |
| **Workers Static Assets** | Consult current Workers pricing and limits | Included with the Worker deployment |
| **Storage (R2)** | 10 GB/month free | $0.015/GB/month |

**Practical limit for MVP:** The free tier is generous for batch transcription (~3.6 hr/day via Whisper), but live/real-time transcription (Deepgram WebSocket via RealtimeKit) is much more expensive — only ~12 minutes/day on the free tier. This app uses batch (post-meeting) transcription, so the Whisper limit applies.

## How VE Rooom Uses RealtimeKit

VE Rooom integrates RealtimeKit at three levels:

1. **Frontend React hooks** (`@cloudflare/realtimekit-react`) — initialize meeting client, join the video room
2. **Frontend UI component** (`@cloudflare/realtimekit-react-ui`) — render the full video conferencing interface
3. **Backend REST API** (Cloudflare Worker) — create meetings, add participants, retrieve sessions/transcripts/recordings

---

## 1. Backend REST API Integration

All RealtimeKit administrative API calls go through the Cloudflare Worker so the `CF_API_TOKEN` stays server-side. The frontend never receives it.

### Authentication

Every API request includes:
```
Authorization: Bearer {CF_API_TOKEN}
Content-Type: application/json
```

### Environment Variables

| Variable | Value |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account UUID (the id in the Cloudflare dashboard URL) |
| `CF_API_TOKEN` | Cloudflare API token with **Realtime admin + Workers AI:Run** permissions |
| `RTK_APP_ID` | RealtimeKit app UUID (e.g., `REDACTED_RTK_APP_ID`) |

### Endpoints Used

#### POST `/meetings` — Create a meeting

Called by `functions/api/rooms.ts` when a user clicks "New Meeting".

```json
// Request body
{
  "title": "Weekly Standup",
  "record_on_start": false,
  "transcribe_on_end": true,
  "summarize_on_end": true,
  "ai_config": {
    "transcription": { "language": "en" },
    "summarization": {
      "summary_type": "general",
      "text_format": "markdown",
      "word_limit": 500
    }
  }
}

// Response
{
  "success": true,
  "data": { "id": "meeting-uuid" }
}
```

Key fields:
- `record_on_start: false` — Recording is started manually 5s after join via `POST /recordings` (enables server-side dedup). The track-recording call that used to sit next to it was removed in `2ccc1f8`.
- `transcribe_on_end` — Whisper processes audio into a CSV transcript after the session ends
- `summarize_on_end` — CF built-in summary (overridden by OpenRouter/Ollama, but setting it ensures a fallback exists)
- `language: "en"` — NOT `"en-US"` (CF docs example uses `"en"`)

#### POST `/meetings/{id}/participants` — Add a participant

Called by `functions/api/rooms.ts` (host) and `functions/api/rooms/[id]/participants.ts` (joiners).

```json
// Request body
{
  "name": "Alice",
  "preset_name": "group_call_host",
  "custom_participant_id": "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  "success": true,
  "data": { "token": "eyJhbGciOiJIUzI1NiIs..." }
}
```

The returned `token` is a JWT that the frontend passes to `useRealtimeKitClient()` to authenticate the participant's WebRTC connection.

**Preset names used:**
- `group_call_host` — Full permissions (can share screen, mute others, etc.)
- `group_call_participant` — Standard participant permissions

**`custom_participant_id`** is required. A UUID v4 is generated server-side via `crypto.randomUUID()`.

#### GET `/sessions?meeting_id={id}` — Find ended sessions

Called by `functions/api/summary/[id].ts` to locate the session after a meeting ends.

```json
// Response
{
  "success": true,
  "data": {
    "sessions": [
      {
        "id": "session-uuid",
        "associated_id": "meeting-uuid",
        "status": "ENDED",
        "recording_status": "COMPLETE"
      }
    ]
  }
}
```

The function filters for `associated_id === meetingId` and `status === "ENDED"`. If no ended session exists, it returns `"no_ended_session"` and the frontend will poll again.

#### GET `/sessions/{id}/transcript` — Get transcript download URL

Called by `functions/api/summary/[id].ts` to get the Whisper-generated transcript.

```json
// Response
{
  "success": true,
  "data": {
    "transcript_download_url": "https://r2-bucket-url/transcript.csv?...",
    "transcript_download_url_expiry": "2024-09-08T12:00:00Z"
  }
}
```

**Important:** The field is `transcript_download_url` (snake_case), NOT `downloadUrl` (camelCase). The code handles both for safety.

The transcript is a CSV file with speaker segments. The function downloads this file and passes the full text to Ollama Cloud for summarization.

#### GET `/sessions/{id}/summary` — CF built-in summary (fallback)

Called when Ollama Cloud is not configured or fails. Returns CF's own summary.

```json
// Response
{
  "success": true,
  "data": { "summary": "Markdown summary text..." }
}
```

#### GET `/recordings?meeting_id={id}` — Get recording download URLs

Called by `functions/api/summary/[id].ts` to provide downloadable MP4, MP3, and per-participant WebM links on the Summary page.

**Composite recording response:**
```json
{
  "success": true,
  "data": [
    {
      "meeting_id": "meeting-uuid",
      "download_url": "https://r2-bucket-url/recording.mp4?...",
      "audio_download_url": "https://r2-bucket-url/recording.mp3?...",
      "status": "UPLOADED",
      "output_file_name": "meetingId_timestamp.mp4",
      "file_size": 20212537
    }
  ]
}
```

**Track recording response (different `download_url` shape):**
```json
{
  "success": true,
  "data": [
    {
      "meeting_id": "meeting-uuid",
      "download_url": [
        {
          "layer_name": "default",
          "download_urls": {
            "participant_userId_peerId_..._audio_timestamp.webm": {
              "download_url": "https://storage.googleapis.com/..."
            }
          }
        }
      ],
      "status": "UPLOADED",
      "output_file_name": "{{prefix}}_{{user_id}}_{{peer_id}}_..._audio_{{timestamp}}.webm",
      "file_size": 0
    }
  ]
}
```

**⚠️ The `type` field is always empty string in list response** — identify track recordings by `.webm` extension in `output_file_name` or by `Array.isArray(download_url)`.

#### POST `/recordings` — Start composite recording

Called by `functions/api/recordings/start.ts` 5s after meeting ready.

```json
// Request body
{
  "meeting_id": "meeting-uuid",
  "allow_multiple_recordings": true,
  "realtimekit_bucket_config": { "upload_prefix": "ve-rooom" },
  "audio_config": { "codec": "MP3", "export_file": true }
}

// Response
{
  "success": true,
  "data": {
    "recording": {
      "id": "recording-uuid",
      "status": "RECORDING"
    }
  }
}
```

#### POST `/recordings/track` — Start track recording (per-participant) *(legacy: endpoint removed in `2ccc1f8`)*

Was called by `functions/api/recordings/track.ts` 5s after meeting ready; that file was removed in `2ccc1f8`.

```json
// Request body
{
  "meeting_id": "meeting-uuid",
  "layers": {
    "default": {
      "file_name_prefix": "participant",
      "outputs": [
        { "type": "REALTIMEKIT_BUCKET" }
      ]
    }
  }
}

// Response (note: data.id, NOT data.recording.id)
{
  "success": true,
  "data": {
    "id": "recording-uuid",
    "status": "INVOKED",
    "output_file_name": "{{prefix}}_{{user_id}}_..._audio_{{timestamp}}.webm"
  }
}
```

**⚠️ Track recording API schema quirks** (docs say optional, API requires):
1. `layers` is **required** (422 if omitted)
2. `layers.default.outputs` is **required** (422 if omitted)
3. `outputs` must be an **array** (422 if object)
4. `outputs[0].type` is **required** — one of: `REALTIMEKIT_BUCKET`, `DYTE_BUCKET`, `STORAGE_CONFIG`, `RTMP_OUT`, `WEBSOCKET`
5. `layers.default.media_kind` is **NOT allowed** (422 if included — track recording is audio-only by default)
6. Response shape is `data.id`, not `data.recording.id` (unlike composite)

#### GET `/meetings` — List all meetings

Called by `functions/api/meetings.ts` for the Dashboard view.

```json
// Response
{
  "success": true,
  "data": [
    {
      "id": "meeting-uuid",
      "title": "Weekly Standup",
      "status": "ACTIVE",
      "created_at": "2024-09-01T12:00:00Z",
      "record_on_start": true,
      "transcribe_on_end": true,
      "summarize_on_end": true
    }
  ]
}
```

---

## 2. Frontend React Integration

### Packages

| Package | Version | Exports Used |
|---|---|---|
| `@cloudflare/realtimekit-react` | ^2.0.0 | `RealtimeKitProvider`, `useRealtimeKitClient`, `useRealtimeKitMeeting` |
| `@cloudflare/realtimekit-react-ui` | ^2.0.0 | `<RtkMeeting>` Web Component |

### Meeting Flow (in `src/pages/Meeting.tsx`)

```tsx
import { RealtimeKitProvider, useRealtimeKitClient, useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
```

**Step 1 — Initialize the client:**
```tsx
const [meeting, initMeeting] = useRealtimeKitClient();
```

`useRealtimeKitClient()` returns a tuple: `[meetingObject, initFunction]`.

- Initially `meeting` is `undefined`
- Call `initMeeting({ authToken })` with the token received from the server
- Once resolved, `meeting` becomes the active meeting object

**Step 2 — Provide the meeting context:**
```tsx
<RealtimeKitProvider value={meeting}>
  <MeetingView roomId={roomId!} />
</RealtimeKitProvider>
```

`RealtimeKitProvider` makes the meeting object available to child components via React context.

**Step 3 — Render the video UI:**
```tsx
const { meeting } = useRealtimeKitMeeting();

<RtkMeeting
  mode="fill"
  meeting={meeting}
  showSetupScreen={true}
/>
```

`<RtkMeeting>` is a Web Component (not a pure React component) that renders the full video conference interface:
- Camera and microphone selection
- Participant video grid
- Screen sharing
- In-call controls (mute, hang up, etc.)

**Step 4 — Overlay controls:**
The app adds custom overlay buttons on top of `<RtkMeeting>`:
- **Copy Join Link** — Copies `/?room=<roomId>` to clipboard so the host can share it
- **Summary** — Navigates to `/summary/<roomId>` for post-meeting results

### Loading & Error States

```tsx
// No auth token — show error
if (!authToken) return <div>Missing auth token...</div>;

// Meeting not yet initialized — show spinner
if (!meeting) return <div className="spinner" />;

// Meeting ready — render the provider + UI
return <RealtimeKitProvider value={meeting}>...</RealtimeKitProvider>;
```

---

## 3. Complete Data Flow

### Meeting Creation
```
User clicks "New Meeting"
    │
    ▼
POST /api/rooms (name, roomTitle)
    │
    ├── Identity: verifyAuthToken(token) → local UUID or configured provider
    │
    ├── POST /realtime/kit/{app}/meetings
    │   { record_on_start, transcribe_on_end, summarize_on_end, ai_config, recording_config }
    │   ← { id: meetingId }
    │
    ├── POST /realtime/kit/{app}/meetings/{meetingId}/participants
    │   { name, preset_name: "group_call_host", custom_participant_id: uuid }
    │   ← { token: authToken }
    │
    └── Response: { roomId, authToken }
            │
            ▼
    /meeting/{roomId}?authToken=...
            │
            ▼
    useRealtimeKitClient({ authToken })
        → meeting initialized
        → <RealtimeKitProvider value={meeting}>
        → <RtkMeeting meeting={meeting}>
```

### Joining a Meeting
```
User enters room ID + name
    │
    ▼
POST /api/rooms/{roomId}/participants (name)
    │
    ├── Identity: verifyAuthToken(token) → local UUID or configured provider
    │
    ├── POST /realtime/kit/{app}/meetings/{roomId}/participants
    │   { name, preset_name: "group_call_host", custom_participant_id: uuid }
    │   ← { token: authToken }
    │
    └── Response: { authToken }
```

### Post-Meeting Summary
```
User visits /summary/{roomId}
    │
    ▼
GET /api/summary/{roomId}  (polled every 5s up to 5 min)
    │
    ├── GET /realtime/kit/{app}/sessions?meeting_id={roomId}
    │   ← Filter for status=ENDED, associated_id=roomId
    │
    ├── GET /realtime/kit/{app}/sessions/{sessionId}/transcript
    │   ← { transcript_download_url }
    │
    ├── Download CSV transcript from R2 presigned URL
    │
    ├── If transcript empty → return "no speech" summary
    │
    ├── Call Ollama Cloud API with transcript + system prompt
    │   ← { message: { content: summary } }
    │   (Falls back to GET /sessions/{id}/summary if Ollama fails)
    │
    ├── GET /realtime/kit/{app}/recordings?meeting_id={roomId}
    │   ← { download_url, audio_download_url }
    │
    └── Response: { status, summary, transcriptUrl, recordingUrl, audioRecordingUrl }
```

---

## API Reference Summary

| Method | Endpoint | Purpose | Called From |
|---|---|---|---|
| POST | `/meetings` | Create meeting with recording/transcription/summary config | `rooms.ts` |
| GET | `/meetings` | List all meetings | `meetings.ts` |
| POST | `/meetings/{id}/participants` | Add participant → returns auth JWT | `rooms.ts`, `participants.ts` |
| GET | `/sessions?meeting_id={id}` | Find ended sessions for a meeting | `summary/[id].ts` |
| GET | `/sessions/{id}/transcript` | Get transcript download URL | `summary/[id].ts` |
| GET | `/sessions/{id}/summary` | Get CF built-in summary (fallback) | `summary/[id].ts` |
| GET | `/recordings?meeting_id={id}` | Get recording download URLs (composite + track) | `summary/[id].ts` |
| POST | `/recordings` | Start composite recording (dedup + allow_multiple) | `recordings/start.ts` |
| POST | `/recordings/track` | Start track recording (per-participant WebM) — *legacy, removed in `2ccc1f8`* | `recordings/track.ts` (deleted) |
| PUT | `/recordings/{id}` | Stop/pause/resume recording | (not used yet) |

---

## Important Field Names

The RealtimeKit API uses inconsistent naming conventions. Notable fields:

| API Field | Type | Notes |
|---|---|---|
| `transcript_download_url` | string | snake_case — NOT `downloadUrl` |
| `transcript_download_url_expiry` | string | Expiration timestamp for the presigned URL |
| `download_url` | string or array | Composite: string MP4 URL; Track: array of `{ layer_name, download_urls }` |
| `audio_download_url` | string | Recording MP3 audio-only URL (composite only) |
| `associated_id` | string | Meeting ID on session objects |
| `custom_participant_id` | string | Required when adding participants (use UUID v4) |
| `preset_name` | string | Uses underscores: `group_call_host`, `group_call_participant` |
| `token` | string | Participant auth JWT (returned from add participant) |
| `output_file_name` | string | Track: `{{prefix}}_{{user_id}}_..._audio_{{timestamp}}.webm`; Composite: `{meetingId}_{timestamp}.mp4` |
| `type` | string | **Always empty in list response** — detect track by `.webm` extension or `Array.isArray(download_url)` |
| `file_size` | number | Actual bytes for composite; always `0` for track (CF quirk) |

---

## Known Limitations

- **No DELETE endpoint** — Meetings, recordings, and sessions cannot be deleted via the REST API. Meetings can be set to `INACTIVE` to prevent new joins, but the resources persist.
- **7-day auto-expiry** — Sessions, recordings, and transcripts auto-expire from R2 after 7 days. Presigned download URLs also expire.
- **Post-meeting transcription only** — Whisper processes audio after the session ends. No real-time/live captions in the current MVP.
- **Track recording is audio-only** — Video track recording is in development per CF docs.
- **`type` field always empty** — The list recordings endpoint returns `type` as empty string, not `"TRACK"` or `"COMPOSITE"`. Must identify by `output_file_name` extension or `download_url` shape.
- **Track `file_size` always 0** — Actual file size is in the storage bucket but not reflected in the API response.
- **Workers AI 25MB limit** — Audio files larger than 25MB can't be transcribed via Workers AI Whisper.
- **Transcription cost** — Whisper Large v3 Turbo costs ~47 Neurons per audio-minute. Real-time alternatives (e.g., Deepgram) cost ~836 Neurons/min (18x more).
- **API field naming inconsistency** — Some endpoints use snake_case (`transcript_download_url`), others use camelCase (`download_url`, `audio_download_url`). The code handles both.
- **Track recording docs vs reality** — Docs say `layers` is optional; API returns 422 if omitted. `layers.default.outputs` array with `type: "REALTIMEKIT_BUCKET"` is required.
- **Screen sharing unavailable on mobile** — The `getDisplayMedia()` API required for screen sharing is not supported on iOS Safari (all iOS browsers) and has limited support on Android Chrome. The `<RtkMeeting>` Web Component handles this internally — no workaround exists at the platform level. The app does not hide the screen share button on mobile; it will appear but fail silently.

---

## Key Design Decisions

| Decision | Why |
|---|---|
| RealtimeKit over raw WebRTC/SFU | Built-in recording, transcription, and summary reduced development from weeks to days |
| Dual recording (composite + track) | Composite for video + mixed audio; track for per-participant audio (no diarization needed) |
| `record_on_start: false` + manual 5s auto-start | Server-side dedup prevents N recordings from N participants |
| `allow_multiple_recordings: true` | Allows composite + track to run concurrently |
| Track dedup by `.webm` extension | `type` field is always empty in list response — can't filter by `type === "TRACK"` |
| Token minting in Worker | The `CF_API_TOKEN` must never be exposed to the browser; the Worker is the trusted intermediary |
| Poll-based summary retrieval | Simpler than setting up webhook infrastructure for the MVP — no public URL or event handling needed |
| OpenRouter as primary LLM | Free models, auto-routed, no rate limit issues with `openrouter/free` |
| Ollama Cloud as fallback | Configurable model, better summary quality than CF built-in; falls back gracefully |
| Setting `summarize_on_end` even with OpenRouter | Ensures CF built-in summary exists as a fallback if OpenRouter and Ollama both fail |

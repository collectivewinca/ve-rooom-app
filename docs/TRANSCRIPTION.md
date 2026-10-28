# Transcription Pipeline

VE Rooom uses a **3-source fallback pipeline** to transcribe meeting audio, followed by a **3-tier LLM fallback** to generate the summary. All logic lives in `functions/api/summary/[id].ts`.

## Transcription Sources (tried in order)

```
Source 1: CF built-in transcript (transcribe_on_end)
    │
    └──→ If non-empty → use it
        │
        ▼ (if empty)
Source 2: Workers AI Whisper on per-participant WebM track files
    │
    └──→ For each .webm file:
        download → base64 → POST /ai/run/@cf/openai/whisper-large-v3-turbo
        → "[Participant {userId}]: {text}"
    │
    └──→ Merge all participant transcripts
        │
        ▼ (if no track files or all too large)
Source 3: Workers AI Whisper on composite MP3
    │
    └──→ download MP3 → base64 → POST /ai/run/@cf/openai/whisper-large-v3-turbo
```

### Source 1: CF Built-in Transcript (Primary)

- **Trigger**: `transcribe_on_end: true` set in `functions/api/rooms.ts` when creating the meeting
- **How**: CF internally runs Whisper on the composite recording when the session ends
- **Endpoint**: `GET /sessions/{sessionId}/transcript` → returns `transcript_download_url`
- **Format**: CSV file, **no header row** — each line is one utterance:
  ```
  12345,peer-uuid,user-uuid,custom-participant-id,Participant Name,spoken text here
  ```
- **Empty check**: `transcriptLines.length === 0` (NOT `<= 1` — the CSV has no header row)
- **Cost**: 46.63 Neurons/audio-min/participant (Free plan: 10,000 Neurons/day)

### Source 2: Per-Participant WebM Track Files (Fallback A)

- **When**: CF transcript is empty AND track recording files exist
- **How**: Download each `.webm` file from track recording → base64-encode → call Workers AI Whisper
- **Constraint**: ≤25MB per file (Workers AI input limit)
- **Output**: Each transcript prefixed with `[Participant {userId}]:` for speaker identification
- **Merge**: All participant transcripts joined with `\n\n`
- **Advantage**: No diarization needed — each file is already one speaker

### Source 3: Composite MP3 Audio (Fallback B)

- **When**: CF transcript is empty AND no track files (or all too large)
- **How**: Download composite MP3 from `audio_download_url` → base64-encode → call Workers AI Whisper
- **Constraint**: ≤25MB (if larger, return download links for manual transcription)
- **Output**: Single transcript text (no speaker identification)

### Workers AI Whisper API

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/openai/whisper-large-v3-turbo
Authorization: Bearer {CF_API_TOKEN}
Content-Type: application/json

{ "audio": "base64-encoded-audio", "language": "en" }
```

**⚠️ Force `language: "en"`** — without it, Whisper may misdetect language (e.g., detect Russian with 29.5% confidence on silence-heavy audio, producing Cyrillic garbage).

**Response:**
```json
{
  "result": {
    "text": "transcribed text here",
    "transcription_info": {
      "language": "en",
      "duration": 209.005,
      "duration_after_vad": 209.005
    },
    "word_count": 14,
    "segments": [...]
  }
}
```

### CF API Token Scope

The CF API token needs **both**:
- Realtime admin (for meetings, recordings, sessions, transcripts)
- Workers AI:Run (for Whisper transcription)

Without `Workers AI:Run` scope, Whisper calls return `401: Authentication error`.

## Summary Generation (3-tier fallback)

```
Tier 1: OpenRouter (openrouter/free)
    │
    └──→ If fails or no key →
Tier 2: Ollama Cloud (gpt-oss:120b)
    │
    └──→ If fails or no key →
Tier 3: CF built-in summary
    │
    └──→ GET /sessions/{sessionId}/summary
```

### Tier 1: OpenRouter (Primary)

- **Endpoint**: `POST https://openrouter.ai/api/v1/chat/completions`
- **Auth**: `Bearer {OPENROUTER_API_KEY}`
- **Model**: `openrouter/free` (auto-routes to available free models)
- **Format**: OpenAI-compatible `{ choices: [{ message: { content } }] }`
- **Cost**: Free (rate-limited, but `openrouter/free` auto-selects from available free models)
- **Tries**: primary model first, then `OPENROUTER_FREE_MODEL`

### Tier 2: Ollama Cloud (Fallback)

- **Endpoint**: `POST {OLLAMA_BASE_URL}/api/chat`
- **Auth**: `Bearer {OLLAMA_API_KEY}`
- **Model**: `OLLAMA_MODEL` (default: `gpt-oss:120b`)
- **Format**: `{ message: { content } }`
- **Skipped** if `OLLAMA_API_KEY` is `"placeholder"` or missing

### Tier 3: CF Built-in Summary (Last Resort)

- **Endpoint**: `GET /sessions/{sessionId}/summary`
- **Auth**: `Bearer {CF_API_TOKEN}`
- **Triggered by**: `summarize_on_end: true` in meeting config
- **Lower quality** than OpenRouter/Ollama (less structured)

## Summary Format

The `SUMMARY_SYSTEM_PROMPT` in `functions/api/summary/[id].ts` instructs the LLM to produce a 7-section Markdown summary:

1. **Meeting Summary** — 4-8 sentence overview
2. **Key Topics Discussed** — bullet points with 2-4 sentences each
3. **Decisions Made** — bold decisions with rationale
4. **Action Items** — checklist with owners and deadlines
5. **Open Questions** — unresolved questions
6. **Participants** — who spoke, who led
7. **Sentiment & Engagement** — energy, dynamics assessment

## API Response

```typescript
{
  status: "ok" | "processing" | "no_ended_session" | "no_summary" | "error",
  summary?: string,           // Markdown summary
  transcriptUrl?: string,     // CF transcript CSV download URL
  recordingUrl?: string,      // Composite MP4 download URL
  audioRecordingUrl?: string, // Composite MP3 download URL
  trackFiles?: [{             // Per-participant WebM files
    filename: string,
    downloadUrl: string,
    userId: string,
    peerId: string
  }],
  transcript_text?: string,   // Full transcript text (for "Full Transcript" download)
  sessionId: string
}
```

## Known Issues

### Whisper on Silence-Heavy Audio
When audio is mostly silence (e.g., participants joined but didn't speak), Whisper may:
- Misdetect language (e.g., detect Russian with low confidence)
- Hallucinate repeated phrases (e.g., "Thank you. Thank you. Thank you.")
- Produce Cyrillic/Unicode garbage characters

**Mitigation**: Always pass `language: "en"` in the Whisper request body.

### Workers AI 25MB Limit
Audio files larger than 25MB can't be transcribed via Workers AI. The summary endpoint:
- Checks `Content-Length` header before downloading
- If >25MB: returns download links for manual transcription
- For very long meetings, consider splitting audio with ffmpeg first

### Track Files Shorter Than Composite
Track recordings capture each participant's time in the meeting. If a participant leaves early, their WebM file is shorter than the composite. This is correct behavior — timestamps within each file are still aligned to the meeting start.

## Local Whisper (Alternative)

For offline transcription (no Workers AI), we've used local Whisper `base.en` model:

```sh
# Split audio into 10-min segments (for 25MB limit)
ffmpeg -i input.mp3 -f segment -segment_time 600 -c copy chunk_%03d.mp3

# Transcribe each chunk
whisper chunk_000.mp3 --model base.en --language en --output_format txt
```

This was used for the JSSA-amply meeting (106 min, 243MB MP3 → 11 chunks → 20,683 chars of transcript). See `public/jssa-amply-summary.md` for the result.
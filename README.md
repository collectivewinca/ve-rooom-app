# VE Rooom

[![CI](https://github.com/collectivewinca/ve-rooom-app/actions/workflows/ci.yml/badge.svg)](https://github.com/collectivewinca/ve-rooom-app/actions/workflows/ci.yml)
[![CodeQL](https://github.com/collectivewinca/ve-rooom-app/actions/workflows/codeql.yml/badge.svg)](https://github.com/collectivewinca/ve-rooom-app/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Built with Cloudflare](https://workers.cloudflare.com/built-with-cloudflare.svg)](https://www.cloudflare.com/)

Open-source video meetings with automatic recording, transcription, AI summaries, and durable recording storage. VE Rooom runs as one Cloudflare Worker with static assets and uses RealtimeKit, Workers AI, KV, and R2.

**Maintained by [VE Lab](GOVERNANCE.md).**

[Try the live deployment](https://ve-rooom.collectivewin.network) · [Read the architecture](docs/ARCHITECTURE.md) · [View the roadmap](ROADMAP.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/collectivewinca/ve-rooom-app)

> The deploy button becomes available to third parties when this repository is public. Cloudflare provisions fresh KV and R2 resources in the deployer's account. A RealtimeKit app and scoped API token are still required because RealtimeKit app creation is not currently automated by deploy buttons.

## Why VE Rooom?

- **One Worker:** the React SPA and all API routes deploy together.
- **Cloudflare-native media:** RealtimeKit provides the SFU, sessions, recording, and native transcripts.
- **AI meeting notes:** Workers AI Whisper and Llama are backed by optional Gemini, OpenRouter, and Ollama fallbacks.
- **Durable recordings:** completed audio is copied to your R2 bucket before RealtimeKit's temporary URL expires.
- **Portable identity:** fresh deployments create a persistent pseudonymous user ID in the browser. An external PocketBase gateway can be enabled optionally.
- **No origin server:** no VM, container, or long-running Node process is required for the application request path.

## Architecture

```text
Browser
  │ HTTPS / WebRTC
  ▼
Cloudflare Worker ─── Static Assets (React + Vite)
  │
  ├── /api/* ───────── Worker router and API handlers
  ├── RealtimeKit ───── meetings, SFU, sessions, recordings, transcripts
  ├── Workers AI ────── Whisper transcription + Llama summaries
  ├── Workers KV ────── meeting metadata, results, prompts, rate limits
  └── R2 ────────────── durable recording copies
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for endpoint and data-flow details.

## Quick start

### Requirements

- Node.js 20 or newer
- A Cloudflare account with RealtimeKit enabled
- A RealtimeKit app
- A scoped Cloudflare API token with RealtimeKit administration and Workers AI run permissions

### Install and configure

```bash
git clone https://github.com/collectivewinca/ve-rooom-app.git
cd ve-rooom-app
npm ci
cp .dev.vars.example .dev.vars
```

Fill in the three required values:

```dotenv
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_TOKEN=your_scoped_cloudflare_api_token
RTK_APP_ID=your_realtimekit_app_id
```

Optional providers and recording settings are documented in [`.dev.vars.example`](.dev.vars.example).

### Run locally

Build the frontend, then start the Worker:

```bash
npm run build
npm run dev:worker
```

Open <http://127.0.0.1:8788>. For frontend hot reload, run `npm run dev` separately; Vite proxies `/api` to port `8788`.

### Deploy

Use the deploy button above, or deploy from the CLI:

```bash
npm run deploy
```

For manual deployments, replace the example KV namespace ID and R2 bucket name in `wrangler.toml`, then add secrets with `npx wrangler secret put NAME`. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Configuration

| Variable | Required | Purpose |
|---|---:|---|
| `CF_ACCOUNT_ID` | Yes | Cloudflare account containing the RealtimeKit app |
| `CF_API_TOKEN` | Yes | Scoped RealtimeKit administration + Workers AI token |
| `RTK_APP_ID` | Yes | RealtimeKit application ID |
| `OPENROUTER_API_KEY` | No | Summary fallback |
| `GEMINI_API_KEY` | No | Long-context summary provider |
| `OLLAMA_API_KEY` / `OLLAMA_BASE_URL` | No | Final summary fallback |
| `RESEND_API_KEY` / `EMAIL_FROM` | No | Summary email delivery |
| `SMTP_API_URL` | No | Custom email relay implementing `/send-batch` |
| `WEBHOOK_SECRET` | Recommended | Shared secret for webhook requests |
| `MEDIA_ALLOWED_HOSTS` | No | Additional HTTPS media host suffixes |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | No | RealtimeKit's optional native external-bucket transfer |
| `FORMSDB_URL` | No | Legacy/external PocketBase identity gateway |
| `ADMIN_EMAILS` | No | External-auth users allowed to view every meeting |

Bindings:

| Binding | Product | Purpose |
|---|---|---|
| `MEETING_CACHE` | Workers KV | Metadata, transcripts, summaries, prompts, and rate limits |
| `RECORDINGS_BUCKET` | R2 | Durable recording storage |
| `ASSETS` | Workers Static Assets | React application |

## Local identity and security model

By default, the browser creates a random UUID and sends a `guest:<uuid>` identity token. This lets a self-hosted deployment work immediately without another identity provider. It is **pseudonymous identification, not secure authentication**: someone who obtains another user's token can impersonate that identity.

Use the default mode for demos and community deployments. Before offering paid credits or sensitive private meetings, enable a real OAuth provider. Strong Cloudflare-native authentication and Stripe credits are tracked in the [roadmap](ROADMAP.md).

Webhook payloads are rate-limited, meeting IDs are validated, and remote media URLs are restricted to HTTPS allowlisted hosts. Set `WEBHOOK_SECRET` in production when the webhook sender supports it.

## Development

```bash
npm run typecheck
npm run build
npm run check
```

The 18 Worker routes are listed in [`worker/index.ts`](worker/index.ts). Existing handler modules use a Pages-Functions-compatible context adapter to keep the migration reviewable.

## Project status

VE Rooom is an early-stage open-source project. The meeting, recording, transcript, summary, and R2 download paths work, but API stability is not guaranteed before `1.0.0`. Review [known limitations](ROADMAP.md#known-limitations) before production use.

## Contributing

Contributions of code, documentation, tests, accessibility improvements, and deployment examples are welcome. Start with:

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- [`SECURITY.md`](SECURITY.md)
- [`PRIVACY.md`](PRIVACY.md)
- issues labeled `good first issue` or `help wanted`

Please use GitHub Discussions for questions and ideas, and Issues for reproducible defects or accepted feature work.

## License

Licensed under the [Apache License 2.0](LICENSE). The VE Rooom name and VE Lab branding are project identifiers; see the [trademark policy](TRADEMARKS.md).

# Cloudflare services

## Worker and Static Assets

One Worker serves the Vite bundle and API. `run_worker_first = ["/api/*"]` ensures API requests always reach `worker/index.ts`; other unknown paths use SPA fallback.

Wrangler 4 builds and deploys the project. Observability and source-map uploads are enabled in `wrangler.toml`.

## RealtimeKit

RealtimeKit provides:

- WebRTC SFU and meeting sessions
- participant tokens and presets
- composite recording
- native transcription metadata
- meeting, session, and recording REST APIs

All administrative REST calls happen in the Worker so `CF_API_TOKEN` never reaches the browser.

## Workers AI

- Whisper transcribes composite audio when the native transcript is absent or unusable.
- Llama 3.3 70B is the in-network summary provider for suitable inputs.

Workers AI usage is billed to the deployer's Cloudflare account. Consult current Cloudflare pricing before offering an unrestricted public deployment.

## Workers KV

`MEETING_CACHE` stores metadata, transcripts, summaries, prompts, locks, indexes, and soft rate limits. Deploy to Cloudflare provisions a fresh namespace and rewrites the binding ID.

## R2

`RECORDINGS_BUCKET` stores durable recording copies. R2 egress and operation/storage pricing apply to the deployer's account. Lifecycle policy is intentionally operator-controlled.

## RealtimeKit UI libraries

- `@cloudflare/realtimekit-react`
- `@cloudflare/realtimekit-react-ui`

The application embeds RealtimeKit's meeting UI rather than implementing WebRTC controls directly.

## Not currently used

- D1: planned for strict quotas, Stripe ledger, and linked accounts
- Durable Objects: not required for current meeting orchestration
- Cloudflare Access: not suitable as consumer authentication for this project
- Queues and Workflows: possible future replacements for parts of the continuation chain

## Deploy-button provisioning

The Worker configuration declares KV, R2, and Static Assets. Cloudflare's deploy flow clones the repository, provisions supported resources, updates generated resource IDs, prompts for declared secrets, and configures Workers Builds.

RealtimeKit app creation and API-token issuance still require manual Cloudflare dashboard steps.

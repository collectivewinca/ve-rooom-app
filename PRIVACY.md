# Privacy and recording guidance

VE Rooom is self-hostable software, not a centralized service. Each deployment operator is responsible for its own privacy notice, legal basis, recording consent, retention policy, access controls, and provider agreements.

## Data processed by the software

Depending on configuration and user actions, a deployment may process:

- display names and pseudonymous browser identifiers;
- meeting titles, participant metadata, and session times;
- audio/video recordings;
- transcripts, summaries, prompts, and action items;
- email addresses when external authentication or email delivery is enabled;
- IP-derived rate-limit keys and provider request metadata.

See [`docs/DATA-STORAGE.md`](docs/DATA-STORAGE.md) for storage locations.

## Recording consent

Operators must provide clear notice before recording or transcription starts and obtain any consent required by the participants' jurisdictions. Do not assume that joining a link alone is sufficient consent.

Recommended practices:

- show a visible recording indicator;
- state what is recorded, why, and for how long;
- allow participants to leave before recording begins;
- provide deletion/export contact details;
- restrict links and downloads to authorized participants;
- avoid recording highly sensitive meetings without a reviewed policy.

## Third-party processors

Core Cloudflare services may process media and derived data. Optional Gemini, OpenRouter, Ollama, Resend, custom mail, and external identity providers receive data only when configured and invoked. Operators should review each provider's terms, region controls, retention, and model-training policies.

## Retention and deletion

The application does not impose a universal R2 lifecycle because deployments have different needs. Operators should configure an R2 lifecycle and a deletion process before production use. Deleting browser storage does not delete KV, R2, or RealtimeKit data.

## Local identity limitation

The default UUID identity is not strong authentication. It should not be used as the only control for confidential recordings or paid entitlements. Configure strong OAuth and server-managed sessions for those use cases.

# Identity

## Default local identity

VE Rooom is deployable without a separate authentication service. On first visit the browser generates a UUID, stores it under `ve_rooom_identity`, and sends it to the Worker as `guest:<uuid>`.

The Worker validates the token format and derives an internal address (`<uuid>@guest.local`) used only for KV indexing. Guest addresses are excluded from email delivery.

This model provides:

- stable meeting ownership on one browser profile
- per-identity prompts and dashboard filtering
- no external identity account for self-hosted demos

It does **not** provide:

- proof that a person owns an email address
- resistance to token theft or copying
- cross-device recovery
- secure tenancy for paid credits or sensitive meetings

Resetting identity discards the browser's pointer to prior meetings; it does not delete server-side data.

## Optional external identity

For backward compatibility, `functions/auth.ts` accepts an external PocketBase token when `FORMSDB_URL` is configured. Fresh deployments should leave it unset unless they operate their own gateway.

The identity verification boundary is deliberately centralized so Cloudflare-native Google OAuth and account linking can be introduced without rewriting meeting handlers.

## Production recommendation

Before enabling Stripe credits or hosting private organizational meetings:

1. add a strong OAuth flow;
2. store linked users and payment state in D1;
3. use HttpOnly signed sessions rather than browser-readable bearer tokens;
4. migrate guest meeting indexes after explicit account linking;
5. provide deletion and export controls.

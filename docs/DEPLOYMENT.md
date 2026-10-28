# Deployment

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/collectivewinca/ve-rooom-app)

The flow clones this public repository into the deployer's Git provider, provisions supported Cloudflare resources, prompts for secrets, and configures Workers Builds.

Before starting, create a RealtimeKit app and a scoped API token. RealtimeKit app creation is not currently part of automatic resource provisioning.

Required secrets:

- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`
- `RTK_APP_ID`

## Manual deployment

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run check
npm run deploy
```

For a manual setup, create resources and replace the defaults in `wrangler.toml`:

```bash
npx wrangler kv namespace create MEETING_CACHE
npx wrangler r2 bucket create ve-rooom-recordings
```

Set secrets without printing them into shell history where possible:

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put RTK_APP_ID
```

Optional secrets are described in `.dev.vars.example` and `package.json`.

## Workers Builds

Recommended production settings:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Node.js | 22 or newer |

Require the CI check before merging to `main`.

## Custom domain

After the workers.dev deployment passes smoke tests, add a Workers Custom Domain from the Worker settings. Do not move an existing production hostname until the new Worker has passed:

- SPA route checks
- meeting create/join checks
- webhook validation
- summary resolution
- R2 range playback (`206 Partial Content`)

## Webhook

Configure RealtimeKit to send events to:

```text
https://<your-domain>/api/webhook
```

Set `WEBHOOK_SECRET` on the Worker and configure the matching sender secret when supported. Keep the HTTPS media allowlist narrow.

## Rollback

Workers deployments are versioned. Use the Cloudflare dashboard or Wrangler version commands to roll back to a known-good Worker version. Binding data in KV and R2 is independent of Worker code versions.

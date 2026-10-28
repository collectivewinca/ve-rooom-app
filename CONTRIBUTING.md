# Contributing to VE Rooom

Thank you for helping improve VE Rooom. Contributions are welcome from first-time and experienced contributors.

## Before you start

- Use GitHub Discussions for questions, design exploration, and support.
- Search existing issues before opening a new one.
- For a substantial change, open an issue first so maintainers and contributors agree on scope.
- Never include API tokens, meeting recordings, transcripts, email addresses, or production identifiers in an issue or pull request.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requirements:

- Node.js 20+
- A Cloudflare account
- A RealtimeKit app and scoped API token

```bash
git clone https://github.com/collectivewinca/ve-rooom-app.git
cd ve-rooom-app
npm ci
cp .dev.vars.example .dev.vars
# Add your own development credentials to .dev.vars.
npm run build
npm run dev:worker
```

Open <http://127.0.0.1:8788>.

For frontend hot reload:

```bash
# Terminal 1
npm run dev:worker

# Terminal 2
npm run dev
```

Open the Vite URL. It proxies `/api` requests to the local Worker.

## Workflow

1. Fork the repository and create a focused branch such as `fix/r2-range-response`.
2. Make the smallest coherent change that solves the issue.
3. Add or update documentation when behavior or configuration changes.
4. Run the required checks:

   ```bash
   npm run check
   ```

5. Manually exercise affected meeting flows when relevant.
6. Commit with a clear [Conventional Commit](https://www.conventionalcommits.org/) message.
7. Open a pull request using the template.

Examples:

```text
feat: add transcript credit indicator
fix: validate recording keys before R2 lookup
docs: explain RealtimeKit webhook setup
chore: update Wrangler
```

## Pull-request expectations

- One logical change per pull request.
- Explain the user impact and testing performed.
- Link the related issue.
- Keep unrelated formatting changes out of the diff.
- Preserve compatibility with the Cloudflare Workers runtime; do not add Node-only APIs unless `nodejs_compat` is deliberately enabled and documented.
- Treat KV as eventually consistent. Do not use KV read-modify-write operations for billing-grade counters.
- Validate every URL fetched by a public endpoint.
- Do not expose `CF_API_TOKEN`, provider keys, participant tokens, or presigned recording URLs in browser logs.

## Architecture conventions

- `worker/index.ts` is the Worker entrypoint and route table.
- `functions/api/**` contains API handlers.
- `functions/lib/**` contains runtime-independent backend helpers.
- `src/**` contains the React application.
- API requests should go through `src/lib/api.ts`.
- Durable recording bytes belong in R2; KV stores references and derived state.

## Testing meeting changes

For media or recording changes, test at minimum:

1. Create a meeting.
2. Join from a second browser profile.
3. Confirm only one composite recording starts.
4. End the meeting and confirm the webhook is accepted.
5. Confirm the recording is copied to R2.
6. Confirm the summary endpoint resolves the ended session.
7. Confirm ranged recording playback returns HTTP `206`.

Use test accounts and disposable meetings only. Never attach real recordings or transcripts to a public issue.

## Developer Certificate of Origin

All commits must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "fix: describe the change"
```

The sign-off certifies that you have the right to submit the contribution under this project's license.

## Reporting security problems

Do not open public issues for vulnerabilities. Follow [`SECURITY.md`](SECURITY.md).

# Roadmap

The roadmap communicates direction, not guaranteed delivery dates. Accepted work is tracked in GitHub Issues and Projects.

## Current: open-source foundation

- [x] Migrate the application from Pages to one Worker with Static Assets
- [x] Add one-click Deploy to Cloudflare metadata
- [x] Remove mandatory external authentication from fresh deployments
- [x] Add project governance, security policy, templates, and CI
- [ ] Publish the repository and enable Discussions, private vulnerability reporting, secret scanning, and branch protection
- [ ] Add automated API and browser tests

## Next: identity, quotas, and payments

- [ ] Add Cloudflare D1 for users, quota events, and payment ledger
- [ ] Limit free accounts to three created meetings per UTC day
- [ ] Allow three lifetime transcript unlocks before credits are required
- [ ] Add Stripe Checkout credit packs and signature-verified webhooks
- [ ] Add Cloudflare-native Google OAuth and account linking
- [ ] Keep pseudonymous local identity available for self-hosted demos

## Later: production maturity

- [ ] Configurable recording retention and deletion UI
- [ ] Admin usage and Cloudflare-cost dashboard
- [ ] Accessibility audit and keyboard-only meeting flows
- [ ] Internationalization
- [ ] End-to-end encrypted metadata where practical
- [ ] Additional RealtimeKit presets and meeting roles
- [ ] Public plugin/provider interfaces for mail and summarization

## Known limitations

- Local identity is pseudonymous and not secure authentication.
- RealtimeKit and Workers AI usage may incur Cloudflare charges as traffic grows.
- RealtimeKit media URLs are temporary; durable storage depends on webhook delivery and R2 copying.
- Email requires an optional external provider.
- KV is eventually consistent and is not appropriate for payment counters; D1 is planned for billing-grade state.
- No automated end-to-end media test suite exists yet.

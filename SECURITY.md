# Security policy

VE Rooom handles meeting tokens, recordings, transcripts, and provider credentials. Please report security issues privately and avoid testing against meetings you do not own.

## Supported versions

Until the first stable release, security fixes are applied to the latest commit on `main` only.

| Version | Supported |
|---|---:|
| `main` / latest release | Yes |
| Older commits and forks | No |

## Reporting a vulnerability

Use **GitHub private vulnerability reporting**:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include the affected endpoint or component, impact, reproduction steps, and a suggested mitigation if available.

If private reporting is unavailable, contact a maintainer listed in [`GOVERNANCE.md`](GOVERNANCE.md) without including exploit details in a public issue.

You should receive an acknowledgement within 5 business days. We aim to provide an initial assessment within 10 business days. Timelines for remediation depend on impact and complexity.

## Safe-harbor expectations

- Test only accounts, meetings, and Cloudflare resources you own or have permission to use.
- Do not access, retain, or disclose other users' recordings, transcripts, credentials, or personal information.
- Do not degrade the service, run denial-of-service tests, or create significant paid Cloudflare usage.
- Give maintainers reasonable time to remediate before disclosure.

Good-faith research following these rules will not be treated as malicious activity by the project maintainers.

## Deployment security checklist

- Use a narrowly scoped Cloudflare API token; never use a global API key.
- Set `WEBHOOK_SECRET` whenever the webhook sender supports one.
- Keep `.dev.vars` out of version control.
- Use a dedicated R2 API token if native external-bucket transfer is enabled.
- Configure R2 lifecycle and access policies appropriate for sensitive recordings.
- Enable GitHub secret scanning, push protection, Dependabot, and branch protection.
- Replace local pseudonymous identities with strong OAuth before selling credits or hosting sensitive meetings.

## Known upstream advisory

The current RealtimeKit React SDK depends on `uuid` below `11.1.1`, which npm reports under `GHSA-w5hq-g745-h8pq`. VE Rooom does not call the affected UUID buffer APIs directly, and forcing an incompatible transitive major version could break the media SDK. Dependabot tracks the dependency; the project will update as soon as Cloudflare publishes a compatible RealtimeKit release. There are no known high or critical npm advisories in the current lockfile.

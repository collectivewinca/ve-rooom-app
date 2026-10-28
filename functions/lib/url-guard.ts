/**
 * SSRF guard for URLs that arrive from outside the app.
 *
 * Every media URL the Worker downloads (recording audio, transcripts, RTK
 * summaries) is either built by us or handed to us in a RealtimeKit webhook
 * payload. A webhook payload is attacker-controllable: without a host check
 * anyone able to POST /api/webhook could point `audioDownloadUrl` at an
 * arbitrary host and make the Worker fetch it (SSRF), stream it into our R2
 * bucket, and burn Workers AI minutes on it.
 *
 * RealtimeKit serves all of its media from Cloudflare R2 buckets
 * (`<bucket>.<account>.r2.cloudflarestorage.com`), and our own proxy URLs point
 * back at this deployment's hostname — both are allowed. Anything else is
 * rejected.
 */

const DEFAULT_ALLOWED_HOST_SUFFIXES = [
	".r2.cloudflarestorage.com",
	".cloudflarestorage.com",
];

export interface UrlGuardOptions {
	/** Comma-separated extra host suffixes, e.g. "media.example.com". */
	extraAllowedHosts?: string;
	/** Exact hostnames that are allowed (used for this deployment's own host). */
	allowHosts?: string[];
}

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * True when `raw` is an https URL whose host is an allowed media host.
 */
export function isAllowedMediaUrl(raw: string | null | undefined, options: UrlGuardOptions = {}): boolean {
	if (!raw) return false;

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return false;
	}

	const host = normalizeHost(parsed.hostname);
	if (!host) return false;

	const exact = (options.allowHosts ?? []).map(normalizeHost).filter(Boolean);
	if (exact.includes(host)) {
		// Our own origin (the app proxying a recording to itself) is trusted
		// even over http — local dev runs on http://127.0.0.1.
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	}

	// Plain http would let an attacker redirect to a local/cleartext endpoint,
	// and Cloudflare Workers only need https for R2 anyway.
	if (parsed.protocol !== "https:") return false;

	const suffixes = [
		...DEFAULT_ALLOWED_HOST_SUFFIXES,
		...(options.extraAllowedHosts ?? "").split(",").map(normalizeHost).filter(Boolean),
	].map((suffix) => suffix.replace(/^\./, ""));
	return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * UUID check for identifiers that become KV key prefixes / R2 object keys.
 * Keeps a hostile payload from injecting arbitrary key namespaces.
 */
export function isValidUuid(value: string | null | undefined): boolean {
	if (!value) return false;
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

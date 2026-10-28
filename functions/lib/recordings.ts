import { getRecordingRefs, saveRecordingRefs, type RecordingRef } from "./kv";

export interface ParsedRecordings {
	recordingUrl: string | undefined;
	audioRecordingUrl: string | undefined;
}

export interface RTKRecordingData {
	meeting_id: string;
	session_id?: string;
	download_url: unknown;
	audio_download_url?: string;
	status: string;
	type?: string;
	output_file_name?: string;
	invoked_time?: string;
}

/**
 * Selection rule for a meeting's composite recording. RTK can produce multiple
 * recordings for the same session (e.g. a short empty segment when the room
 * opens, then the real conversation). We must pick the LATEST one — the first
 * segment is often silent ("Thank you.") and would yield an empty transcript.
 *
 * "Latest" = largest invoked_time, falling back to the timestamp encoded in
 * output_file_name (`{meetingId}_{ms}.{ext}`), then lexicographic file name.
 */
export function pickLatestCompositeRecording(
	recordings: RTKRecordingData[],
	meetingId: string | undefined,
	sessionId: string | undefined,
): RTKRecordingData | undefined {
	const candidates = recordings.filter((r) =>
		r.audio_download_url &&
		r.status === "UPLOADED" &&
		!r.output_file_name?.endsWith(".webm") &&
		(!sessionId || r.session_id === sessionId) &&
		(!meetingId || r.meeting_id === meetingId),
	);
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];

	const tsOf = (r: RTKRecordingData): number => {
		if (r.invoked_time) {
			const t = Date.parse(r.invoked_time);
			if (!Number.isNaN(t)) return t;
		}
		const m = (r.output_file_name || "").match(/_(\d+)\.[a-zA-Z0-9]+$/);
		if (m) return Number(m[1]);
		return 0;
	};
	return candidates.slice().sort((a, b) => tsOf(a) - tsOf(b)).pop();
}

export async function parseSessionRecordings(
	recRes: Response | null,
	meetingId: string,
	sessionId: string
): Promise<ParsedRecordings> {
	let recordingUrl: string | undefined;
	let audioRecordingUrl: string | undefined;

	if (!recRes || !recRes.ok) return { recordingUrl, audioRecordingUrl };

	try {
		const recJson = await recRes.json() as {
			success: boolean;
			data?: RTKRecordingData[];
		};
		const latest = pickLatestCompositeRecording(recJson.data || [], meetingId, sessionId);
		if (latest) {
			if (typeof latest.download_url === "string") recordingUrl = latest.download_url;
			if (latest.audio_download_url) audioRecordingUrl = latest.audio_download_url;
		}
	} catch (e) {
		console.log("[recordings] Parse error:", e);
	}

	return { recordingUrl, audioRecordingUrl };
}

/**
 * List this meeting's recordings from our permanent R2 bucket.
 *
 * Two naming schemes exist in the bucket:
 *   nested: <meetingId>/<sessionId>/composite.mp3 | composite.mp4  (health-check copy)
 *   flat:   <meetingId>_<timestamp>.mp3 | .mp4                    (RTK direct upload)
 * Both share the meeting ID as a literal prefix, so one list call covers both.
 */
export async function listRecordingRefs(bucket: R2Bucket, meetingId: string): Promise<RecordingRef[]> {
	const listed = await bucket.list({ prefix: meetingId, limit: 500 });
	const refs: RecordingRef[] = [];
	for (const obj of listed.objects) {
		// Require the char after the meetingId to be "/" (nested) or "_" (flat) so a
		// longer unrelated UUID that happens to start with meetingId can't match.
		const afterId = obj.key.slice(meetingId.length);
		if (afterId !== "" && afterId[0] !== "/" && afterId[0] !== "_") continue;

		const ext = obj.key.split(".").pop()?.toLowerCase() || "";
		if (ext !== "mp3" && ext !== "mp4") continue;
		refs.push({
			key: obj.key,
			url: `/api/recording/${encodeURIComponent(obj.key)}`,
			type: ext === "mp3" ? "audio" : "composite",
			size: obj.size,
			uploadedAt: obj.uploaded?.toISOString(),
		});
	}
	return refs.filter((r, i, arr) => arr.findIndex((x) => x.key === r.key) === i);
}

/**
 * Strictly filter recording refs down to one session.
 * Returns [] when the bucket only holds nested keys for OTHER sessions — never
 * guesses across sessions, because transcribing the wrong session's audio would
 * silently produce a wrong summary.
 */
export function sessionRecordingRefs(refs: RecordingRef[], sessionId?: string): RecordingRef[] {
	if (!sessionId) return [];
	const scoped = refs.filter((r) => r.key.includes(`/${sessionId}/`) || r.key.startsWith(`${sessionId}/`));
	if (scoped.length > 0) return scoped;
	// Flat naming carries no session id — nothing to scope against.
	const anyNested = refs.some((r) => r.key.includes("/"));
	return anyNested ? [] : refs;
}

/**
 * Prove an object is actually readable before we advertise it.
 *
 * `bucket.head()` proved unreliable here: for objects being reclaimed it
 * returned null on some requests and a size on others, while the R2 REST/S3
 * APIs reported 404 throughout. Two lessons are baked in:
 *   1. read instead of trusting metadata, and
 *   2. probe several offsets, not just the start — a partially reclaimed object
 *      can still answer reads at the head and tail while a full read (what a
 *      download needs) fails.
 */
async function objectReadable(bucket: R2Bucket, key: string, size?: number): Promise<boolean> {
	if (!size || size <= 0) {
		try {
			const res = await bucket.get(key, { range: { offset: 0, length: 1 } });
			if (!res) return false;
			await res.arrayBuffer();
			return true;
		} catch {
			return false;
		}
	}
	const offsets = Array.from(new Set([0, Math.floor(size / 2), size - 1]));
	try {
		const results = await Promise.all(offsets.map(async (offset) => {
			const res = await bucket.get(key, { range: { offset, length: 1 } });
			if (!res) return false;
			await res.arrayBuffer();
			return true;
		}));
		return results.every(Boolean);
	} catch {
		return false;
	}
}

/**
 * Load this meeting's recording refs, treating R2 as the source of truth.
 *
 * KV is only a cache, and a ref can outlive its object (lifecycle cleanup, a
 * manual prune, or a backfill that never completed). Serving those refs hands
 * the client download links that 404 — and, worse, an empty live list would
 * otherwise be ignored because the cache looked populated. So whenever the
 * bucket is bound we re-list it and heal the cache when the live set differs.
 */
export async function loadRecordingRefs(
	bucket: R2Bucket | undefined,
	kv: KVNamespace,
	meetingId: string,
): Promise<RecordingRef[]> {
	const cached = await getRecordingRefs(kv, meetingId);
	if (!bucket) return cached;
	try {
		const listed = await listRecordingRefs(bucket, meetingId);
		// A listed key is not proof of a readable object. Verify each one before
		// we hand out a download link or build a transcript on it — a stale
		// listing entry otherwise presents as a download that 404s.
		const checked = await Promise.all(listed.map(async (ref) =>
			(await objectReadable(bucket, ref.key, ref.size)) ? ref : null,
		));
		const live = checked.filter((r): r is RecordingRef => r !== null);
		if (live.length !== listed.length) {
			console.log("[recordings] Dropped", listed.length - live.length, "listed-but-unreadable refs for", meetingId);
		}
		const unchanged = live.length === cached.length && live.every((l) => cached.some((c) => c.key === l.key));
		if (!unchanged) {
			console.log("[recordings] Healing ref cache for", meetingId, "— cached:", cached.length, "live:", live.length);
			await saveRecordingRefs(kv, meetingId, live);
		}
		return live;
	} catch (e) {
		console.log("[recordings] loadRecordingRefs list failed:", e);
		return cached;
	}
}

/**
 * Copy a finished recording into our own bucket while the source URL is alive.
 *
 * RTK keeps its copy (and its presigned URL) for 7 days, and its own transfer to
 * our external bucket is failing with [ERROR:0003]. So we take the copy
 * ourselves the moment `recording.statusUpdate` arrives: the body is streamed
 * straight through (no buffering — recordings run to hundreds of MB) and the
 * key matches the layout the health-check cron uses, so both paths produce the
 * same object.
 *
 * Idempotent: an existing object is left alone.
 */
export async function copyRecordingToR2(
	bucket: R2Bucket | undefined,
	meetingId: string,
	sessionId: string | undefined,
	sourceUrl: string,
	contentType = "audio/mpeg",
): Promise<RecordingRef | undefined> {
	if (!bucket || !sessionId || !sourceUrl) return undefined;
	const key = `${meetingId}/${sessionId}/composite.mp3`;
	try {
		const existing = await bucket.head(key);
		if (existing) {
			console.log("[recordings] R2 copy already present:", key, existing.size);
			return { key, url: `/api/recording/${encodeURIComponent(key)}`, type: "audio", size: existing.size, uploadedAt: existing.uploaded.toISOString() };
		}

		const res = await fetch(sourceUrl);
		if (!res.ok || !res.body) {
			console.log("[recordings] R2 copy skipped — source fetch failed:", res.status, key);
			return undefined;
		}
		await bucket.put(key, res.body, { httpMetadata: { contentType } });
		const stored = await bucket.head(key);
		console.log("[recordings] Copied recording to R2:", key, stored ? stored.size : "size unknown");
		return { key, url: `/api/recording/${encodeURIComponent(key)}`, type: "audio", size: stored?.size, uploadedAt: stored?.uploaded.toISOString() };
	} catch (e) {
		console.log("[recordings] R2 copy error:", e instanceof Error ? e.message : String(e), key);
		return undefined;
	}
}

/**
 * Find a session's permanent audio copy in our R2 bucket.
 *
 * Prefers session-scoped nested keys (`<meetingId>/<sessionId>/composite.mp3`)
 * and audio-only objects (mp3), then the most recently uploaded one. Returns
 * undefined when nothing usable exists — callers then fall back to RTK.
 */
export async function findSessionAudioRef(
	bucket: R2Bucket | undefined,
	meetingId: string,
	sessionId?: string,
): Promise<RecordingRef | undefined> {
	if (!bucket) return undefined;
	try {
		const refs = await listRecordingRefs(bucket, meetingId);
		const scoped = sessionRecordingRefs(refs, sessionId).filter((r) => r.type === "audio");
		if (scoped.length === 0) return undefined;
		return scoped.slice().sort((a, b) => {
			const at = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
			const bt = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
			if (at !== bt) return bt - at;
			return (b.size || 0) - (a.size || 0);
		})[0];
	} catch (e) {
		console.log("[recordings] findSessionAudioRef error:", e);
		return undefined;
	}
}

/**
 * Presigned URLs (RTK → its R2 bucket) expire after 7 days: they carry
 * `X-Amz-Date` + `X-Amz-Expires`. Our own `/api/recording/...` URLs carry
 * neither and never expire. Unknown/unparseable URLs are treated as usable so
 * we never discard a URL that might still work.
 */
export function isSignedUrlExpired(url: string, now = Date.now()): boolean {
	try {
		const parsed = new URL(url);
		const date = parsed.searchParams.get("X-Amz-Date");
		const expires = parsed.searchParams.get("X-Amz-Expires");
		if (!date || !expires) return false;
		const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
		if (!match) return false;
		const issuedAt = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
		const lifetimeMs = Number(expires) * 1000;
		if (!Number.isFinite(lifetimeMs)) return false;
		return now >= issuedAt + lifetimeMs;
	} catch {
		return false;
	}
}
import { transcribeCompositeAudio, generateMeetingSummary, maybeSendAutoEmail, resolvePrompt } from "../lib/transcribe-core";
import { getCachedResult } from "../lib/kv";
import { jsonResponse } from "../lib/response";
import { pickLatestCompositeRecording, findSessionAudioRef } from "../lib/recordings";
import { checkRateLimit } from "../lib/rate-limit";
import { isAllowedMediaUrl, isValidUuid } from "../lib/url-guard";
import type { AppEnv } from "../lib/env";

type Env = AppEnv;

/**
 * Self-continuing transcription endpoint.
 * Called by the webhook (and itself) to keep transcription going for long meetings.
 * Instant-ack design: every request responds immediately and does its work in
 * waitUntil, then fires the next link — so chain links never hold each other
 * open and can't be cancelled by a caller's post-response budget expiring.
 * Each link does at most ~20s of work (transcription chunks, summary step, or
 * a recording poll), well within the ~30s post-response budget.
 */
const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";
// Each poll invocation does 2 RTK API checks (~20s), then re-fires itself with
// a fresh 30s budget. 60 invocations ≈ 20+ minutes of total polling coverage —
// enough for even multi-hour recordings to finish uploading to RTK's bucket.
const POLL_CHECKS_PER_INVOCATION = 2;
const MAX_POLL_ATTEMPTS = 60;

interface ContinueBody {
	meetingId: string;
	audioUrl?: string;
	sessionId?: string;
	owner?: string;
	pollRecording?: boolean;
	pollAttempt?: number;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
	// The chain re-enters this endpoint on every link (polling included), so
	// the ceiling is higher than a normal endpoint's — but it is no longer
	// unbounded, which left Workers AI minutes open to anyone who posted here.
	const rl = await checkRateLimit(env.MEETING_CACHE, request, { max: 240, windowSeconds: 60 });
	if (!rl.allowed) {
		console.log("[transcribe-continue] Rate limited");
		return jsonResponse(429, { error: "Too many requests" });
	}

	const body = await request.json() as ContinueBody;
	const { meetingId } = body;

	if (!meetingId || (!body.audioUrl && !body.pollRecording)) {
		return jsonResponse(400, { error: "meetingId and audioUrl required" });
	}

	// meetingId becomes a KV key prefix; audioUrl is fetched by the Worker.
	if (!isValidUuid(meetingId)) {
		return jsonResponse(400, { error: "Invalid meeting id" });
	}
	if (body.audioUrl && !isAllowedMediaUrl(body.audioUrl, {
		extraAllowedHosts: env.MEDIA_ALLOWED_HOSTS,
		allowHosts: [new URL(request.url).hostname],
	})) {
		console.log("[transcribe-continue] Rejected: media URL host not allowed");
		return jsonResponse(400, { error: "Media URL host not allowed" });
	}

	const origin = new URL(request.url).origin;

	// Skip if already done
	const cached = await getCachedResult(env.MEETING_CACHE, meetingId, body.sessionId);
	if (cached?.summary) {
		console.log("[transcribe-continue] Already have summary — done");
		return jsonResponse(200, { ok: true, done: true });
	}

	// Instant-ack: run the job in the background and respond immediately.
	// Chain links never hold each other open — each link's continuation fetch
	// completes as soon as the next link acks (instantly), so a link can never
	// be cancelled by its caller's post-response budget expiring mid-work.
	waitUntil(runJob(env, body, origin));
	return jsonResponse(200, { ok: true, processing: true });
};

async function runJob(env: Env, body: ContinueBody, origin: string): Promise<void> {
	const { meetingId, sessionId, owner = "unknown", pollRecording = false, pollAttempt = 1 } = body;
	const audioUrl = body.audioUrl || "";
	try {
		// Re-check cache inside the job — another link may have finished
		const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (cached?.summary) {
			console.log("[transcribe-continue] Already have summary — done");
			return;
		}

		// Summary step: a previous link finished transcription and cached the
		// transcript. Kept separate from transcription links so each link stays
		// well within the ~30s post-response budget.
		if (cached?.transcript) {
			console.log("[transcribe-continue] Cached transcript found — running summary step for", meetingId);
			const customPrompt = await resolvePrompt(env, meetingId);
			const summaryResult = await generateMeetingSummary(env, meetingId, cached.transcript, customPrompt, sessionId);
			if (summaryResult.status === "ok") {
				await maybeSendAutoEmail(env, meetingId, summaryResult.summary, origin, sessionId);
				console.log("[transcribe-continue] Pipeline complete for", meetingId);
				return;
			}
			console.log("[transcribe-continue] Summary not done:", summaryResult.message);
			// Map-reduce checkpoints and lock contention are recoverable — keep chaining
			if (/will continue|already in progress/i.test(summaryResult.message)) {
				await fireNext(origin, { ...body, audioUrl });
			}
			return;
		}

		// Poll step: the webhook fired before the recording finished uploading —
		// resolve the composite audio URL from the RTK recordings API ourselves.
		if (pollRecording && !audioUrl) {
			// Prefer the permanent R2 copy: it never expires, whereas RTK's
			// presigned URL dies after 7 days.
			const durable = await findSessionAudioRef(env.RECORDINGS_BUCKET, meetingId, sessionId);
			if (durable) {
				console.log("[transcribe-continue] Poll found permanent R2 copy", durable.key);
				await fireNext(origin, { ...body, audioUrl: `${origin}${durable.url}` });
				return;
			}
			const resolved = await pollForRecordingUrl(env, meetingId, sessionId);
			if (!resolved) {
				if (pollAttempt >= MAX_POLL_ATTEMPTS) {
					console.log("[transcribe-continue] Recording not UPLOADED after", pollAttempt, "polls — giving up for", meetingId);
					return;
				}
				console.log("[transcribe-continue] Recording not ready (poll", pollAttempt, "/", MAX_POLL_ATTEMPTS, ") — next link");
				await fireNext(origin, { ...body, pollAttempt: pollAttempt + 1 });
				return;
			}
			console.log("[transcribe-continue] Poll resolved audio URL for", meetingId, sessionId ? `session ${sessionId}` : "");
			// Hand off to the next link for transcription — this link already
			// spent up to ~18s polling, so transcribing inline here could
			// exceed the post-response budget.
			await fireNext(origin, { ...body, audioUrl: resolved });
			return;
		}

		// Transcription step
		console.log("[transcribe-continue] Continuing transcription for", meetingId, "owner:", owner);
		const tr = await transcribeCompositeAudio(env, meetingId, body.audioUrl || audioUrl, sessionId, owner);
		console.log("[transcribe-continue] Transcription result:", tr.status);

		if (tr.status === "processing" || tr.status === "transcribed") {
			// More chunks, or transcript just cached — either way the next link
			// picks it up (its cache check routes it to the summary step).
			await fireNext(origin, { ...body, audioUrl: body.audioUrl || audioUrl });
			return;
		}

		console.log("[transcribe-continue] Transcription stopped:", tr.status, ("message" in tr ? tr.message : undefined) || ("error" in tr ? tr.error : ""));
	} catch (e) {
		console.log("[transcribe-continue] runJob error:", e instanceof Error ? e.message : String(e));
	}
}

/**
 * Fire the next link in the chain. The next link acks instantly, so this
 * fetch completes in well under a second of waitUntil time.
 */
async function fireNext(origin: string, body: ContinueBody): Promise<void> {
	try {
		// Small delay to avoid hammering the API
		await new Promise((r) => setTimeout(r, 1500));
		const res = await fetch(new URL("/api/transcribe-continue", origin).toString(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		console.log("[transcribe-continue] next link status:", res.status);
	} catch (e) {
		console.log("[transcribe-continue] fireNext error:", e instanceof Error ? e.message : String(e));
	}
}

/**
 * Poll the RTK recordings API for the composite audio download URL.
 * Same selection rules as the webhook: UPLOADED status, non-track (no .webm),
 * session-scoped when a sessionId is known. Does a bounded number of checks
 * per invocation to stay inside the 30s wall-clock budget.
 */
async function pollForRecordingUrl(env: Env, meetingId: string, sessionId: string | undefined): Promise<string | undefined> {
	const authHeaders = {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};

	for (let check = 1; check <= POLL_CHECKS_PER_INVOCATION; check++) {
		await new Promise((r) => setTimeout(r, check === 1 ? 8000 : 10000));
		try {
			const recRes = await fetch(
				`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/recordings?meeting_id=${meetingId}&per_page=100`,
				{ headers: authHeaders },
			);
			if (!recRes.ok) {
				console.log("[transcribe-continue] Poll recordings fetch failed (check", check, "):", recRes.status);
				continue;
			}
		const recJson = await recRes.json() as { success: boolean; data?: import("../lib/recordings").RTKRecordingData[] };
		const recordings = recJson.data || [];

		// Pick the LATEST UPLOADED composite for this session — RTK may emit a
		// short empty segment first; the first match would transcribe silence.
		let composite = pickLatestCompositeRecording(recordings, meetingId, sessionId);
		if (!composite && !sessionId) {
			composite = pickLatestCompositeRecording(recordings, meetingId, undefined);
		}
		if (composite?.audio_download_url) {
				console.log("[transcribe-continue] Poll found UPLOADED composite on check", check, "for", meetingId);
				return composite.audio_download_url;
			}
			console.log("[transcribe-continue] Poll: recording not UPLOADED yet (check", check, "/", POLL_CHECKS_PER_INVOCATION, ") for", meetingId);
		} catch (e) {
			console.log("[transcribe-continue] Poll error:", e instanceof Error ? e.message : String(e));
		}
	}
	return undefined;
}


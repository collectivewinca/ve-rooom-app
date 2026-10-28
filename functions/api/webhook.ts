import { getCachedResult, getMeetingMeta, getParticipants, saveCachedResult, addSummaryVersion, getMeetingPrompt, getUserPrompt, markEmailFailed } from "../lib/kv";
import { jsonResponse } from "../lib/response";
import { generateSummary } from "../lib/summarizer";
import { sendSummaryEmails } from "../lib/summary-email";
import { pickLatestCompositeRecording, findSessionAudioRef, copyRecordingToR2, type RTKRecordingData } from "../lib/recordings";
import { checkRateLimit } from "../lib/rate-limit";
import { isAllowedMediaUrl, isValidUuid } from "../lib/url-guard";
import type { AppEnv } from "../lib/env";

type Env = AppEnv;

interface RTKWebhookEvent {
	event: string;
	meeting?: {
		id: string;
		sessionId?: string;
		title?: string;
	};
	recording?: {
		status?: string;
		downloadUrl?: string;
		audioDownloadUrl?: string;
		meetingId?: string;
		roomUUID?: string;
		err_message?: string;
	};
	transcriptDownloadUrl?: string;
	summaryDownloadUrl?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
	// 1. Rate limit. RealtimeKit fires a handful of events per meeting
	//    (recording.statusUpdate, meeting.ended, meeting.transcript,
	//    meeting.summary) and the transcription chain re-enters this app, so
	//    the ceiling is generous — but it is no longer unbounded.
	const rl = await checkRateLimit(env.MEETING_CACHE, request, { max: 120, windowSeconds: 60 });
	if (!rl.allowed) {
		console.log("[webhook] Rate limited");
		return jsonResponse(429, { error: "Too many requests" });
	}

	// 2. Optional shared secret. RealtimeKit can be configured to sign
	//    webhooks, but the dashboard has no secret set for this app, so the
	//    secret is opt-in via WEBHOOK_SECRET: when it is present the request
	//    must carry it (as `x-webhook-secret` or `rtk-signature`).
	const expectedSecret = env.WEBHOOK_SECRET?.trim();
	if (expectedSecret) {
		const provided = request.headers.get("x-webhook-secret") || request.headers.get("rtk-signature") || "";
		if (!timingSafeEqual(provided.trim(), expectedSecret)) {
			console.log("[webhook] Rejected: bad webhook secret");
			return jsonResponse(401, { error: "Invalid webhook secret" });
		}
	} else {
		const signature = request.headers.get("rtk-signature");
		if (!signature) {
			console.log("[webhook] No rtk-signature header — accepting request anyway (no webhook secret configured)");
		}
	}

	const body = await request.text();

	let event: RTKWebhookEvent;
	try {
		event = JSON.parse(body) as RTKWebhookEvent;
	} catch {
		return jsonResponse(400, { error: "Invalid JSON" });
	}

	console.log("[webhook] Received event:", event.event, "for meeting:", event.meeting?.id);

	// 3. Media host allowlist. Every URL in the payload is fetched by the
	//    Worker (audio → R2 + Whisper, transcript/summary → text). A hostile
	//    payload could otherwise point us at an arbitrary host.
	const origin = new URL(request.url).origin;
	const guard = {
		extraAllowedHosts: env.MEDIA_ALLOWED_HOSTS,
		allowHosts: [new URL(request.url).hostname],
	};

	const audioUrl = event.recording?.audioDownloadUrl || event.recording?.downloadUrl;
	if (audioUrl && !isAllowedMediaUrl(audioUrl, guard)) {
		console.log("[webhook] Rejected: media URL host not allowed");
		return jsonResponse(400, { error: "Media URL host not allowed" });
	}
	if (event.transcriptDownloadUrl && !isAllowedMediaUrl(event.transcriptDownloadUrl, guard)) {
		console.log("[webhook] Rejected: transcript URL host not allowed");
		return jsonResponse(400, { error: "Transcript URL host not allowed" });
	}
	if (event.summaryDownloadUrl && !isAllowedMediaUrl(event.summaryDownloadUrl, guard)) {
		console.log("[webhook] Rejected: summary URL host not allowed");
		return jsonResponse(400, { error: "Summary URL host not allowed" });
	}

	// 4. Identifiers become KV key prefixes and R2 object keys — keep them to
	//    plain UUIDs so a payload cannot inject other namespaces.
	const meetingId = event.recording?.meetingId || event.meeting?.id;
	if (meetingId && !isValidUuid(meetingId)) {
		console.log("[webhook] Rejected: invalid meeting id");
		return jsonResponse(400, { error: "Invalid meeting id" });
	}

	// Handle recording uploaded → run full transcription + summary + email pipeline.
	// RTK fires this with status UPLOADED when the recording is available in its
	// own bucket, even when the external R2 transfer fails (err_message set but
	// status is still UPLOADED). We also handle ERRORED in case the webhook fires
	// with that status — we can still recover by fetching the audio URL from the
	// RTK API, since RTK keeps the recording in its own bucket for 7 days.
	if (event.event === "recording.statusUpdate" && (event.recording?.status === "UPLOADED" || event.recording?.status === "ERRORED")) {
		const sessionId = event.recording?.roomUUID || event.meeting?.sessionId;
		const recStatus = event.recording?.status;
		console.log("[webhook] recording.statusUpdate status:", recStatus, "err_message present:", !!event.recording?.err_message);
		if (meetingId) {
			if (audioUrl) {
				// Take our own durable copy first-class: RTK only keeps the
				// recording for 7 days and its external-bucket transfer is
				// failing, so this is the only thing that outlives the meeting.
				fireR2Copy(waitUntil, env, meetingId, sessionId, audioUrl);
				// Webhook payload includes the audio URL — run pipeline directly
				waitUntil(runTranscriptionPipeline(env, meetingId, audioUrl, origin, sessionId, "webhook", waitUntil));
				return jsonResponse(200, { ok: true, processing: true, event: event.event });
			}
			// ERRORED or missing audio URL — fall back to fetching from RTK API
			console.log("[webhook] No audioDownloadUrl in payload (status:", recStatus, ") — fetching from RTK API");
			waitUntil(findAudioAndProcess(env, meetingId, origin, sessionId, waitUntil));
			return jsonResponse(200, { ok: true, processing: true, event: event.event });
		}
	}

	// Handle meeting ended → fetch recording audio URL then run pipeline.
	// This is the reliable fallback: recording.statusUpdate may fire with
	// ERRORED (when R2 transfer fails) or may not fire at all. meeting.ended
	// always fires, so we resolve the audio URL and hand off to the chain.
	if (event.event === "meeting.ended" && event.meeting?.id) {
		const meetingId = event.meeting.id;
		const sessionId = event.meeting.sessionId;
		waitUntil(findAudioAndProcess(env, meetingId, origin, sessionId, waitUntil));
		return jsonResponse(200, { ok: true, processing: true, event: event.event });
	}

	// Handle transcript ready → generate summary + send emails (RTK native transcript)
	if (event.event === "meeting.transcript" && event.meeting?.id && event.transcriptDownloadUrl) {
		const meetingId = event.meeting.id;
		const sessionId = event.meeting.sessionId;
		waitUntil(processTranscriptAndEmail(env, meetingId, event.transcriptDownloadUrl, request.url, sessionId));
		return jsonResponse(200, { ok: true, processing: true });
	}

	// Handle summary ready → download + send emails (RTK's own summary)
	if (event.event === "meeting.summary" && event.meeting?.id && event.summaryDownloadUrl) {
		const meetingId = event.meeting.id;
		const sessionId = event.meeting.sessionId;
		waitUntil(processRtkSummaryAndEmail(env, meetingId, event.summaryDownloadUrl, request.url, sessionId));
		return jsonResponse(200, { ok: true, processing: true });
	}

	return jsonResponse(200, { ok: true, event: event.event });
};

/**
 * Constant-time string comparison for the optional webhook secret.
 * Length differences short-circuit — the length of a shared secret is not
 * something worth hiding.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Kick off the transcription pipeline for a session.
 *
 * This only HANDS OFF to the self-continuing `/api/transcribe-continue` chain —
 * it never transcribes inline. The first chain link acks instantly and then gets
 * its own ~30s post-response budget for the first Whisper chunk. Doing the work
 * inline here (plus the recording poll sleeps in findAudioAndProcess) stacked
 * everything into one invocation, so the runtime killed it before it could
 * checkpoint a `:partial` key or fire the continuation — leaving the session
 * with no transcript, no partial, and no summary at all.
 */
async function runTranscriptionPipeline(env: Env, meetingId: string, audioUrl: string, origin: string, sessionId?: string, owner = "webhook", waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
	try {
		// Skip if already fully processed for this session
		const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (cached?.summary) {
			console.log("[webhook] Already have summary for", meetingId, sessionId ? `session ${sessionId}` : "", "— skipping");
			return;
		}

		console.log("[webhook] Firing transcription chain for", meetingId, sessionId ? `session ${sessionId}` : "", "owner:", owner);
		fireSelfContinue(waitUntil, env, meetingId, audioUrl, origin, sessionId, owner);
	} catch (e) {
		console.log("[webhook] Pipeline error:", e instanceof Error ? e.message : String(e));
	}
}

function fireSelfContinue(waitUntil: ((p: Promise<unknown>) => void) | undefined, env: Env, meetingId: string, audioUrl: string, origin: string, sessionId: string | undefined, owner: string): void {
	const url = new URL("/api/transcribe-continue", origin).toString();
	const fetchPromise = fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId, audioUrl, sessionId, owner }),
	}).then((res) => {
		console.log("[webhook] self-continue fetch status:", res.status);
	}).catch((e) => {
		console.log("[webhook] self-continue error:", e instanceof Error ? e.message : String(e));
	});

	if (waitUntil) {
		// Schedule as a separate waitUntil — gets its own execution budget
		waitUntil(fetchPromise);
	}
}

/**
 * Schedule the durable R2 copy as its own waitUntil so it streams in parallel
 * with transcription instead of delaying it. Failures are logged, never thrown —
 * the health-check cron on the KB VM is the backstop if RTK's URL is already
 * too old to copy from.
 */
function fireR2Copy(
	waitUntil: ((p: Promise<unknown>) => void) | undefined,
	env: Env,
	meetingId: string,
	sessionId: string | undefined,
	audioUrl: string,
): void {
	if (!env.RECORDINGS_BUCKET) return;
	const copy = copyRecordingToR2(env.RECORDINGS_BUCKET, meetingId, sessionId, audioUrl);
	if (waitUntil) waitUntil(copy);
}

/**
 * Resolve a finished session's audio and start the transcription chain.
 *
 * Order: permanent R2 copy (backfilled by the health-check, never expires) →
 * RTK API (valid for 7 days) → self-continuing poll chain.
 *
 * Deliberately does NOT sleep inline. Every waitUntil has a ~30s budget, and
 * the old 15s + 10s poll sleeps left no room for the first Whisper chunk, so
 * the invocation died before it could checkpoint or chain.
 */
async function findAudioAndProcess(env: Env, meetingId: string, origin: string, sessionId?: string, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
	try {
		// Skip if already processed for this session
		const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (cached?.summary) {
			console.log("[webhook] meeting.ended — already have summary for", meetingId, sessionId ? `session ${sessionId}` : "");
			return;
		}

		// 1. Permanent copy in our R2 bucket — works even when RTK's presigned
		//    URL has expired, and needs no API round trip at all.
		const durable = await findSessionAudioRef(env.RECORDINGS_BUCKET, meetingId, sessionId);
		if (durable) {
			console.log("[webhook] meeting.ended — using permanent R2 copy", durable.key);
			await runTranscriptionPipeline(env, meetingId, `${origin}${durable.url}`, origin, sessionId, "webhook-r2", waitUntil);
			return;
		}

		if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.RTK_APP_ID) {
			console.log("[webhook] meeting.ended — missing config");
			return;
		}

		const authHeaders = {
			Authorization: `Bearer ${env.CF_API_TOKEN}`,
			"Content-Type": "application/json",
		};

		// 2. Single immediate check against the RTK API. The recording is usually
		//    already UPLOADED when meeting.ended fires (recording stops at leave).
		let composite: RTKRecordingData | undefined;
		try {
			const recRes = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/recordings?meeting_id=${meetingId}&per_page=100`,
				{ headers: authHeaders },
			);
			if (recRes.ok) {
				const recJson = await recRes.json() as { success: boolean; data?: RTKRecordingData[] };
				const recordings = recJson.data || [];
				// Pick the LATEST composite for THIS session — RTK can emit a short
				// empty segment first; the first match would transcribe silence.
				composite = pickLatestCompositeRecording(recordings, meetingId, sessionId);
				if (!composite && !sessionId) {
					composite = pickLatestCompositeRecording(recordings, meetingId, undefined);
				}
			} else {
				console.log("[webhook] meeting.ended — recordings fetch failed:", recRes.status);
			}
		} catch (e) {
			console.log("[webhook] meeting.ended — recordings fetch error:", e instanceof Error ? e.message : String(e));
		}

		const audioUrl = composite?.audio_download_url;
		if (audioUrl) {
			console.log("[webhook] meeting.ended — found UPLOADED composite for", meetingId, sessionId ? `session ${sessionId}` : "");
			// No durable copy yet — take one now while the URL is still valid.
			fireR2Copy(waitUntil, env, meetingId, sessionId, audioUrl);
			await runTranscriptionPipeline(env, meetingId, audioUrl, origin, sessionId, "webhook-ended", waitUntil);
			return;
		}

		// 3. Not uploaded yet (or RTK has nothing) — hand the poll loop to the
		//    chain, which re-checks with its own fresh budget on every link.
		console.log("[webhook] meeting.ended — recording not ready — firing poll chain for", meetingId);
		fireRecordingPoll(waitUntil, env, meetingId, origin, sessionId);
	} catch (e) {
		console.log("[webhook] findAudioAndProcess error:", e instanceof Error ? e.message : String(e));
	}
}

/**
 * Fire a self-continue fetch to poll for the recording upload when it isn't
 * ready yet at meeting.ended time. The transcribe-continue endpoint handles
 * this: if no cached transcript exists and the body has `pollRecording: true`,
 * it polls the RTK recordings API until UPLOADED, then runs the pipeline.
 */
function fireRecordingPoll(waitUntil: ((p: Promise<unknown>) => void) | undefined, env: Env, meetingId: string, origin: string, sessionId: string | undefined): void {
	const url = new URL("/api/transcribe-continue", origin).toString();
	const fetchPromise = fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId, audioUrl: "", sessionId, owner: "webhook-poll", pollRecording: true }),
	}).then((res) => {
		console.log("[webhook] recording-poll self-continue status:", res.status);
	}).catch((e) => {
		console.log("[webhook] recording-poll self-continue error:", e instanceof Error ? e.message : String(e));
	});

	if (waitUntil) {
		waitUntil(fetchPromise);
	}
}

async function processTranscriptAndEmail(env: Env, meetingId: string, transcriptUrl: string, requestUrl: string, sessionId?: string): Promise<void> {
	try {
		const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (cached?.summary) {
			console.log("[webhook] Already have cached summary for", meetingId, sessionId ? `session ${sessionId}` : "");
			return;
		}

		const tfRes = await fetch(transcriptUrl);
		if (!tfRes.ok) {
			console.log("[webhook] Failed to download transcript:", tfRes.status);
			return;
		}
		const transcriptText = await tfRes.text();
		if (!transcriptText.trim()) {
			console.log("[webhook] Empty transcript for", meetingId);
			return;
		}

		let customPrompt: string | undefined;
		const mp = await getMeetingPrompt(env.MEETING_CACHE, meetingId);
		if (mp) {
			customPrompt = mp;
		} else {
			const meta = await getMeetingMeta(env.MEETING_CACHE, meetingId);
			if (meta?.createdBy?.email) {
				customPrompt = await getUserPrompt(env.MEETING_CACHE, meta.createdBy.email) || undefined;
			}
		}

		const summary = await generateSummary(transcriptText, env, customPrompt);
		if (!summary) {
			console.log("[webhook] Summary generation failed for", meetingId);
			return;
		}

		await saveCachedResult(env.MEETING_CACHE, meetingId, {
			transcript: transcriptText,
			summary,
			cachedAt: new Date().toISOString(),
		}, sessionId);
		await addSummaryVersion(env.MEETING_CACHE, meetingId, {
			summary,
			prompt: customPrompt,
			createdAt: new Date().toISOString(),
		}, sessionId);

		console.log("[webhook] Summary generated for", meetingId, sessionId ? `session ${sessionId}` : "");

		if (env.SMTP_API_URL) {
			const [meta, participants] = await Promise.all([
				getMeetingMeta(env.MEETING_CACHE, meetingId),
				getParticipants(env.MEETING_CACHE, meetingId),
			]);
			if (meta && participants.length > 0) {
				const appUrl = new URL(requestUrl).origin;
				const delivery = await sendSummaryEmails(env, {
					participants,
					meetingTitle: meta.title || "Untitled Meeting",
					creatorName: meta.createdBy?.name || "Someone",
					summary,
					meetingId,
					appUrl,
					sessionId,
				});
				if (delivery.sent > 0) {
					console.log("[webhook] Emails sent for", meetingId, sessionId ? `session ${sessionId}` : "");
				} else {
					await markEmailFailed(env.MEETING_CACHE, meetingId, sessionId, delivery.error || "all providers failed");
					console.log("[webhook] Emails FAILED for", meetingId, sessionId ? `session ${sessionId}` : "", "-", delivery.error);
				}			}
		}
	} catch (e) {
		console.log("[webhook] processTranscript error:", e);
	}
}

async function processRtkSummaryAndEmail(env: Env, meetingId: string, summaryUrl: string, requestUrl: string, sessionId?: string): Promise<void> {
	try {
		const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (cached?.summary) {
			console.log("[webhook] Already have cached summary for", meetingId, sessionId ? `session ${sessionId}` : "", "— skipping RTK summary");
			return;
		}

		const sumRes = await fetch(summaryUrl);
		if (!sumRes.ok) {
			console.log("[webhook] Failed to download RTK summary:", sumRes.status);
			return;
		}
		const summaryText = await sumRes.text();
		if (!summaryText.trim()) {
			console.log("[webhook] Empty RTK summary for", meetingId);
			return;
		}

		await saveCachedResult(env.MEETING_CACHE, meetingId, {
			transcript: "",
			summary: summaryText,
			cachedAt: new Date().toISOString(),
		}, sessionId);
		await addSummaryVersion(env.MEETING_CACHE, meetingId, {
			summary: summaryText,
			prompt: undefined,
			createdAt: new Date().toISOString(),
		}, sessionId);

		console.log("[webhook] RTK summary saved for", meetingId, sessionId ? `session ${sessionId}` : "");

		if (env.SMTP_API_URL) {
			const [meta, participants] = await Promise.all([
				getMeetingMeta(env.MEETING_CACHE, meetingId),
				getParticipants(env.MEETING_CACHE, meetingId),
			]);
			if (meta && participants.length > 0) {
				const appUrl = new URL(requestUrl).origin;
				const delivery = await sendSummaryEmails(env, {
					participants,
					meetingTitle: meta.title || "Untitled Meeting",
					creatorName: meta.createdBy?.name || "Someone",
					summary: summaryText,
					meetingId,
					appUrl,
					sessionId,
				});
				if (delivery.sent > 0) {
					console.log("[webhook] Emails sent for RTK summary", meetingId, sessionId ? `session ${sessionId}` : "");
				} else {
					await markEmailFailed(env.MEETING_CACHE, meetingId, sessionId, delivery.error || "all providers failed");
					console.log("[webhook] Emails FAILED for RTK summary", meetingId, sessionId ? `session ${sessionId}` : "", "-", delivery.error);
				}
			}
		}
	} catch (e) {
		console.log("[webhook] processRtkSummary error:", e);
	}
}

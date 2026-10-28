import { getCachedResult, getMeetingMeta, getParticipants, saveCachedResult, getMeetingPrompt, getUserPrompt, addSummaryVersion, getSummaryHistory, isEmailSent, markEmailSent, markEmailFailed, getTranscriptionLockOwner, getSummaryLockOwner, type SummaryVersion } from "../../lib/kv";
import { jsonResponse } from "../../lib/response";
import { checkRateLimit } from "../../lib/rate-limit";
import { parseSessionRecordings, loadRecordingRefs, sessionRecordingRefs, isSignedUrlExpired, type ParsedRecordings } from "../../lib/recordings";
import { generateSummary } from "../../lib/summarizer";
import { sendSummaryEmails } from "../../lib/summary-email";
import type { AppEnv } from "../../lib/env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

type Env = AppEnv;

async function resolvePrompt(env: Env, meetingId: string): Promise<string | undefined> {
	let prompt = await getMeetingPrompt(env.MEETING_CACHE, meetingId);
	if (!prompt) {
		const meta = await getMeetingMeta(env.MEETING_CACHE, meetingId);
		if (meta?.createdBy?.email) {
			prompt = await getUserPrompt(env.MEETING_CACHE, meta.createdBy.email);
		}
	}
	return prompt || undefined;
}

async function buildMeetingContext(env: Env, meetingId: string): Promise<string> {
	try {
		const [meta, participants] = await Promise.all([
			getMeetingMeta(env.MEETING_CACHE, meetingId),
			getParticipants(env.MEETING_CACHE, meetingId),
		]);
		if (!meta) return "";
		const title = meta.title || "Untitled Meeting";
		const hostName = meta.createdBy?.name || "Unknown";
		const date = new Date(meta.createdAt).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
		const participantNames = participants.length > 0
			? participants.map((p) => p.name || p.email).join(", ")
			: "Unknown";
		return `Meeting Context:\n- Title: ${title}\n- Host: ${hostName}\n- Date: ${date}\n- Participants: ${participantNames}\n\nUse this context to make your summary more accurate. Reference participants by name when possible.\n\n---\n\n`;
	} catch {
		return "";
	}
}

export const onRequestGet: PagesFunction<Env> = async ({ params, request, env, waitUntil }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { status: "error", error: "Too many requests. Please slow down." });

	const meetingId = params.id as string;
	const requestedSessionId = new URL(request.url).searchParams.get("sessionId");

	if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.RTK_APP_ID) {
		return jsonResponse(500, { status: "error", error: "Server missing Cloudflare configuration" });
	}

	const authHeaders = {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};

	const sessionsRes = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/sessions?meeting_id=${meetingId}&per_page=100`,
		{ headers: authHeaders }
	);

	if (!sessionsRes.ok) {
		return jsonResponse(sessionsRes.status, { status: "error", error: "Failed to fetch sessions" });
	}

	const sessionsJson = await sessionsRes.json() as {
		success: boolean;
		data?: { sessions?: { id: string; associated_id: string; status: string; ended_at?: string; recording_status?: string; total_participants?: number; recording_minutes_consumed?: number; transcription_minutes_consumed?: number }[] };
	};
	const allSessions = sessionsJson.data?.sessions || [];
	const meetingSessions = allSessions.filter((s) => s.associated_id === meetingId);

	let session: { id: string; associated_id: string; status: string; ended_at?: string; recording_status?: string; total_participants?: number; recording_minutes_consumed?: number; transcription_minutes_consumed?: number } | undefined;
	if (requestedSessionId) {
		session = meetingSessions.find((s) => s.id === requestedSessionId && s.status === "ENDED");
		console.log("[summary.ts] Requested sessionId:", requestedSessionId, "found in RTK:", !!session);
		// Trust the explicitly requested sessionId even if RTK hasn't listed it yet.
		// The KV cache is keyed by sessionId, so we can serve the correct session's
		// summary without falling back to the latest ended session (which would be wrong).
		if (!session) {
			session = { id: requestedSessionId, associated_id: meetingId, status: "ENDED" };
			console.log("[summary.ts] SessionId not in RTK response — proceeding with requested sessionId anyway");
		}
	}
	if (!session && !requestedSessionId) {
		const endedSessions = meetingSessions.filter((s) => s.status === "ENDED");
		endedSessions.sort((a, b) => (b.ended_at || "").localeCompare(a.ended_at || ""));
		// Prefer the latest ended session that has a recording; fall back to latest ended
		session = endedSessions.find((s) => s.recording_status === "UPLOADED" || s.recording_status === "RECORDING") || endedSessions[0];
		console.log("[summary.ts] Falling back to latest ended session with recording:", session?.id);
	}

	console.log("[summary.ts] Ended sessions for meeting:", meetingSessions.filter((s) => s.status === "ENDED").length, "Using:", session?.id, "ended_at:", session?.ended_at);

	if (!session) {
		return jsonResponse(200, { status: "no_ended_session" });
	}

	const activeSessionId = session.id;

	const cached = await getCachedResult(env.MEETING_CACHE, meetingId, activeSessionId);
	// R2 is the source of truth — the KV ref cache can point at objects that no
	// longer exist, which would hand the client download links that 404.
	const r2Refs = await loadRecordingRefs(env.RECORDINGS_BUCKET, env.MEETING_CACHE, meetingId);
	if (r2Refs.length > 0) console.log("[summary.ts] Recording refs:", r2Refs.length, "for meeting", meetingId);
	let history = await getSummaryHistory(env.MEETING_CACHE, meetingId, activeSessionId);
	const hasR2 = r2Refs.length > 0;
	const customPrompt = await resolvePrompt(env, meetingId);
	if (customPrompt) console.log("[summary.ts] Using custom prompt for", meetingId, `(${customPrompt.length} chars)`);
	if (hasR2) console.log("[summary.ts] R2 recording refs:", r2Refs.length, "for meeting", meetingId);

	// Seed history with existing cached summary if history is empty
	if (history.length === 0 && cached?.summary) {
		const seeded: SummaryVersion = { summary: cached.summary, prompt: customPrompt || undefined, createdAt: cached.cachedAt || new Date().toISOString() };
		await addSummaryVersion(env.MEETING_CACHE, meetingId, seeded, activeSessionId);
		history = [seeded];
		console.log("[summary.ts] Seeded history from cached summary for", meetingId, "session", activeSessionId);
	}
	if (history.length > 0) console.log("[summary.ts] Summary history:", history.length, "versions for session", activeSessionId);

	// Session-scoped R2 refs: never expose another session's recording as "the"
	// recording for this session. The meeting-wide list (`r2Refs`) still backs
	// the client's display when this session simply has no permanent copy yet.
	const sessionRefs = sessionRecordingRefs(r2Refs, activeSessionId);
	const r2RecordingUrl = sessionRefs.find((r) => r.type === "composite")?.url;
	const r2AudioUrl = sessionRefs.find((r) => r.type === "audio")?.url;
	const r2RecordingsForClient = sessionRefs.length > 0 ? sessionRefs : r2Refs;

	/**
	 * Pick the best usable download/transcription URL per media type.
	 * - Audio: prefer the permanent R2 copy (RTK presigned URLs die after 7 days).
	 * - Video: prefer RTK while its presigned URL is still live (the health-check
	 *   script only guarantees audio copies), else the R2 copy if we have one.
	 * - Unusable presigned URLs are dropped entirely rather than returned broken.
	 */
	const urlsFor = (parsed: ParsedRecordings): { recordingUrl?: string; audioRecordingUrl?: string } => {
		const rtkAudioUsable = parsed.audioRecordingUrl && !isSignedUrlExpired(parsed.audioRecordingUrl) ? parsed.audioRecordingUrl : undefined;
		const rtkVideoUsable = parsed.recordingUrl && !isSignedUrlExpired(parsed.recordingUrl) ? parsed.recordingUrl : undefined;
		return {
			recordingUrl: rtkVideoUsable || r2RecordingUrl,
			audioRecordingUrl: r2AudioUrl || rtkAudioUsable,
		};
	};

	async function fetchRecordings() {
		return fetch(
			`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/recordings?meeting_id=${meetingId}&per_page=100`,
			{ headers: authHeaders }
		).catch(() => null);
	}

	async function fetchTranscriptUrl() {
		try {
			const res = await fetch(
				`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/sessions/${activeSessionId}/transcript`,
				{ headers: authHeaders }
			);
			if (res.ok) {
				const tj = await res.json() as { success: boolean; data?: { transcript_download_url?: string; downloadUrl?: string } };
				return tj.data?.transcript_download_url || tj.data?.downloadUrl;
			}
		} catch (e) {
			console.log("[summary.ts] Transcript fetch error:", e);
		}
		return undefined;
	}

	// Cache hit: full summary + transcript
	if (cached && cached.summary && cached.transcript) {
		const [transcriptUrl, recRes] = await Promise.all([fetchTranscriptUrl(), fetchRecordings()]);
		const parsed = await parseSessionRecordings(recRes, meetingId, activeSessionId);
		const { recordingUrl, audioRecordingUrl } = urlsFor(parsed);
		const meta = await getMeetingMeta(env.MEETING_CACHE, meetingId);
		const participants = await getParticipants(env.MEETING_CACHE, meetingId);

		return jsonResponse(200, {
			status: "ok",
			summary: cached.summary,
			transcriptUrl,
			recordingUrl,
			audioRecordingUrl,
			r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
			sessionId: activeSessionId,
			transcript_text: cached.transcript,
			cachedAt: cached.cachedAt,
			meetingMeta: meta || undefined,
			participants: participants.length > 0 ? participants : undefined,
			prompt: customPrompt,
			history: history.length > 0 ? history : undefined,
		});
	}

	// Cache hit: transcript only (no summary yet) — generate summary server-side
	if (cached && cached.transcript && !cached.summary) {
		// Check if webhook is actively processing this meeting (transcription OR summary lock)
		const lockOwner = await getTranscriptionLockOwner(env.MEETING_CACHE, meetingId, activeSessionId);
		const summaryLockOwner = await getSummaryLockOwner(env.MEETING_CACHE, meetingId, activeSessionId);
		const webhookBusy = (lockOwner && lockOwner.startsWith("webhook")) || (summaryLockOwner && summaryLockOwner.startsWith("summary-"));
		if (webhookBusy) {
			console.log("[summary.ts] Webhook is processing (transcribeLock=", !!lockOwner, "summaryLock=", !!summaryLockOwner, ") — deferring to webhook, returning processing");
			const recRes = await fetchRecordings();
			const parsed = await parseSessionRecordings(recRes, meetingId, activeSessionId);
			return jsonResponse(200, {
				status: "processing",
				summary: undefined,
				recordingUrl: urlsFor(parsed).recordingUrl,
				audioRecordingUrl: urlsFor(parsed).audioRecordingUrl,
				r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
				sessionId: activeSessionId,
				transcript_text: cached.transcript,
				prompt: customPrompt,
				history: history.length > 0 ? history : undefined,
			});
		}

		const recRes = await fetchRecordings();
		const parsed = await parseSessionRecordings(recRes, meetingId, activeSessionId);

		const transcriptLen = cached.transcript.length;
		let summary: string | undefined;
		let updatedHistory = history;

		if (transcriptLen > 200000) {
			// Long transcript — defer to frontend map-reduce (avoids 30s timeout)
			console.log("[summary.ts] Transcript", transcriptLen, "chars — deferring summary to frontend map-reduce");
			return jsonResponse(200, {
				status: "no_summary",
				summary: undefined,
				recordingUrl: urlsFor(parsed).recordingUrl,
				audioRecordingUrl: urlsFor(parsed).audioRecordingUrl,
				r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
				sessionId: activeSessionId,
				transcript_text: cached.transcript,
				prompt: customPrompt,
				history: updatedHistory.length > 0 ? updatedHistory : undefined,
			});
		}

		summary = await generateSummary(await buildMeetingContext(env, meetingId) + cached.transcript, env, customPrompt);
		if (summary) {
			await saveCachedResult(env.MEETING_CACHE, meetingId, { transcript: cached.transcript, summary, cachedAt: cached.cachedAt }, activeSessionId);
			const newVersion: SummaryVersion = { summary, prompt: customPrompt, createdAt: new Date().toISOString() };
			await addSummaryVersion(env.MEETING_CACHE, meetingId, newVersion, activeSessionId);
			updatedHistory = [...history, newVersion];
			if (env.SMTP_API_URL) {
				waitUntil(sendAutoEmails(env, meetingId, summary, request.url, session, parsed, undefined, activeSessionId));
			}
		}

		return jsonResponse(200, {
			status: summary ? "ok" : "no_summary",
			summary,
			recordingUrl: urlsFor(parsed).recordingUrl,
			audioRecordingUrl: urlsFor(parsed).audioRecordingUrl,
			r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
			sessionId: activeSessionId,
			transcript_text: cached.transcript,
			prompt: customPrompt,
			history: updatedHistory.length > 0 ? updatedHistory : undefined,
		});
	}

	// No cache: fetch RTK transcript URL + recordings
	const [transcriptUrl, recRes] = await Promise.all([fetchTranscriptUrl(), fetchRecordings()]);
	const parsed = await parseSessionRecordings(recRes, meetingId, activeSessionId);

	let transcriptText = "";
	if (transcriptUrl) {
		try {
			const tfRes = await fetch(transcriptUrl);
			if (tfRes.ok) transcriptText = await tfRes.text();
		} catch (e) {
			console.log("[summary.ts] Transcript download error:", e);
		}
	}

	const transcriptLines = transcriptText.trim().split("\n").filter((l) => l.trim());
	if (transcriptLines.length > 0) {
		const summary = await generateSummary(await buildMeetingContext(env, meetingId) + transcriptText, env, customPrompt);
		await saveCachedResult(env.MEETING_CACHE, meetingId, { transcript: transcriptText, summary: summary || "", cachedAt: new Date().toISOString() }, activeSessionId);
		let updatedHistory = history;
		if (summary) {
			const newVersion: SummaryVersion = { summary, prompt: customPrompt, createdAt: new Date().toISOString() };
			await addSummaryVersion(env.MEETING_CACHE, meetingId, newVersion, activeSessionId);
			updatedHistory = [...history, newVersion];
			if (env.SMTP_API_URL) {
				waitUntil(sendAutoEmails(env, meetingId, summary, request.url, session, parsed, transcriptUrl, activeSessionId));
			}
		}
		return jsonResponse(200, {
			status: summary ? "ok" : "no_summary",
			summary,
			transcriptUrl,
			recordingUrl: urlsFor(parsed).recordingUrl,
			audioRecordingUrl: urlsFor(parsed).audioRecordingUrl,
			r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
			sessionId: activeSessionId,
			transcript_text: transcriptText,
			prompt: customPrompt,
			history: updatedHistory.length > 0 ? updatedHistory : undefined,
			sessionInfo: {
				total_participants: session.total_participants,
				recording_minutes: session.recording_minutes_consumed,
				transcription_minutes: session.transcription_minutes_consumed,
				ended_at: session.ended_at,
			},
		});
	}

	// RTK transcript empty — return needs_transcription so frontend triggers /api/transcribe
	// But if the webhook is already transcribing OR summarizing, return processing instead
	const lockOwner2 = await getTranscriptionLockOwner(env.MEETING_CACHE, meetingId, activeSessionId);
	const summaryLockOwner2 = await getSummaryLockOwner(env.MEETING_CACHE, meetingId, activeSessionId);
	const webhookBusy2 = (lockOwner2 && lockOwner2.startsWith("webhook")) || (summaryLockOwner2 && summaryLockOwner2.startsWith("summary-"));
	if (webhookBusy2) {
		console.log("[summary.ts] Webhook is transcribing/summarizing — returning processing instead of needs_transcription");
		return jsonResponse(200, {
			status: "processing",
			transcriptUrl,
			recordingUrl: urlsFor(parsed).recordingUrl,
			audioRecordingUrl: urlsFor(parsed).audioRecordingUrl,
			r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
			sessionId: activeSessionId,
			transcript_text: transcriptText,
			prompt: customPrompt,
			history: history.length > 0 ? history : undefined,
		});
	}

	console.log("[summary.ts] RTK transcript empty — returning needs_transcription for client-side Whisper");
	return jsonResponse(200, {
		status: "needs_transcription",
		transcriptUrl,
		recordingUrl: urlsFor(parsed).recordingUrl,
		audioRecordingUrl: urlsFor(parsed).audioRecordingUrl,
		r2Recordings: hasR2 ? r2RecordingsForClient : undefined,
		sessionId: activeSessionId,
		transcript_text: transcriptText,
		prompt: customPrompt,
		history: history.length > 0 ? history : undefined,
		sessionInfo: {
			total_participants: session.total_participants,
			recording_minutes: session.recording_minutes_consumed,
			transcription_minutes: session.transcription_minutes_consumed,
			ended_at: session.ended_at,
		},
	});
};

async function sendAutoEmails(
	env: Env,
	meetingId: string,
	summary: string,
	requestUrl: string,
	sessionInfo: { ended_at?: string },
	recordingInfo: { recordingUrl?: string; audioRecordingUrl?: string },
	transcriptUrl?: string,
	sessionId?: string,
): Promise<void> {
	try {
		// Only auto-email on the first summary per session — re-generates use the Send Email button
		const alreadySent = await isEmailSent(env.MEETING_CACHE, meetingId, sessionId);
		if (alreadySent) {
			console.log("[summary.ts] Email already sent for", meetingId, sessionId ? `session ${sessionId}` : "", "— skipping auto-email");
			return;
		}
		const [meta, participants] = await Promise.all([
			getMeetingMeta(env.MEETING_CACHE, meetingId),
			getParticipants(env.MEETING_CACHE, meetingId),
		]);
		const recipients = [...participants];
		if (env.ALWAYS_EMAIL) {
			for (const addr of env.ALWAYS_EMAIL.split(",").map((s) => s.trim()).filter(Boolean)) {
				if (!recipients.some((p) => p.email.toLowerCase() === addr.toLowerCase())) {
					recipients.push({ email: addr, name: addr.split("@")[0], joinedAt: "" });
				}
			}
		}
		if (meta && recipients.length > 0) {
			const url = new URL(requestUrl);
			const result = await sendSummaryEmails(env, {
				participants: recipients,
				meetingTitle: meta.title || "Untitled Meeting",
				creatorName: meta.createdBy?.name || "Someone",
				summary,
				meetingId,
				appUrl: url.origin,
				alwaysEmail: env.ALWAYS_EMAIL,
				meetingDate: meta.createdAt,
				endedAt: sessionInfo.ended_at,
				recordingUrl: recordingInfo.recordingUrl || undefined,
				transcriptUrl: transcriptUrl || undefined,
				sessionId,
			});
			if (result.sent > 0) {
				await markEmailSent(env.MEETING_CACHE, meetingId, sessionId);
			} else {
				await markEmailFailed(env.MEETING_CACHE, meetingId, sessionId, result.error || "all providers failed");
				console.log("[summary.ts] Auto email FAILED for", meetingId, sessionId, "-", result.error);
			}
		}
	} catch (e) {
		console.log("[summary.ts] Auto email error:", e);
	}
}


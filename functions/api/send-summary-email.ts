import { getCachedResult, getMeetingMeta, getParticipants, getRecordingRefs, markEmailSent, markEmailFailed } from "../lib/kv";
import { jsonResponse } from "../lib/response";
import { checkRateLimit } from "../lib/rate-limit";
import { sendSummaryEmails } from "../lib/summary-email";
import type { AppEnv } from "../lib/env";

type Env = Pick<AppEnv, "MEETING_CACHE" | "SMTP_API_URL" | "ALWAYS_EMAIL" | "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "RESEND_API_KEY" | "EMAIL_FROM">;

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	const body = await request.json() as { meetingId?: string; sessionId?: string };
	const meetingId = body.meetingId;
	const sessionId = body.sessionId;

	if (!meetingId) {
		return jsonResponse(400, { error: "meetingId is required" });
	}

	// Get the latest summary from KV (the most recent version, not an old one)
	const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
	if (!cached || !cached.summary) {
		return jsonResponse(200, { status: "error", message: "No summary available to send. Generate a summary first." });
	}

	const meta = await getMeetingMeta(env.MEETING_CACHE, meetingId);
	const participants = await getParticipants(env.MEETING_CACHE, meetingId);
	const r2Refs = await getRecordingRefs(env.MEETING_CACHE, meetingId);

	if (!meta) {
		return jsonResponse(200, { status: "error", message: "Meeting metadata not found." });
	}

	// Get recording URLs for the email
	let recordingUrl: string | undefined;
	let audioRecordingUrl: string | undefined;
	let endedAt: string | undefined;

	const r2RecordingUrl = r2Refs.find((r) => r.type === "composite")?.url;
	recordingUrl = r2RecordingUrl;
	audioRecordingUrl = r2Refs.find((r) => r.type === "audio")?.url;

	// Try to fetch session info for endedAt
	if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.RTK_APP_ID) {
		try {
			const authHeaders = { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };
			const sessionsRes = await fetch(
				`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/sessions?meeting_id=${meetingId}&per_page=100`,
				{ headers: authHeaders }
			);
			if (sessionsRes.ok) {
				const sj = await sessionsRes.json() as { data?: { sessions?: { associated_id: string; status: string; ended_at?: string }[] } };
				const ended = (sj.data?.sessions || []).filter((s) => s.associated_id === meetingId && s.status === "ENDED");
				ended.sort((a, b) => (b.ended_at || "").localeCompare(a.ended_at || ""));
				endedAt = ended[0]?.ended_at;
			}
		} catch { }
	}

	const recipients = [...participants];
	if (env.ALWAYS_EMAIL) {
		for (const addr of env.ALWAYS_EMAIL.split(",").map((s) => s.trim()).filter(Boolean)) {
			if (!recipients.some((p) => p.email.toLowerCase() === addr.toLowerCase())) {
				recipients.push({ email: addr, name: addr.split("@")[0], joinedAt: "" });
			}
		}
	}

	if (recipients.length === 0) {
		return jsonResponse(200, { status: "error", message: "No participants to email." });
	}

	const url = new URL(request.url);
	const result = await sendSummaryEmails(env, {
		participants: recipients,
		meetingTitle: meta.title || "Untitled Meeting",
		creatorName: meta.createdBy?.name || "Someone",
		summary: cached.summary,
		meetingId,
		appUrl: url.origin,
		alwaysEmail: env.ALWAYS_EMAIL,
		meetingDate: meta.createdAt,
		endedAt,
		recordingUrl,
		sessionId,
	});

	if (result.sent > 0) {
		await markEmailSent(env.MEETING_CACHE, meetingId, sessionId);
	} else {
		await markEmailFailed(env.MEETING_CACHE, meetingId, sessionId, result.error || "all providers failed");
	}

	return jsonResponse(200, {
		status: result.sent > 0 ? "ok" : "error",
		sent: result.sent,
		failed: result.failed,
		provider: result.provider,
		error: result.error,
		message: result.sent > 0 ? `Email sent to ${result.sent} recipient(s).` : "Email send failed.",
	});
};
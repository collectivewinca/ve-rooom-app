import { getMeetingMeta, getParticipants, getCachedResult } from "../lib/kv";
import { jsonResponse } from "../lib/response";
import { checkRateLimit } from "../lib/rate-limit";
import type { AppEnv } from "../lib/env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

type Env = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "MEETING_CACHE">;

interface RTKMeeting {
	id: string;
	title?: string;
	status?: string;
	created_at: string;
	updated_at: string;
}

interface RTKSession {
	id: string;
	associated_id: string;
	status: string;
	ended_at?: string;
	created_at?: string;
	started_at?: string;
	recording_status?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.RTK_APP_ID) {
		return jsonResponse(500, { error: "Server missing configuration" });
	}

	const url = new URL(request.url);
	const daysParam = url.searchParams.get("days") || "3";
	const days = Math.max(1, Math.min(90, parseInt(daysParam, 10) || 3));
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - days);

	const authHeaders = {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};

	const res = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/meetings?per_page=100`,
		{ headers: authHeaders }
	);

	if (!res.ok) {
		return jsonResponse(res.status, { error: "Failed to fetch meetings" });
	}

	const json = await res.json() as { success: boolean; data?: RTKMeeting[] };
	const allMeetings = json.data || [];

	const recentMeetings = allMeetings.filter((m) => {
		const createdAt = new Date(m.created_at);
		return createdAt >= cutoff;
	});

	// Fetch sessions for each recent meeting in parallel, then resolve the latest
	// ENDED session so we read the session-scoped KV cache (summaries/transcripts are
	// saved at meeting:{id}:session:{sessionId}:result, NOT meeting:{id}:result).
	const sessionResults = await Promise.all(
		recentMeetings.map((m) =>
			fetch(
				`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/sessions?meeting_id=${m.id}&per_page=100`,
				{ headers: authHeaders }
			)
				.then((r) => r.json() as Promise<{ success: boolean; data?: { sessions?: RTKSession[] } }>)
				.then((j) => ({ meetingId: m.id, sessions: (j.data?.sessions || []).filter((s) => s.associated_id === m.id) }))
				.catch(() => ({ meetingId: m.id, sessions: [] as RTKSession[] }))
		)
	);
	const sessionsByMeeting: Record<string, RTKSession[]> = {};
	for (const sr of sessionResults) {
		sr.sessions.sort((a, b) => (b.ended_at || b.created_at || b.started_at || "").localeCompare(a.ended_at || a.created_at || a.started_at || ""));
		sessionsByMeeting[sr.meetingId] = sr.sessions;
	}

	const data = await Promise.all(
		recentMeetings.map(async (m) => {
			const [meta, participants] = await Promise.all([
				getMeetingMeta(env.MEETING_CACHE, m.id),
				getParticipants(env.MEETING_CACHE, m.id),
			]);
			// Resolve the latest ENDED session (same logic as summary/[id].ts) so we
			// read the session-scoped cache key, not the never-written meeting-level key.
			const endedSessions = (sessionsByMeeting[m.id] || []).filter((s) => s.status === "ENDED");
			const latestEnded = endedSessions[0];
			const result = latestEnded ? await getCachedResult(env.MEETING_CACHE, m.id, latestEnded.id) : null;
			return {
				meetingId: m.id,
				title: meta?.title || m.title || "",
				status: m.status,
				createdAt: m.created_at,
				createdBy: meta?.createdBy || null,
				participants: participants || [],
				sessionId: latestEnded?.id || null,
				endedAt: latestEnded?.ended_at || null,
				hasTranscript: !!(result?.transcript),
				hasSummary: !!(result?.summary),
				cachedAt: result?.cachedAt || null,
				summary: result?.summary || null,
			};
		})
	);

	return jsonResponse(200, { days, cutoff: cutoff.toISOString(), count: data.length, meetings: data });
};

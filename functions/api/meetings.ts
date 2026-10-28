import { getMeetingMeta, getParticipants, type ParticipantRecord } from "../lib/kv";
import { verifyAuthToken } from "../auth";
import { jsonResponse } from "../lib/response";
import { checkRateLimit } from "../lib/rate-limit";
import type { AppEnv } from "../lib/env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

type Env = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "MEETING_CACHE" | "FORMSDB_URL" | "ADMIN_EMAILS">;

interface RTKMeeting {
	id: string;
	title?: string;
	status?: string;
	created_at: string;
	updated_at: string;
	record_on_start?: boolean;
	transcribe_on_end?: boolean;
	summarize_on_end?: boolean;
}

interface RTKSession {
	id: string;
	associated_id: string;
	status: string;
	recording_status?: string;
	created_at?: string;
	updated_at?: string;
	started_at?: string;
	ended_at?: string;
	total_participants?: number;
	recording_minutes_consumed?: number;
	transcription_minutes_consumed?: number;
}

interface RTKRecording {
	id: string;
	meeting_id: string;
	session_id?: string;
	status: string;
	type?: string;
	output_file_name?: string;
	download_url?: unknown;
	audio_download_url?: string;
	invoked_time?: string;
}

interface MeetingWithSessions extends RTKMeeting {
	sessions: {
		id: string;
		status: string;
		recording_status?: string;
		created_at?: string;
		ended_at?: string;
		participant_count?: number;
		recording_minutes?: number;
		transcription_minutes?: number;
		recordings: {
			id: string;
			status: string;
			type: string;
			invoked_time?: string;
			recording_duration?: number;
			has_video: boolean;
			has_audio: boolean;
		}[];
	}[];
	createdBy?: { email: string; name: string };
	participants?: ParticipantRecord[];
	hasCachedSummary?: boolean;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.RTK_APP_ID) {
		return jsonResponse(500, { error: "Server missing configuration" });
	}

	const authHeader = request.headers.get("Authorization");
	const authToken = authHeader?.replace("Bearer ", "") || undefined;
	const user = await verifyAuthToken(authToken, env);
	if (!user) return jsonResponse(401, { error: "Authentication required. Please sign in." });

	const admins = (env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
	const isAdmin = !!user.email && admins.includes(user.email.toLowerCase());

	const authHeaders = {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};

	console.log("[meetings.ts] Fetching meetings from RealtimeKit");

	const res = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/meetings?per_page=100`,
		{ headers: authHeaders }
	);

	console.log("[meetings.ts] Response status:", res.status);

	if (!res.ok) {
		const errText = await res.text();
		console.log("[meetings.ts] Fetch failed:", errText);
		return jsonResponse(res.status, { error: "Failed to fetch meetings" });
	}

	const json = await res.json() as {
		success: boolean;
		data?: RTKMeeting[];
		paging?: { total_count: number };
	};

	const meetings = json.data || [];
	console.log("[meetings.ts] Meetings found:", meetings.length);

	const allRecordingsRes = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/recordings?per_page=100`,
		{ headers: authHeaders }
	).catch((e) => {
		console.log("[meetings.ts] Recordings fetch error:", e);
		return null;
	});

	let recordingsByMeeting: Record<string, RTKRecording[]> = {};
	if (allRecordingsRes && allRecordingsRes.ok) {
		const recJson = await allRecordingsRes.json() as { success: boolean; data?: RTKRecording[] };
		for (const rec of recJson.data || []) {
			const mid = rec.meeting_id;
			if (!recordingsByMeeting[mid]) recordingsByMeeting[mid] = [];
			recordingsByMeeting[mid].push(rec);
		}
		console.log("[meetings.ts] Recordings loaded for", Object.keys(recordingsByMeeting).length, "meetings");
	}

	const sessionsResults = await Promise.all(
		meetings.map((m) =>
			fetch(
				`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/sessions?meeting_id=${m.id}&per_page=100`,
				{ headers: authHeaders }
			)
			.then((r) => r.json() as Promise<{ success: boolean; data?: { sessions?: RTKSession[] } }>)
			.then((j) => ({ meetingId: m.id, sessions: j.data?.sessions || [] }))
			.catch((e) => {
				console.log("[meetings.ts] Sessions fetch failed for", m.id, ":", e);
				return { meetingId: m.id, sessions: [] as RTKSession[] };
			})
		)
	);

	const sessionsByMeeting: Record<string, RTKSession[]> = {};
	for (const sr of sessionsResults) {
		// Filter to this meeting's sessions, sort by created_at DESC (latest first)
		const filtered = sr.sessions.filter((s) => s.associated_id === sr.meetingId);
		filtered.sort((a, b) => (b.created_at || b.started_at || "").localeCompare(a.created_at || a.started_at || ""));
		sessionsByMeeting[sr.meetingId] = filtered;
	}
	console.log("[meetings.ts] Sessions loaded for", Object.keys(sessionsByMeeting).length, "meetings");

	// Fetch KV data for all meetings in parallel
	const kvResults = await Promise.all(
		meetings.map(async (m) => {
			const [meta, participants, cached] = await Promise.all([
				getMeetingMeta(env.MEETING_CACHE, m.id).catch(() => null),
				getParticipants(env.MEETING_CACHE, m.id).catch(() => []),
				env.MEETING_CACHE.get(`meeting:${m.id}:result`).catch(() => null),
			]);
			return { meetingId: m.id, meta, participants, hasCache: !!cached };
		})
	);
	const kvByMeeting: Record<string, { meta: ReturnType<typeof getMeetingMeta> extends Promise<infer T> ? T : never; participants: ParticipantRecord[]; hasCache: boolean }> = {};
	for (const kv of kvResults) {
		kvByMeeting[kv.meetingId] = { meta: kv.meta, participants: kv.participants, hasCache: kv.hasCache };
	}

	let meetingsWithSessions: MeetingWithSessions[] = meetings.map((m) => {
		const meetingSessions = sessionsByMeeting[m.id] || [];
		const meetingRecordings = recordingsByMeeting[m.id] || [];

		const sessions = meetingSessions.map((s) => {
			const sessionRecordings = meetingRecordings
				.filter((r) => r.session_id === s.id)
				.filter((r) => {
					const isTrack = (r.output_file_name || "").includes(".webm") || typeof r.download_url !== "string";
					return !isTrack;
				});
			const recordings = sessionRecordings.map((r) => {
				return {
					id: r.id,
					status: r.status,
					type: "composite" as const,
					invoked_time: r.invoked_time,
					recording_duration: (r as unknown as Record<string, unknown>).recording_duration as number | undefined,
					has_video: typeof r.download_url === "string",
					has_audio: !!r.audio_download_url,
				};
			});

			return {
				id: s.id,
				status: s.status,
				recording_status: s.recording_status,
				created_at: s.created_at || s.started_at,
				ended_at: s.ended_at,
				participant_count: s.total_participants,
				recording_minutes: s.recording_minutes_consumed,
				transcription_minutes: s.transcription_minutes_consumed,
				recordings,
			};
		});

		return {
			...m,
			sessions,
			createdBy: kvByMeeting[m.id]?.meta?.createdBy,
			participants: kvByMeeting[m.id]?.participants,
			hasCachedSummary: kvByMeeting[m.id]?.hasCache,
		};
	});

	if (!isAdmin) {
		const participantEmail = user.email.toLowerCase();
		meetingsWithSessions = meetingsWithSessions.filter((m) => {
			if ((m.createdBy?.email || "").toLowerCase() === participantEmail) return true;
			if (m.participants && m.participants.some((p) => (p.email || "").toLowerCase() === participantEmail)) return true;
			return false;
		});
	}

	console.log(`[meetings.ts] Returning ${meetingsWithSessions.length} meetings${isAdmin ? " (admin)" : ` for ${user.email}`}`);

	return jsonResponse(200, { meetings: meetingsWithSessions });
};

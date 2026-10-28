import { ensureIdentity, updateIdentityName } from "./identity";

export interface CreateRoomResponse {
	roomId: string;
	authToken: string;
}

export interface JoinRoomResponse {
	authToken: string;
}

export interface RecordingRef {
	key: string;
	url: string;
	type: "composite" | "audio";
	size?: number;
	uploadedAt?: string;
}

export interface SummaryVersion {
	summary: string;
	prompt?: string;
	createdAt: string;
}

export interface SummaryResponse {
	status: "ok" | "processing" | "no_ended_session" | "no_summary" | "error" | "needs_transcription" | "silent";
	summary?: string;
	transcriptUrl?: string;
	recordingUrl?: string;
	audioRecordingUrl?: string;
	r2Recordings?: RecordingRef[];
	sessionId?: string;
	error?: string;
	transcript_text?: string;
	prompt?: string;
	history?: SummaryVersion[];
	sessionInfo?: {
		total_participants?: number;
		recording_minutes?: number;
		transcription_minutes?: number;
		ended_at?: string;
	};
	cachedAt?: string;
	meetingMeta?: { createdBy: { email: string; name: string }; title: string; createdAt: string };
	participants?: MeetingParticipant[];
}

export interface TranscribeResponse {
	status: "transcribed" | "no_speech" | "too_large" | "whisper_failed" | "error" | "silent" | "processing";
	transcript?: string;
	message?: string;
	sizeMb?: string;
	numChunks?: number;
	chunksDone?: number;
	totalChunks?: number;
}

export interface GenerateSummaryResponse {
	status: "ok" | "no_summary" | "processing";
	summary?: string;
	message?: string;
	chunksDone?: number;
	totalChunks?: number;
}

export interface SessionRecording {
	id: string;
	status: string;
	type: "composite";
	invoked_time?: string;
	recording_duration?: number;
	has_video: boolean;
	has_audio: boolean;
}

export interface MeetingSession {
	id: string;
	status: string;
	recording_status?: string;
	created_at?: string;
	ended_at?: string;
	participant_count?: number;
	recording_minutes?: number;
	transcription_minutes?: number;
	recordings: SessionRecording[];
}

export interface MeetingParticipant {
	email: string;
	name: string;
	joinedAt: string;
}

export interface MeetingWithSessions {
	id: string;
	title?: string;
	status?: string;
	created_at: string;
	updated_at: string;
	record_on_start?: boolean;
	transcribe_on_end?: boolean;
	summarize_on_end?: boolean;
	sessions: MeetingSession[];
	createdBy?: { email: string; name: string };
	participants?: MeetingParticipant[];
	hasCachedSummary?: boolean;
}

export interface MeetingsResponse {
	meetings: MeetingWithSessions[];
}

export interface RecordingStartResponse {
	recordingId?: string;
	status: string;
	alreadyStarted?: boolean;
	error?: string;
}

export interface RecordingStopResponse {
	stopped: { id: string; status: string }[];
	failed: { id: string; error: string }[];
	stoppedCount: number;
	failedCount: number;
}

function getAuthToken(): string {
	return ensureIdentity().token;
}

export async function createRoom(name: string, roomTitle?: string): Promise<CreateRoomResponse> {
	console.log("[api.ts] createRoom — name:", name, "roomTitle:", roomTitle || "(none)");
	const authToken = updateIdentityName(name).token;

	const res = await fetch("/api/rooms", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, roomTitle, authToken }),
	});
	console.log("[api.ts] createRoom response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] createRoom failed:", errText);
		throw new Error(`Failed to create room: ${res.status}`);
	}
	const data = await res.json() as CreateRoomResponse;
	console.log("[api.ts] createRoom success — roomId:", data.roomId);
	return data;
}

export async function joinRoom(roomId: string, name: string): Promise<JoinRoomResponse> {
	roomId = roomId.trim().replace(/\/+$/, "");
	console.log("[api.ts] joinRoom — roomId:", roomId, "name:", name);
	const authToken = updateIdentityName(name).token;

	const res = await fetch(`/api/rooms/${roomId}/participants`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, authToken }),
	});
	console.log("[api.ts] joinRoom response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] joinRoom failed:", errText);
		throw new Error(`Failed to join room: ${res.status}`);
	}
	const data = await res.json() as JoinRoomResponse;
	console.log("[api.ts] joinRoom success — token received");
	return data;
}

export async function getSummary(roomId: string, sessionId?: string): Promise<SummaryResponse> {
	console.log("[api.ts] getSummary — roomId:", roomId, "sessionId:", sessionId || "(latest)");
	const url = sessionId ? `/api/summary/${roomId}?sessionId=${encodeURIComponent(sessionId)}` : `/api/summary/${roomId}`;
	const res = await fetch(url);
	console.log("[api.ts] getSummary response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] getSummary failed:", errText);
		throw new Error(`Failed to fetch summary: ${res.status}`);
	}
	const data = await res.json() as SummaryResponse;
	console.log("[api.ts] getSummary result status:", data.status);
	return data;
}

export async function fetchMeetings(): Promise<MeetingWithSessions[]> {
	console.log("[api.ts] fetchMeetings");
	const authToken = getAuthToken();
	const res = await fetch("/api/meetings", {
		headers: { Authorization: `Bearer ${authToken}` },
	});
	console.log("[api.ts] fetchMeetings response status:", res.status);
	if (res.status === 401) {
		throw new Error("Authentication required. Please sign in again.");
	}
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] fetchMeetings failed:", errText);
		throw new Error(`Failed to fetch meetings: ${res.status}`);
	}
	const data = await res.json() as MeetingsResponse;
	console.log("[api.ts] fetchMeetings — got", data.meetings?.length || 0, "meetings");
	return data.meetings || [];
}

export async function getLatestEndedSessionId(meetingId: string): Promise<string | undefined> {
	try {
		const meetings = await fetchMeetings();
		const meeting = meetings.find((m) => m.id === meetingId);
		if (!meeting) return undefined;
		const ended = meeting.sessions.filter((s) => s.status === "ENDED");
		if (ended.length === 0) return undefined;
		// Return the most recently ended session (sessions are sorted DESC by created_at)
		return ended[0]?.id;
	} catch {
		return undefined;
	}
}

export async function transcribeAudio(meetingId: string, audioUrl: string, sessionId?: string): Promise<TranscribeResponse> {
	console.log("[api.ts] transcribeAudio — meetingId:", meetingId, "sessionId:", sessionId || "(none)", "audioUrl:", !!audioUrl);
	const res = await fetch("/api/transcribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId, audioUrl, sessionId }),
	});
	console.log("[api.ts] transcribeAudio response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] transcribeAudio failed:", errText);
		throw new Error(`Transcribe failed: ${res.status}`);
	}
	const data = await res.json() as TranscribeResponse;
	console.log("[api.ts] transcribeAudio result:", data.status, "transcript:", data.transcript?.length || 0, "chars");
	return data;
}

export function pickTranscribableUrl(data: SummaryResponse, sessionId?: string, refs?: RecordingRef[]): string | undefined {
	// The server drops expired RTK presigned URLs from the summary response, so
	// whatever it returns here is already fetchable.
	if (data.audioRecordingUrl) return data.audioRecordingUrl;

	const audioRefs = (refs || []).filter((r) => r.type === "audio");
	if (audioRefs.length === 0) return undefined;

	if (sessionId) {
		const scoped = audioRefs.filter((r) => r.key.includes(`/${sessionId}/`) || r.key.startsWith(`${sessionId}/`));
		if (scoped.length > 0) return scoped[0].url;
		// Flat keys carry no session id — only safe when nothing is nested.
		if (audioRefs.some((r) => r.key.includes("/"))) return undefined;
	}
	return audioRefs[0].url;
}

export async function generateSummaryFromTranscript(transcript: string, meetingId?: string, prompt?: string, sessionId?: string, force?: boolean): Promise<GenerateSummaryResponse> {
	console.log("[api.ts] generateSummaryFromTranscript — transcript:", transcript.length, "chars", "meetingId:", meetingId, "sessionId:", sessionId || "(none)", "customPrompt:", !!prompt, "force:", !!force);
	const res = await fetch("/api/generate-summary", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ transcript, meetingId, prompt, sessionId, force }),
	});
	console.log("[api.ts] generateSummary response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] generateSummary failed:", errText);
		throw new Error(`Generate summary failed: ${res.status}`);
	}
	const data = await res.json() as GenerateSummaryResponse;
	console.log("[api.ts] generateSummary result:", data.status, "summary:", data.summary?.length || 0, "chars");
	return data;
}

export async function generateSummaryWithRetry(
	transcript: string,
	meetingId: string,
	prompt?: string,
	onProgress?: (done: number, total: number) => void,
	sessionId?: string,
	force?: boolean,
): Promise<GenerateSummaryResponse> {
	for (let attempt = 0; attempt < 60; attempt++) {
		const result = await generateSummaryFromTranscript(transcript, meetingId, prompt, sessionId, force);
		if (result.status === "ok" && result.summary) {
			return result;
		}
		if (result.status === "processing") {
			onProgress?.(result.chunksDone || 0, result.totalChunks || 0);
			console.log(`[api.ts] generateSummary processing — retry in 3s (${result.chunksDone}/${result.totalChunks})`);
			await new Promise((r) => setTimeout(r, 3000));
			continue;
		}
		return result;
	}
	return { status: "no_summary", message: "Timed out waiting for summary." };
}

export async function startCompositeRecording(meetingId: string): Promise<RecordingStartResponse> {
	console.log("[api.ts] startCompositeRecording — meetingId:", meetingId);
	const authToken = getAuthToken();
	if (!authToken) throw new Error("You must be signed in");

	const res = await fetch("/api/recordings/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId, authToken }),
	});
	console.log("[api.ts] startCompositeRecording response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] startCompositeRecording failed:", errText);
		throw new Error(`Failed to start composite recording: ${res.status}`);
	}
	const data = await res.json() as RecordingStartResponse;
	console.log("[api.ts] startCompositeRecording result:", data);
	return data;
}

export async function stopAllRecordings(meetingId: string): Promise<RecordingStopResponse> {
	console.log("[api.ts] stopAllRecordings — meetingId:", meetingId);
	const authToken = getAuthToken();
	if (!authToken) throw new Error("You must be signed in");

	const res = await fetch("/api/recordings/stop", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId, authToken }),
	});
	console.log("[api.ts] stopAllRecordings response status:", res.status);
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] stopAllRecordings failed:", errText);
		throw new Error(`Failed to stop recordings: ${res.status}`);
	}
	const data = await res.json() as RecordingStopResponse;
	console.log("[api.ts] stopAllRecordings result:", data);
	return data;
}

export async function scanR2Recordings(meetingId: string): Promise<RecordingRef[]> {
	console.log("[api.ts] scanR2Recordings — meetingId:", meetingId);
	const res = await fetch("/api/recording/scan", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId }),
	});
	console.log("[api.ts] scanR2Recordings response status:", res.status);
	if (!res.ok) {
		console.log("[api.ts] scanR2Recordings failed:", res.status);
		return [];
	}
	const data = await res.json() as { refs: RecordingRef[]; cached: boolean };
	console.log("[api.ts] scanR2Recordings found:", data.refs.length, "cached:", data.cached);
	return data.refs || [];
}

export async function getUserDefaultPrompt(): Promise<string> {
	try {
		const authToken = getAuthToken();
		if (!authToken) return "";
		const res = await fetch("/api/prompt", {
			headers: { Authorization: `Bearer ${authToken}` },
		});
		if (!res.ok) return "";
		const data = await res.json() as { prompt?: string };
		return data.prompt || "";
	} catch {
		return "";
	}
}

export async function saveUserDefaultPrompt(prompt: string): Promise<boolean> {
	try {
		const authToken = getAuthToken();
		if (!authToken) throw new Error("Not authenticated");
		const res = await fetch("/api/prompt", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
			body: JSON.stringify({ prompt }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function getMeetingPrompt(meetingId: string): Promise<string> {
	try {
		const res = await fetch(`/api/prompt/${meetingId}`);
		if (!res.ok) return "";
		const data = await res.json() as { prompt?: string };
		return data.prompt || "";
	} catch {
		return "";
	}
}

export async function saveMeetingPrompt(meetingId: string, prompt: string): Promise<boolean> {
	try {
		const authToken = getAuthToken();
		if (!authToken) throw new Error("Not authenticated");
		const res = await fetch(`/api/prompt/${meetingId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
			body: JSON.stringify({ prompt }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function sendSummaryEmail(meetingId: string, sessionId?: string): Promise<{ status: string; sent?: number; failed?: number; message?: string }> {
	console.log("[api.ts] sendSummaryEmail — meetingId:", meetingId, "sessionId:", sessionId || "(none)");
	const res = await fetch("/api/send-summary-email", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ meetingId, sessionId }),
	});
	if (!res.ok) {
		const errText = await res.text();
		console.log("[api.ts] sendSummaryEmail failed:", errText);
		throw new Error(`Send email failed: ${res.status}`);
	}
	const data = await res.json() as { status: string; sent?: number; failed?: number; message?: string };
	console.log("[api.ts] sendSummaryEmail result:", data.status, "sent:", data.sent);
	return data;
}

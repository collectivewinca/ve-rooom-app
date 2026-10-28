import { verifyAuthToken } from "../auth";
import { saveMeetingMeta, addUserMeeting, addParticipant } from "../lib/kv";
import { jsonResponse } from "../lib/response";
import { checkRateLimit } from "../lib/rate-limit";
import type { AppEnv } from "../lib/env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

type Env = AppEnv;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.RTK_APP_ID) {
		return jsonResponse(500, { error: "Server missing configuration. Set CF_ACCOUNT_ID, CF_API_TOKEN, RTK_APP_ID in .dev.vars" });
	}

	let body: { name?: string; roomTitle?: string; authToken?: string };
	try {
		body = await request.json();
	} catch {
		console.log("[rooms.ts] Invalid JSON body");
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	const user = await verifyAuthToken(body.authToken, env);
	if (!user) {
		console.log("[rooms.ts] Auth verification failed");
		return jsonResponse(401, { error: "Authentication required. Please sign in with Google." });
	}

	const name = body.name?.trim() || user.name;
	if (!name) {
		console.log("[rooms.ts] Missing name");
		return jsonResponse(400, { error: "name is required" });
	}

	const authHeaders = {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};

	const meetingBody: Record<string, unknown> = {
		title: body.roomTitle?.trim() || "VE-Call",
		record_on_start: true,
		transcribe_on_end: true,
		summarize_on_end: true,
		ai_config: {
			transcription: { language: "en-US" },
			summarization: {
				summary_type: "general",
				text_format: "markdown",
				word_limit: 500,
			},
		},
		recording_config: {
			realtimekit_bucket_config: { enabled: true },
			audio_config: { codec: "MP3", export_file: true },
		},
	};

	// Long-term storage: `storage_config` is deliberately NOT sent here.
	// Verified against the RealtimeKit API (2026-10-27): POST /meetings accepts
	// the field but IGNORES it — a create with `storage_config.type: "bogus"`
	// returned 201 and created the meeting. So the earlier claim in this
	// comment ("the create-meeting schema only accepts
	// gcs/aws/azure/digitalocean/sftp — sending cloudflare risks a 400") was
	// wrong; there is no 400 risk, the value is simply not applied.
	//
	// The transfer is configured where it IS honoured — on the recording
	// (POST /recordings, see recordings/start.ts). There RTK attempts the
	// external-bucket upload, and with bad credentials the upload later fails
	// with "[ERROR:0003] Recording failed to upload to external bucket".
	// `realtimekit_bucket_config.enabled` stays true so RTK keeps its own copy
	// and its temporary download URL, which the webhook copies into R2.

	console.log("[rooms.ts] Creating meeting with title:", meetingBody.title);

	const meetingRes = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/meetings`,
		{ method: "POST", headers: authHeaders, body: JSON.stringify(meetingBody) }
	);

	console.log("[rooms.ts] Create meeting response status:", meetingRes.status);

	if (!meetingRes.ok) {
		const errText = await meetingRes.text();
		console.log("[rooms.ts] Create meeting failed:", errText);
		return jsonResponse(meetingRes.status, { error: "Failed to create meeting", detail: errText });
	}

	const meetingJson = await meetingRes.json() as {
		success: boolean;
		data: { id: string };
	};
	const meetingId = meetingJson.data.id;
	console.log("[rooms.ts] Meeting created, id:", meetingId, "full response:", JSON.stringify(meetingJson));

	console.log("[rooms.ts] Adding participant:", name, "to meeting:", meetingId);

	const participantRes = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/meetings/${meetingId}/participants`,
		{
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ name, preset_name: "group_call_host", custom_participant_id: crypto.randomUUID() }),
		}
	);

	console.log("[rooms.ts] Add participant response status:", participantRes.status);

	if (!participantRes.ok) {
		const errText = await participantRes.text();
		console.log("[rooms.ts] Add participant failed:", errText);
		return jsonResponse(participantRes.status, { error: "Failed to add participant", detail: errText });
	}

	const participantJson = await participantRes.json() as {
		success: boolean;
		data: { token: string };
	};

	console.log("[rooms.ts] Participant added");

	// Save meeting meta to KV
	const title = body.roomTitle?.trim() || "VE-Call";
	await saveMeetingMeta(env.MEETING_CACHE, meetingId, {
		createdBy: { email: user.email, name },
		title,
		createdAt: new Date().toISOString(),
	});
	// Add the host as a participant so they get summary emails
	await addParticipant(env.MEETING_CACHE, meetingId, {
		email: user.email,
		name,
		joinedAt: new Date().toISOString(),
	});
	await addUserMeeting(env.MEETING_CACHE, user.email, meetingId);

	console.log("[rooms.ts] Done — returning roomId + authToken");

	return jsonResponse(200, {
		roomId: meetingId,
		authToken: participantJson.data.token,
	});
};

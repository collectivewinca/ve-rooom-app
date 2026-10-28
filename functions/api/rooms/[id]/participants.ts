import { verifyAuthToken } from "../../../auth";
import { addParticipant, addUserMeeting } from "../../../lib/kv";
import { jsonResponse } from "../../../lib/response";
import { checkRateLimit } from "../../../lib/rate-limit";
import type { AppEnv } from "../../../lib/env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

type Env = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "OLLAMA_API_KEY" | "OLLAMA_BASE_URL" | "FORMSDB_URL" | "MEETING_CACHE">;

export const onRequestPost: PagesFunction<Env> = async ({ params, request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	const roomId = params.id as string;

	let body: { name?: string; authToken?: string };
	try {
		body = await request.json();
	} catch {
		console.log("[participants.ts] Invalid JSON body");
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	const user = await verifyAuthToken(body.authToken, env);
	if (!user) {
		console.log("[participants.ts] Auth verification failed");
		return jsonResponse(401, { error: "Authentication required. Please sign in with Google." });
	}

	const name = body.name?.trim() || user.name;
	if (!name) {
		console.log("[participants.ts] Missing name");
		return jsonResponse(400, { error: "name is required" });
	}

	console.log("[participants.ts] Adding participant:", name, "to room:", roomId);

	const res = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/meetings/${roomId}/participants`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.CF_API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name, preset_name: "group_call_host", custom_participant_id: crypto.randomUUID() }),
		}
	);

	console.log("[participants.ts] Add participant response status:", res.status);

	if (!res.ok) {
		const errText = await res.text();
		console.log("[participants.ts] Add participant failed:", errText);
		return jsonResponse(res.status, { error: "Failed to join room", detail: errText });
	}

	const json = await res.json() as {
		success: boolean;
		data: { token: string };
	};

	console.log("[participants.ts] Participant added");

	// Save participant record to KV
	await addParticipant(env.MEETING_CACHE, roomId, {
		email: user.email,
		name,
		joinedAt: new Date().toISOString(),
	});
	await addUserMeeting(env.MEETING_CACHE, user.email, roomId);

	console.log("[participants.ts] Done — returning authToken");

	return jsonResponse(200, { authToken: json.data.token });
};

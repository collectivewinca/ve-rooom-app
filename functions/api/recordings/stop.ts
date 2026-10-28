import { verifyAuthToken } from "../../auth";
import { jsonResponse } from "../../lib/response";
import { checkRateLimit } from "../../lib/rate-limit";
import type { AppEnv } from "../../lib/env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";

type Env = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "OLLAMA_API_KEY" | "OLLAMA_BASE_URL" | "FORMSDB_URL" | "MEETING_CACHE">;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.RTK_APP_ID) {
		return jsonResponse(500, { error: "Server missing configuration" });
	}

	let body: { meetingId?: string; authToken?: string };
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	const user = await verifyAuthToken(body.authToken, env);
	if (!user) {
		console.log("[recordings/stop.ts] Auth verification failed");
		return jsonResponse(401, { error: "Authentication required" });
	}

	const meetingId = body.meetingId?.trim();
	if (!meetingId) {
		return jsonResponse(400, { error: "meetingId is required" });
	}

	const authHeaders = {
		Authorization: `Bearer ${env.CF_API_TOKEN}`,
		"Content-Type": "application/json",
	};

	console.log("[recordings/stop.ts] Fetching active recordings for meeting:", meetingId);
	const existingRes = await fetch(
		`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/recordings?meeting_id=${meetingId}&per_page=100`,
		{ headers: authHeaders }
	);

	if (!existingRes.ok) {
		const errText = await existingRes.text();
		console.log("[recordings/stop.ts] Existing recordings fetch failed:", existingRes.status, errText);
		return jsonResponse(existingRes.status, { error: "Failed to fetch recordings", detail: errText });
	}

	const existingJson = await existingRes.json() as {
		success: boolean;
		data?: { id: string; status: string; type?: string }[];
	};
	const recordings = existingJson.data || [];
	const active = recordings.filter((r) => r.status === "RECORDING");
	console.log("[recordings/stop.ts] Active recordings to stop:", active.length);

	const stopped: { id: string; status: string }[] = [];
	const failed: { id: string; error: string }[] = [];

	for (const rec of active) {
		console.log("[recordings/stop.ts] Stopping recording:", rec.id, "type:", rec.type, "status:", rec.status);
		try {
			const stopRes = await fetch(
				`${RTK_BASE}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.RTK_APP_ID}/recordings/${rec.id}`,
				{ method: "PUT", headers: authHeaders, body: JSON.stringify({ action: "stop" }) }
			);
			if (stopRes.ok) {
				console.log("[recordings/stop.ts] Stopped:", rec.id);
				stopped.push({ id: rec.id, status: "STOPPING" });
			} else {
				const errText = await stopRes.text();
				console.log("[recordings/stop.ts] Stop failed for", rec.id, ":", stopRes.status, errText);
				failed.push({ id: rec.id, error: errText });
			}
		} catch (e) {
			console.log("[recordings/stop.ts] Stop threw for", rec.id, ":", e);
			failed.push({ id: rec.id, error: e instanceof Error ? e.message : String(e) });
		}
	}

	console.log("[recordings/stop.ts] Done — stopped:", stopped.length, "failed:", failed.length);

	return jsonResponse(200, {
		stopped,
		failed,
		stoppedCount: stopped.length,
		failedCount: failed.length,
	});
};

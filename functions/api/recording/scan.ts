import { checkRateLimit } from "../../lib/rate-limit";
import { loadRecordingRefs } from "../../lib/recordings";
import { jsonResponse } from "../../lib/response";
import type { AppEnv } from "../../lib/env";

type Env = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "MEETING_CACHE" | "RECORDINGS_BUCKET">;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	const body = await request.json() as { meetingId?: string };
	const meetingId = body.meetingId?.trim();
	if (!meetingId) return jsonResponse(400, { error: "meetingId is required" });

	if (!env.RECORDINGS_BUCKET) {
		return jsonResponse(500, { error: "R2 storage not configured" });
	}

	// Always re-list: refs cached in KV can outlive their objects, and handing
	// the client links to deleted recordings is worse than a wasted list call.
	const refs = await loadRecordingRefs(env.RECORDINGS_BUCKET, env.MEETING_CACHE, meetingId);
	console.log("[scan-r2] Found", refs.length, "recordings for meeting", meetingId);

	return jsonResponse(200, { refs, cached: false });
};

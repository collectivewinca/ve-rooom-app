import { transcribeCompositeAudio } from "../lib/transcribe-core";
import { jsonResponse } from "../lib/response";
import { checkRateLimit } from "../lib/rate-limit";
import type { AppEnv } from "../lib/env";

type Env = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "RTK_APP_ID" | "MEETING_CACHE" | "RECORDINGS_BUCKET">;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	const body = await request.json() as { meetingId: string; audioUrl: string; sessionId?: string };
	console.log("[transcribe.ts] POST — meetingId:", body.meetingId, "sessionId:", body.sessionId || "(none)", "audioUrl:", body.audioUrl ? "found" : "none");

	if (!body.meetingId || !body.audioUrl) {
		return jsonResponse(400, { error: "meetingId and audioUrl are required" });
	}

	if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
		return jsonResponse(500, { error: "Server missing configuration" });
	}

	const result = await transcribeCompositeAudio(env, body.meetingId, body.audioUrl, body.sessionId, "frontend");

	switch (result.status) {
		case "transcribed":
			return jsonResponse(200, { status: "transcribed", transcript: result.transcript });
		case "processing":
			return jsonResponse(200, result);
		case "silent":
			return jsonResponse(200, result);
		case "too_large":
			return jsonResponse(200, result);
		case "error":
			return jsonResponse(200, { status: "error", error: result.error });
	}
};
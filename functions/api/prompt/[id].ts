import { getMeetingPrompt, saveMeetingPrompt, getMeetingMeta } from "../../lib/kv";
import { verifyAuthToken } from "../../auth";
import { jsonResponse } from "../../lib/response";
import { checkRateLimit } from "../../lib/rate-limit";
import type { AppEnv } from "../../lib/env";

type Env = Pick<AppEnv, "MEETING_CACHE" | "FORMSDB_URL">;

export const onRequestGet: PagesFunction<Env> = async ({ params, request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests" });

	const meetingId = params.id as string;
	const prompt = await getMeetingPrompt(env.MEETING_CACHE, meetingId);
	return jsonResponse(200, { prompt: prompt || "", meetingId });
};

export const onRequestPost: PagesFunction<Env> = async ({ params, request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests" });

	const authHeader = request.headers.get("Authorization");
	const authToken = authHeader?.replace("Bearer ", "") || undefined;
	const user = await verifyAuthToken(authToken, env);
	if (!user) return jsonResponse(401, { error: "Unauthorized" });

	const meetingId = params.id as string;
	const meta = await getMeetingMeta(env.MEETING_CACHE, meetingId);
	if (!meta || meta.createdBy.email !== user.email) {
		return jsonResponse(403, { error: "Only the meeting creator can set the prompt" });
	}

	const body = await request.json() as { prompt: string };
	if (!body.prompt || body.prompt.trim().length === 0) {
		return jsonResponse(400, { error: "prompt is required" });
	}
	if (body.prompt.length > 10000) {
		return jsonResponse(400, { error: "Prompt too long (max 10000 chars)" });
	}

	await saveMeetingPrompt(env.MEETING_CACHE, meetingId, body.prompt.trim());
	return jsonResponse(200, { ok: true, prompt: body.prompt.trim() });
};
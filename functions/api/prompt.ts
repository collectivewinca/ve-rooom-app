import { getUserPrompt, saveUserPrompt } from "../lib/kv";
import { verifyAuthToken } from "../auth";
import { jsonResponse } from "../lib/response";
import { checkRateLimit } from "../lib/rate-limit";
import type { AppEnv } from "../lib/env";

type Env = Pick<AppEnv, "MEETING_CACHE" | "FORMSDB_URL">;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests" });

	const authHeader = request.headers.get("Authorization");
	const authToken = authHeader?.replace("Bearer ", "") || undefined;
	const user = await verifyAuthToken(authToken, env);
	if (!user) return jsonResponse(401, { error: "Unauthorized" });

	const prompt = await getUserPrompt(env.MEETING_CACHE, user.email);
	return jsonResponse(200, { prompt: prompt || "", email: user.email });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests" });

	const authHeader = request.headers.get("Authorization");
	const authToken = authHeader?.replace("Bearer ", "") || undefined;
	const user = await verifyAuthToken(authToken, env);
	if (!user) return jsonResponse(401, { error: "Unauthorized" });

	const body = await request.json() as { prompt: string };
	if (!body.prompt || body.prompt.trim().length === 0) {
		return jsonResponse(400, { error: "prompt is required" });
	}
	if (body.prompt.length > 10000) {
		return jsonResponse(400, { error: "Prompt too long (max 10000 chars)" });
	}

	await saveUserPrompt(env.MEETING_CACHE, user.email, body.prompt.trim());
	return jsonResponse(200, { ok: true, prompt: body.prompt.trim() });
};
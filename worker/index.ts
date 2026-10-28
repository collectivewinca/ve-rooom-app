/**
 * VE Rooom — single Worker entrypoint.
 *
 * Migrated from Cloudflare Pages: the SPA is served by the Workers *static
 * assets* layer (with SPA fallback for client-side routes) and every `/api/*`
 * request is dispatched from here to the former Pages-Function modules,
 * which are unchanged — they still export `onRequestGet` / `onRequestPost`
 * and receive a Pages-Functions-shaped context.
 *
 * Routing table (order matters only for readability; matchers are exact):
 *
 *  POST   /api/rooms                          api/rooms.ts
 *  POST   /api/rooms/:id/participants         api/rooms/[id]/participants.ts
 *  POST   /api/recordings/start               api/recordings/start.ts
 *  POST   /api/recordings/stop                api/recordings/stop.ts
 *  GET    /api/meetings                       api/meetings.ts
 *  GET    /api/recent-data                    api/recent-data.ts
 *  GET    /api/summary/:id                    api/summary/[id].ts
 *  POST   /api/generate-summary               api/generate-summary.ts
 *  POST   /api/transcribe                     api/transcribe.ts
 *  POST   /api/transcribe-continue            api/transcribe-continue.ts
 *  POST   /api/webhook                        api/webhook.ts
 *  GET    /api/prompt                         api/prompt.ts
 *  POST   /api/prompt                         api/prompt.ts
 *  GET    /api/prompt/:id                     api/prompt/[id].ts
 *  POST   /api/prompt/:id                     api/prompt/[id].ts
 *  POST   /api/recording/scan                 api/recording/scan.ts
 *  GET    /api/recording/:key                 api/recording/[key]/index.ts
 *  POST   /api/send-summary-email             api/send-summary-email.ts
 *
 * `run_worker_first = ["/api/*"]` in wrangler.toml guarantees /api requests
 * always reach this handler; non-API paths are served from the assets layer
 * (index.html fallback for unknown paths → React Router takes over).
 */
import { jsonResponse } from "../functions/lib/response";
import type { AppEnv } from "../functions/lib/env";

import * as generateSummaryMod from "../functions/api/generate-summary";
import * as meetingsMod from "../functions/api/meetings";
import * as promptMod from "../functions/api/prompt";
import * as promptIdMod from "../functions/api/prompt/[id]";
import * as recentDataMod from "../functions/api/recent-data";
import * as roomsMod from "../functions/api/rooms";
import * as participantsMod from "../functions/api/rooms/[id]/participants";
import * as recordingScanMod from "../functions/api/recording/scan";
import * as recordingKeyMod from "../functions/api/recording/[key]/index";
import * as recordingsStartMod from "../functions/api/recordings/start";
import * as recordingsStopMod from "../functions/api/recordings/stop";
import * as sendSummaryEmailMod from "../functions/api/send-summary-email";
import * as summaryMod from "../functions/api/summary/[id]";
import * as transcribeMod from "../functions/api/transcribe";
import * as transcribeContinueMod from "../functions/api/transcribe-continue";
import * as webhookMod from "../functions/api/webhook";

/** Pages-Functions-shaped context (the subset the handlers actually use). */
interface FuncCtx {
	request: Request;
	env: AppEnv;
	params: Record<string, string | string[]>;
	waitUntil: (promise: Promise<unknown>) => void;
	data: Record<string, unknown>;
	next: (input?: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	passThroughOnException: () => void;
}

type Handler = (ctx: FuncCtx) => Promise<Response>;

interface RouteModule {
	onRequest?: Handler;
	onRequestGet?: Handler;
	onRequestPost?: Handler;
	onRequestPut?: Handler;
	onRequestDelete?: Handler;
	onRequestHead?: Handler;
	onRequestOptions?: Handler;
}

interface Route {
	method: string;
	segments: string[];
	mod: RouteModule;
}

const ROUTES: Route[] = [
	{ method: "POST", segments: ["api", "rooms"], mod: roomsMod },
	{ method: "POST", segments: ["api", "rooms", ":id", "participants"], mod: participantsMod },
	{ method: "POST", segments: ["api", "recordings", "start"], mod: recordingsStartMod },
	{ method: "POST", segments: ["api", "recordings", "stop"], mod: recordingsStopMod },
	{ method: "GET", segments: ["api", "meetings"], mod: meetingsMod },
	{ method: "GET", segments: ["api", "recent-data"], mod: recentDataMod },
	{ method: "GET", segments: ["api", "summary", ":id"], mod: summaryMod },
	{ method: "POST", segments: ["api", "generate-summary"], mod: generateSummaryMod },
	{ method: "POST", segments: ["api", "transcribe"], mod: transcribeMod },
	{ method: "POST", segments: ["api", "transcribe-continue"], mod: transcribeContinueMod },
	{ method: "POST", segments: ["api", "webhook"], mod: webhookMod },
	{ method: "GET", segments: ["api", "prompt"], mod: promptMod },
	{ method: "POST", segments: ["api", "prompt"], mod: promptMod },
	{ method: "GET", segments: ["api", "prompt", ":id"], mod: promptIdMod },
	{ method: "POST", segments: ["api", "prompt", ":id"], mod: promptIdMod },
	{ method: "POST", segments: ["api", "recording", "scan"], mod: recordingScanMod },
	{ method: "GET", segments: ["api", "recording", ":key"], mod: recordingKeyMod },
	{ method: "POST", segments: ["api", "send-summary-email"], mod: sendSummaryEmailMod },
];

function matchRoute(method: string, pathname: string): { mod: RouteModule; params: Record<string, string> } | null {
	const segs = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
	for (const route of ROUTES) {
		if (route.method !== method || route.segments.length !== segs.length) continue;
		const params: Record<string, string> = {};
		let ok = true;
		for (let i = 0; i < segs.length; i++) {
			const pattern = route.segments[i];
			if (pattern.startsWith(":")) {
				params[pattern.slice(1)] = segs[i];
			} else if (pattern !== segs[i]) {
				ok = false;
				break;
			}
		}
		if (ok) return { mod: route.mod, params };
	}
	return null;
}

function pickHandler(mod: RouteModule, method: string): Handler | null {
	const byMethod: Record<string, Handler | undefined> = {
		GET: mod.onRequestGet,
		POST: mod.onRequestPost,
		PUT: mod.onRequestPut,
		DELETE: mod.onRequestDelete,
		HEAD: mod.onRequestHead,
		OPTIONS: mod.onRequestOptions,
	};
	return byMethod[method.toUpperCase()] ?? mod.onRequest ?? null;
}

export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			const matched = matchRoute(request.method, url.pathname);
			if (!matched) return jsonResponse(404, { error: "Not found" });
			const handler = pickHandler(matched.mod, request.method);
			if (!handler) return jsonResponse(405, { error: "Method not allowed" });

			const funcCtx: FuncCtx = {
				request,
				env,
				params: matched.params,
				waitUntil: (p) => ctx.waitUntil(p),
				data: {},
				next: () => env.ASSETS.fetch(request),
				passThroughOnException: () => {},
			};
			return handler(funcCtx);
		}

		// Everything else: static assets with single-page-application fallback.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<AppEnv>;

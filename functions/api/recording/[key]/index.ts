import { jsonResponse } from "../../../lib/response";
import { checkRateLimit } from "../../../lib/rate-limit";
import type { AppEnv } from "../../../lib/env";

type Env = Pick<AppEnv, "MEETING_CACHE" | "RECORDINGS_BUCKET">;

interface ByteRange {
	offset: number;
	length: number;
}

/**
 * Parse a single-range `Range: bytes=...` header against a known object size.
 * Returns `null` for syntax we don't handle (caller falls back to 200 + full body)
 * and `"unsatisfiable"` when the range lies outside the object (caller returns 416).
 */
function parseRange(header: string, total: number): ByteRange | null | "unsatisfiable" {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const rawStart = match[1];
	const rawEnd = match[2];
	if (rawStart === "" && rawEnd === "") return null;

	if (rawStart === "") {
		// Suffix range: `bytes=-N` = last N bytes
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix <= 0 || total === 0) return "unsatisfiable";
		const length = Math.min(suffix, total);
		return { offset: total - length, length };
	}

	const offset = Number(rawStart);
	if (offset >= total) return "unsatisfiable";
	if (rawEnd === "") return { offset, length: total - offset };

	const end = Number(rawEnd);
	if (end < offset) return "unsatisfiable";
	return { offset, length: Math.min(end, total - 1) - offset + 1 };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
	const rl = await checkRateLimit(env.MEETING_CACHE, request);
	if (!rl.allowed) return jsonResponse(429, { error: "Too many requests. Please slow down." });

	const key = params.key as string;
	if (!key) return jsonResponse(400, { error: "Recording key is required" });

	if (!env.RECORDINGS_BUCKET) {
		return jsonResponse(500, { error: "R2 storage not configured" });
	}

	const decodedKey = decodeURIComponent(key);

	try {
		const rangeHeader = request.headers.get("range");

		// Resolve total size + existence without trusting `head()` alone: it was
		// observed returning null for objects that a ranged GET could read. A full
		// get exposes `.size` from metadata (no body read), so it is the fallback
		// when head comes back empty.
		let total: number | null = null;
		let contentType = "application/octet-stream";
		const head = await env.RECORDINGS_BUCKET.head(decodedKey).catch(() => null);
		if (head) {
			total = head.size;
			if (head.httpMetadata?.contentType) contentType = head.httpMetadata.contentType;
		}

		let prefetched: R2ObjectBody | null = null;
		if (total === null) {
			prefetched = await env.RECORDINGS_BUCKET.get(decodedKey).catch(() => null);
			if (!prefetched) {
				console.log("[recording/[key]] Object not readable:", decodedKey);
				return jsonResponse(404, { error: "Recording not found in R2 storage" });
			}
			total = prefetched.size;
			if (prefetched.httpMetadata?.contentType) contentType = prefetched.httpMetadata.contentType;
		}

		const baseHeaders = new Headers();
		baseHeaders.set("Content-Type", contentType);
		baseHeaders.set("Accept-Ranges", "bytes");
		// Recordings are immutable once written, but they can be replaced by a
		// re-copy, and a cached 404/206 would outlive that — so don't cache.
		baseHeaders.set("Cache-Control", "no-cache");

		if (rangeHeader) {
			const range = parseRange(rangeHeader, total);
			if (range === "unsatisfiable") {
				console.log("[recording/[key]] Unsatisfiable range:", rangeHeader, "for", decodedKey);
				return new Response(null, {
					status: 416,
					headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
				});
			}
			if (range) {
				const object = await env.RECORDINGS_BUCKET.get(decodedKey, {
					range: { offset: range.offset, length: range.length },
				});
				if (!object) return jsonResponse(404, { error: "Recording not found in R2 storage" });

				const headers = new Headers(baseHeaders);
				const start = range.offset;
				const end = range.offset + range.length - 1;
				headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
				headers.set("Content-Length", range.length.toString());
				console.log("[recording/[key]] Serving range", `${start}-${end}`, "of", total, "for", decodedKey);
				return new Response(object.body, { status: 206, headers });
			}
		}

		const object = prefetched ?? await env.RECORDINGS_BUCKET.get(decodedKey);
		if (!object) {
			return jsonResponse(404, { error: "Recording not found in R2 storage" });
		}
		const headers = new Headers(baseHeaders);
		headers.set("Content-Length", object.size.toString());
		console.log("[recording/[key]] Serving full object:", decodedKey, "size:", object.size);
		return new Response(object.body, { headers });
	} catch (e) {
		console.log("[recording/[key]] Error:", e instanceof Error ? e.message : String(e));
		return jsonResponse(500, { error: "Failed to retrieve recording" });
	}
};

const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 30;

function getClientIp(request: Request): string {
	const forwarded = request.headers.get("cf-connecting-ip");
	if (forwarded) return forwarded;
	const xff = request.headers.get("x-forwarded-for");
	if (xff) return xff.split(",")[0].trim();
	return "unknown";
}

export interface RateLimitOptions {
	/** Max requests per window. Defaults to 30. */
	max?: number;
	/** Window length in seconds. Defaults to 60. */
	windowSeconds?: number;
}

/**
 * Fixed-window per-IP rate limit backed by KV.
 *
 * Endpoints that the app itself calls in a chain (the webhook → transcribe
 * pipeline) need a higher ceiling than the default, hence the options.
 */
export async function checkRateLimit(kv: KVNamespace, request: Request, options: RateLimitOptions = {}): Promise<{ allowed: boolean; remaining: number }> {
	const max = options.max ?? RATE_LIMIT_MAX;
	const windowSeconds = options.windowSeconds ?? RATE_LIMIT_WINDOW;
	const ip = getClientIp(request);
	const key = `ratelimit:${ip}`;
	const now = Math.floor(Date.now() / 1000);

	try {
		const raw = await kv.get(key);
		let window = raw ? JSON.parse(raw) as { start: number; count: number } : { start: now, count: 0 };

		if (now - window.start > windowSeconds) {
			window = { start: now, count: 1 };
			await kv.put(key, JSON.stringify(window), { expirationTtl: windowSeconds });
			return { allowed: true, remaining: max - 1 };
		}

		window.count += 1;
		const remaining = max - window.count;
		if (window.count > max) {
			await kv.put(key, JSON.stringify(window), { expirationTtl: windowSeconds - (now - window.start) });
			return { allowed: false, remaining: 0 };
		}

		await kv.put(key, JSON.stringify(window), { expirationTtl: windowSeconds - (now - window.start) });
		return { allowed: true, remaining };
	} catch {
		return { allowed: true, remaining: max };
	}
}
/**
 * Resilient email delivery.
 *
 * Delivery tries configured providers in order and reports exactly what
 * happened, so an unavailable provider cannot look like a successful send.
 *
 * Providers:
 *  1. `SMTP_API_URL`  — the central relay (/send-batch, HTML per recipient).
 *  2. `RESEND_API_KEY` — direct provider fallback, no DNS dependency.
 *
 * If neither is configured or both fail, the caller gets a failure result with
 * the reason, and the failure is recorded in KV (see markEmailFailed).
 */

export interface EmailMessage {
	to: string;
	html: string;
}

export interface EmailProviders {
	/** Central relay base URL, e.g. https://host/smtp-api */
	smtpApiUrl?: string;
	/** Resend API key — used when the central relay is unreachable. */
	resendApiKey?: string;
	/** From address for the fallback provider. */
	from?: string;
}

export interface EmailSendResult {
	sent: number;
	failed: number;
	/** "smtp-api" | "resend" | "none" */
	provider: string;
	/** Human-readable reason when nothing could be delivered. */
	error?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function sendViaSmtpApi(smtpApiUrl: string, emails: EmailMessage[], subject: string): Promise<EmailSendResult> {
	const res = await fetchWithTimeout(smtpApiUrl + "/send-batch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			emails: emails.map((e) => ({ email: e.to, html: e.html })),
			subject,
		}),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		return { sent: 0, failed: emails.length, provider: "smtp-api", error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
	}

	const result = await res.json() as { ok?: boolean; sent?: number; failed?: number };
	return {
		sent: result.sent ?? 0,
		failed: result.failed ?? Math.max(0, emails.length - (result.sent ?? 0)),
		provider: "smtp-api",
	};
}

async function sendViaResend(apiKey: string, from: string, emails: EmailMessage[], subject: string): Promise<EmailSendResult> {
	let sent = 0;
	let lastError = "";
	for (const email of emails) {
		const res = await fetchWithTimeout("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				from,
				to: [email.to],
				subject,
				html: email.html,
			}),
		});
		if (res.ok) {
			sent++;
		} else {
			lastError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
			console.log("[email] Resend delivery failed for", email.to, lastError);
		}
	}
	return {
		sent,
		failed: emails.length - sent,
		provider: "resend",
		error: sent < emails.length ? lastError || "resend delivery failed" : undefined,
	};
}

/**
 * Deliver a batch of emails, trying each configured provider in turn.
 * Never throws — the returned result always says what happened.
 */
export async function sendEmailBatch(
	providers: EmailProviders,
	emails: EmailMessage[],
	subject: string,
): Promise<EmailSendResult> {
	if (emails.length === 0) {
		return { sent: 0, failed: 0, provider: "none" };
	}

	const errors: string[] = [];

	if (providers.smtpApiUrl) {
		try {
			const result = await sendViaSmtpApi(providers.smtpApiUrl, emails, subject);
			if (result.sent > 0 || result.failed === 0) {
				return result;
			}
			errors.push(`smtp-api: ${result.error}`);
			console.log("[email] SMTP API delivery failed:", result.error);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors.push(`smtp-api: ${msg}`);
			console.log("[email] SMTP API unreachable:", msg);
		}
	} else {
		errors.push("smtp-api: not configured");
	}

	if (providers.resendApiKey) {
		const from = providers.from || "VE Rooom <onboarding@resend.dev>";
		try {
			const result = await sendViaResend(providers.resendApiKey, from, emails, subject);
			if (result.sent > 0 || result.failed === 0) {
				return result;
			}
			errors.push(`resend: ${result.error}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errors.push(`resend: ${msg}`);
			console.log("[email] Resend unreachable:", msg);
		}
	} else {
		errors.push("resend: not configured");
	}

	return {
		sent: 0,
		failed: emails.length,
		provider: "none",
		error: errors.join(" | "),
	};
}

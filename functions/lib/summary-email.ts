import { sendEmailBatch } from "./email";

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function formatDate(isoStr: string): string {
	try {
		const d = new Date(isoStr);
		return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
	} catch {
		return isoStr;
	}
}

function buildEmailHtml(data: {
	meetingTitle: string;
	creatorName: string;
	summary: string;
	summaryUrl: string;
	dashboardUrl: string;
	participantName: string;
	meetingDate?: string;
	endedAt?: string;
	participants?: { name: string; email: string }[];
	recordingUrl?: string;
	transcriptUrl?: string;
}): string {
	const preview = data.summary
		.replace(/[#*`>]/g, "")
		.replace(/\n+/g, " ")
		.trim()
		.slice(0, 200);

	const dateDisplay = data.endedAt ? formatDate(data.endedAt) : (data.meetingDate ? formatDate(data.meetingDate) : "");
	const participantList = data.participants && data.participants.length > 0
		? data.participants.map((p) => escapeHtml(p.name || p.email)).join(", ")
		: escapeHtml(data.creatorName);

	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#15151f;border:1px solid #2a2a3a;border-radius:16px;overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 100%);padding:32px 40px;">
<h1 style="margin:0;font-size:24px;font-weight:700;color:#0a0a0f;">Meeting Summary Ready</h1>
<p style="margin:8px 0 0;font-size:14px;color:#0a0a0f;opacity:0.8;">${escapeHtml(data.meetingTitle)}</p>
</td></tr>
<tr><td style="padding:32px 40px 0;">
<p style="margin:0;font-size:16px;color:#e4e4e7;line-height:1.6;">Hi ${escapeHtml(data.participantName)},</p>
<p style="margin:12px 0 0;font-size:15px;color:#a1a1aa;line-height:1.6;">${escapeHtml(data.creatorName)} hosted a meeting and the AI-generated summary is now available.</p>
</td></tr>
<tr><td style="padding:24px 40px 0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;border:1px solid #2a2a3a;border-radius:12px;">
<tr><td style="padding:20px 24px;">
<p style="margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#fbbf24;">Summary Preview</p>
<p style="margin:0;font-size:14px;color:#d4d4d8;line-height:1.7;">${escapeHtml(preview)}${data.summary.length > 200 ? "..." : ""}</p>
</td></tr>
</table>
</td></tr>
<tr><td style="padding:24px 40px 0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;border:1px solid #2a2a3a;border-radius:12px;">
<tr><td style="padding:16px 24px;">
<p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Meeting</p>
<p style="margin:0 0 12px;font-size:15px;color:#e4e4e7;">${escapeHtml(data.meetingTitle)}</p>
${dateDisplay ? `<p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Date</p><p style="margin:0 0 12px;font-size:15px;color:#e4e4e7;">${escapeHtml(dateDisplay)}</p>` : ""}
<p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Host</p>
<p style="margin:0 0 12px;font-size:15px;color:#e4e4e7;">${escapeHtml(data.creatorName)}</p>
<p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Participants</p>
<p style="margin:0;font-size:15px;color:#e4e4e7;">${participantList}</p>
</td></tr>
</table>
</td></tr>
<tr><td style="padding:28px 40px;">
<table cellpadding="0" cellspacing="0" style="margin:0 auto;">
<tr>
<td style="padding:0 8px 0 0;">
<a href="${data.summaryUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#fbbf24 0%,#f59e0b 100%);color:#0a0a0f;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">View Full Summary</a>
</td>
<td style="padding:0 0 0 8px;">
<a href="${data.dashboardUrl}" style="display:inline-block;padding:14px 28px;background:#1e1e2a;color:#e4e4e7;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;border:1px solid #2a2a3a;">Go to Dashboard</a>
</td>
</tr>
</table>
</td></tr>
${(data.recordingUrl || data.transcriptUrl) ? `<tr><td style="padding:0 40px 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;border:1px solid #2a2a3a;border-radius:12px;">
<tr><td style="padding:16px 24px;">
<p style="margin:0 0 10px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;">Resources</p>
${data.recordingUrl ? `<p style="margin:0 0 8px;font-size:14px;"><a href="${data.recordingUrl}" style="color:#fbbf24;text-decoration:none;">Watch Recording (MP4)</a></p>` : ""}
${data.transcriptUrl ? `<p style="margin:0 0 8px;font-size:14px;"><a href="${data.transcriptUrl}" style="color:#fbbf24;text-decoration:none;">Download Full Transcript</a></p>` : ""}
<p style="margin:0;font-size:14px;"><a href="${data.summaryUrl}" style="color:#fbbf24;text-decoration:none;">Generate Your Own Summary with Custom Prompt</a></p>
</td></tr>
</table>
</td></tr>` : ""}
<tr><td style="padding:24px 40px 32px;border-top:1px solid #1e1e2a;">
<p style="margin:0;font-size:13px;color:#71717a;text-align:center;line-height:1.5;">You're receiving this because you participated in this meeting on VE Rooom.<br><a href="${data.dashboardUrl}" style="color:#a1a1aa;text-decoration:none;">View all your meetings</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export async function sendSummaryEmails(
	providers: { SMTP_API_URL?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string },
	params: {
		participants: { email: string; name: string }[];
		meetingTitle: string;
		creatorName: string;
		summary: string;
		meetingId: string;
		appUrl: string;
		alwaysEmail?: string;
		meetingDate?: string;
		endedAt?: string;
		recordingUrl?: string;
		transcriptUrl?: string;
		sessionId?: string;
	},
): Promise<{ sent: number; failed: number; provider?: string; error?: string }> {
	const { participants, meetingTitle, creatorName, summary, meetingId, appUrl } = params;
	const summaryUrl = params.sessionId
		? `${appUrl}/summary/${meetingId}?sessionId=${encodeURIComponent(params.sessionId)}`
		: `${appUrl}/summary/${meetingId}`;
	const dashboardUrl = `${appUrl}/dashboard`;

	// Deduplicate by email
	const unique = new Map<string, { email: string; name: string }>();
	for (const p of participants) {
		if (p.email && !p.email.toLowerCase().endsWith("@guest.local") && !unique.has(p.email.toLowerCase())) {
			unique.set(p.email.toLowerCase(), p);
		}
	}

	// Add always-email recipients (default recipients for every meeting)
	if (params.alwaysEmail) {
		for (const addr of params.alwaysEmail.split(",").map((s) => s.trim()).filter(Boolean)) {
			const key = addr.toLowerCase();
			if (!unique.has(key)) {
				unique.set(key, { email: addr, name: addr.split("@")[0] });
			}
		}
	}

	if (unique.size === 0) {
		console.log("[summary-email] No participants to email");
		return { sent: 0, failed: 0 };
	}

	const emailList: { email: string; name: string; html: string }[] = [];
	for (const [, p] of unique) {
		const html = buildEmailHtml({
			meetingTitle,
			creatorName,
			summary,
			summaryUrl,
			dashboardUrl,
			participantName: p.name || p.email.split("@")[0],
			meetingDate: params.meetingDate,
			endedAt: params.endedAt,
			participants: participants.map((p) => ({ name: p.name, email: p.email })),
			recordingUrl: params.recordingUrl,
			transcriptUrl: params.transcriptUrl ? params.transcriptUrl : `${summaryUrl}`,
		});
		emailList.push({ email: p.email, name: p.name, html });
	}

	const subject = `Meeting Summary: ${meetingTitle}`;

	const result = await sendEmailBatch(
		{
			smtpApiUrl: providers.SMTP_API_URL,
			resendApiKey: providers.RESEND_API_KEY,
			from: providers.EMAIL_FROM,
		},
		emailList.map((e) => ({ to: e.email, html: e.html })),
		subject,
	);

	if (result.sent > 0) {
		console.log("[summary-email] Sent", result.sent, "emails via", result.provider, ",", result.failed, "failed");
	} else {
		// Loud on purpose: a dead provider used to look like a successful send.
		console.log("[summary-email] DELIVERY FAILED via all providers:", result.error);
	}

	return { sent: result.sent, failed: result.failed, provider: result.provider, error: result.error };
}

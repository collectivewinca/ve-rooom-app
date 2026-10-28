import { getCachedResult, saveCachedResult, getMeetingMeta, getParticipants, getMeetingPrompt, getUserPrompt, addSummaryVersion, isEmailSent, markEmailSent, markEmailFailed, acquireTranscriptionLock, releaseTranscriptionLock, getTranscriptionLockOwner, acquireSummaryLock, releaseSummaryLock } from "./kv";
import { generateSummary, summarizeChunk, combineChunkSummaries } from "./summarizer";
import { sendSummaryEmails } from "./summary-email";
import { listRecordingRefs, sessionRecordingRefs } from "./recordings";
import type { AppEnv } from "./env";

const RTK_BASE = "https://api.cloudflare.com/client/v4/accounts";
const CHUNK_SIZE = 5 * 1024 * 1024;
const TIME_BUDGET_MS = 22000;
// Worst-case cost of one Whisper chunk / one summary chunk. A new chunk is only
// started when it can finish before the runtime's ~30s post-response kill, so
// the checkpoint always gets saved and the self-continue chain never dies mid-chunk.
const CHUNK_RESERVE_MS = 10000;
const SUMMARY_RESERVE_MS = 12000;
const MAX_TOTAL_SIZE = 1024 * 1024 * 1024;
const SUMMARY_CHUNK_CHAR_SIZE = 4000;
// Gemini supports 1M input tokens (~4M chars) — we can send the entire transcript
// in a single call. Raised from 30k to 200k so nearly all meetings skip map-reduce.
const SUMMARY_DIRECT_MAX_CHARS = 200000;

export interface PartialProgress {
	chunkIndex: number;
	transcriptParts: string[];
	totalChunks: number;
	totalSize: number;
}

export async function getAudioSize(url: string): Promise<number> {
	const probeRes = await fetch(url, { headers: { Range: "bytes=0-0" } });
	if (probeRes.status === 206) {
		const cr = probeRes.headers.get("content-range");
		if (cr) {
			const match = cr.match(/\/(\d+)$/);
			if (match) return parseInt(match[1]);
		}
	}
	const cl = probeRes.headers.get("content-length");
	return cl ? parseInt(cl) : 0;
}

/**
 * Where the composite audio for this session is read from.
 *
 * RTK's presigned download URLs expire 7 days after the recording, so any
 * pipeline that runs late (or re-runs) would otherwise probe a dead URL and
 * silently produce nothing. When the health-check has already copied the
 * session's audio into our own R2 bucket we read straight from R2 instead —
 * permanent, session-scoped, and no HTTP round trip through a proxy endpoint.
 */
type AudioSource =
	| { kind: "r2"; key: string; size: number }
	| { kind: "url"; url: string; size: number };

async function resolveAudioSource(
	env: Pick<AppEnv, "RECORDINGS_BUCKET">,
	meetingId: string,
	sessionId: string | undefined,
	url: string,
): Promise<AudioSource> {
	// Only trust R2 when we know the session: a meeting-wide guess could pick
	// another session's audio and produce a confidently wrong transcript.
	if (env.RECORDINGS_BUCKET && sessionId) {
		try {
			const refs = await listRecordingRefs(env.RECORDINGS_BUCKET, meetingId);
			const audio = sessionRecordingRefs(refs, sessionId).find((r) => r.type === "audio");
			if (audio) {
				const head = await env.RECORDINGS_BUCKET.head(audio.key);
				if (head && head.size > 0) {
					console.log("[transcribe-core] Source: permanent R2 copy", audio.key, `(${head.size} bytes)`);
					return { kind: "r2", key: audio.key, size: head.size };
				}
			}
		} catch (e) {
			console.log("[transcribe-core] R2 source lookup failed:", e instanceof Error ? e.message : String(e));
		}
	}
	const size = await getAudioSize(url);
	console.log("[transcribe-core] Source: download URL, size probe", size, "bytes");
	return { kind: "url", url, size };
}

async function readAudioRange(source: AudioSource, start: number, end: number, bucket?: R2Bucket): Promise<ArrayBuffer | null> {
	if (source.kind === "r2") {
		if (!bucket) return null;
		const object = await bucket.get(source.key, { range: { offset: start, length: end - start + 1 } });
		return object ? object.arrayBuffer() : null;
	}
	const res = await fetch(source.url, { headers: { Range: `bytes=${start}-${end}` } });
	if (!res.ok) {
		console.log(`[transcribe-core] Range download failed: ${res.status}`);
		return null;
	}
	return res.arrayBuffer();
}

export function isHallucination(text: string): boolean {
	if (!text || text.length === 0) return true;
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	if (words.length === 0) return true;
	const uniqueWords = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")));
	const repetitionRatio = uniqueWords.size / words.length;
	if (repetitionRatio < 0.15) {
		console.log(`[transcribe-core] Hallucination: word repetition ${repetitionRatio.toFixed(2)} (${uniqueWords.size}/${words.length})`);
		return true;
	}
	const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
	if (sentences.length >= 2) {
		const uniqueSentences = new Set(sentences.map((s) => s.trim().toLowerCase()));
		const sRatio = uniqueSentences.size / sentences.length;
		if (sRatio < 0.5) {
			console.log(`[transcribe-core] Hallucination: sentence repetition ${sRatio.toFixed(2)} (${uniqueSentences.size}/${sentences.length})`);
			return true;
		}
	}
	// Catch phrases like "Thank you. Thank you. Thank you." where individual
	// sentences repeat (even short ones). The per-sentence check above already
	// handles this, but also guard against long repeated phrases without
	// terminal punctuation (e.g. "you. Thank you. Thank" runs together).
	const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
	if (normalized.length > 0) {
		const tokens = normalized.split(" ").filter(Boolean);
		if (tokens.length >= 4) {
			const bigrams: string[] = [];
			for (let i = 0; i < tokens.length - 1; i++) bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
			const uniqueBigrams = new Set(bigrams);
			const bRatio = uniqueBigrams.size / bigrams.length;
			if (bRatio < 0.4) {
				console.log(`[transcribe-core] Hallucination: bigram repetition ${bRatio.toFixed(2)} (${uniqueBigrams.size}/${bigrams.length})`);
				return true;
			}
		}
	}
	return false;
}

export function dedupeTranscript(text: string): string {
	const lines = text.split("\n");
	const seen = new Set<string>();
	const out: string[] = [];
	let consecutiveDupes = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			out.push(line);
			continue;
		}
		const key = trimmed.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
		if (seen.has(key)) {
			consecutiveDupes++;
			if (consecutiveDupes > 2) continue;
		} else {
			consecutiveDupes = 0;
		}
		seen.add(key);
		out.push(line);
	}
	const result = out.join("\n");
	console.log("[transcribe-core] Dedupe: removed", text.length - result.length, "chars of repetition");
	return result;
}

async function transcribeChunk(env: Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN">, authHeaders: Record<string, string>, audioBuffer: ArrayBuffer, label: string): Promise<string | undefined> {
	try {
		const whisperRes = await fetch(
			`${RTK_BASE}/${env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`,
			{
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "audio/mpeg" },
				body: audioBuffer,
			}
		);

		if (whisperRes.ok) {
			const wj = await whisperRes.json() as { result?: { text?: string } };
			const wt = wj.result?.text?.trim();
			console.log(`[transcribe-core] Whisper ${label}:`, wt?.length || 0, "chars");

			if (wt && wt.length > 0) {
				if (isHallucination(wt)) {
					console.log(`[transcribe-core] ${label} — hallucination detected, skipping`);
					return undefined;
				}
				return wt;
			}
		} else {
			const errText = await whisperRes.text();
			console.log(`[transcribe-core] Whisper ${label} failed:`, whisperRes.status, errText.slice(0, 200));
		}
	} catch (e) {
		console.log(`[transcribe-core] Whisper ${label} error:`, e instanceof Error ? e.message : String(e));
	}
	return undefined;
}

export type TranscribeResult =
	| { status: "transcribed"; transcript: string }
	| { status: "processing"; message: string; transcript?: string; chunksDone: number; totalChunks: number }
	| { status: "silent"; message: string; sizeMb?: string; numChunks?: number }
	| { status: "too_large"; sizeMb: string; message: string }
	| { status: "error"; error: string };

export async function transcribeCompositeAudio(
	env: Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "MEETING_CACHE" | "RECORDINGS_BUCKET">,
	meetingId: string,
	audioUrl: string,
	sessionId?: string,
	owner?: string,
): Promise<TranscribeResult> {
	const lockOwner = owner || `api-${Date.now()}`;
	const partialKey = sessionId ? `meeting:${meetingId}:session:${sessionId}:partial` : `meeting:${meetingId}:partial`;
	let partial: PartialProgress | null = null;
	try {
		const rawPartial = await env.MEETING_CACHE.get(partialKey);
		if (rawPartial) {
			partial = JSON.parse(rawPartial) as PartialProgress;
			console.log("[transcribe-core] Resuming from chunk", partial.chunkIndex + 1, "/", partial.totalChunks);
		}
	} catch { }

	const existing = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
	if (existing && existing.transcript && !partial) {
		console.log("[transcribe-core] Cached transcript found —", existing.transcript.length, "chars, summary:", existing.summary?.length || 0, "chars");
		return { status: "transcribed", transcript: existing.transcript };
	}

	// Try to acquire transcription lock — prevents webhook + frontend racing
	const acquired = await acquireTranscriptionLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId, 120);
	if (!acquired) {
		const currentOwner = await getTranscriptionLockOwner(env.MEETING_CACHE, meetingId, sessionId);
		console.log("[transcribe-core] Lock held by", currentOwner, "— returning processing");
		if (partial) {
			return {
				status: "processing",
				message: `Another process is transcribing. ${partial.chunkIndex}/${partial.totalChunks} chunks done.`,
				transcript: partial.transcriptParts.join("\n\n"),
				chunksDone: partial.chunkIndex,
				totalChunks: partial.totalChunks,
			};
		}
		return {
			status: "processing",
			message: "Another process is transcribing.",
			chunksDone: 0,
			totalChunks: 0,
		};
	}

	const authHeaders = { Authorization: `Bearer ${env.CF_API_TOKEN}` };
	const startTime = Date.now();

	try {
		const source = await resolveAudioSource(env, meetingId, sessionId, audioUrl);
		const totalSize = source.size;
		const sizeMb = totalSize / (1024 * 1024);
		console.log("[transcribe-core] Composite size:", sizeMb.toFixed(1), "MB");

		if (totalSize === 0) {
			return {
				status: "error",
				error: `Could not determine audio file size — the recording URL has likely expired (${audioUrl.slice(0, 80)}…) and no permanent copy exists in R2 yet.`,
			};
		}

		if (totalSize > MAX_TOTAL_SIZE) {
			return {
				status: "too_large",
				sizeMb: sizeMb.toFixed(1),
				message: `Audio file is ${sizeMb.toFixed(1)} MB (max ${MAX_TOTAL_SIZE / 1024 / 1024} MB).`,
			};
		}

		const numChunks = Math.ceil(totalSize / CHUNK_SIZE);
		const chunkTranscripts: string[] = [...(partial?.transcriptParts || [])];
		let startChunk = partial?.chunkIndex ?? 0;
		let chunksDone = 0;
		let hallucinationCount = 0;

		console.log("[transcribe-core] Will process chunks", startChunk + 1, "to", numChunks, "of", CHUNK_SIZE / (1024 * 1024), "MB each");

		for (let i = startChunk; i < numChunks; i++) {
			const elapsed = Date.now() - startTime;
			if (elapsed > TIME_BUDGET_MS || (chunksDone > 0 && elapsed + CHUNK_RESERVE_MS > TIME_BUDGET_MS)) {
				console.log("[transcribe-core] Time budget exceeded at chunk", i + 1, "/", numChunks, "— saving partial");
				const progress: PartialProgress = {
					chunkIndex: i,
					transcriptParts: chunkTranscripts,
					totalChunks: numChunks,
					totalSize,
				};
				try { await env.MEETING_CACHE.put(partialKey, JSON.stringify(progress)); } catch { }
				await releaseTranscriptionLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId);

				if (chunkTranscripts.length > 0) {
					return {
						status: "processing",
						message: `Transcribed ${i}/${numChunks} chunks so far.`,
						transcript: chunkTranscripts.join("\n\n"),
						chunksDone: i,
						totalChunks: numChunks,
					};
				}
				return {
					status: "processing",
					message: `Processing chunk ${i + 1}/${numChunks}.`,
					chunksDone: i,
					totalChunks: numChunks,
				};
			}

			const start = i * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
			const chunkMb = (end - start + 1) / (1024 * 1024);
			console.log(`[transcribe-core] Chunk ${i + 1}/${numChunks} — bytes ${start}-${end} (${chunkMb.toFixed(1)} MB)`);

			try {
				const chunkBuffer = await readAudioRange(source, start, end, env.RECORDINGS_BUCKET);
				if (!chunkBuffer) {
					console.log(`[transcribe-core] Chunk ${i + 1} download failed`);
					continue;
				}
				const chunkText = await transcribeChunk(env, authHeaders, chunkBuffer, `chunk ${i + 1}/${numChunks}`);

				if (chunkText) {
					chunkTranscripts.push(chunkText);
					console.log(`[transcribe-core] Chunk ${i + 1} transcript:`, chunkText.length, "chars");
				} else {
					console.log(`[transcribe-core] Chunk ${i + 1} produced no transcript`);
					hallucinationCount++;
				}
				chunksDone++;
			} catch (e) {
				console.log(`[transcribe-core] Chunk ${i + 1} error:`, e instanceof Error ? e.message : String(e));
			}
		}

		try { await env.MEETING_CACHE.delete(partialKey); } catch { }
		await releaseTranscriptionLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId);

		if (chunkTranscripts.length > 0) {
			const transcriptText = dedupeTranscript(chunkTranscripts.join("\n\n"));
			console.log("[transcribe-core] Merged", chunkTranscripts.length, "/", chunksDone, "chunks, total:", transcriptText.length, "chars");
			await saveCachedResult(env.MEETING_CACHE, meetingId, { transcript: transcriptText, summary: "", cachedAt: new Date().toISOString() }, sessionId);
			return { status: "transcribed", transcript: transcriptText };
		}

		console.log(`[transcribe-core] All ${numChunks} chunks produced no transcript (${hallucinationCount} hallucinations) — silent`);
		return {
			status: "silent",
			sizeMb: sizeMb.toFixed(1),
			numChunks,
			message: `No speech detected in the recording (${sizeMb.toFixed(1)} MB, ${numChunks} chunks analyzed). The audio appears to be silent or the microphone was muted.`,
		};
	} catch (e) {
		await releaseTranscriptionLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId);
		return { status: "error", error: e instanceof Error ? e.message : String(e) };
	}
}

export async function resolvePrompt(env: Pick<AppEnv, "MEETING_CACHE">, meetingId: string): Promise<string | undefined> {
	let prompt = await getMeetingPrompt(env.MEETING_CACHE, meetingId);
	if (!prompt) {
		const meta = await getMeetingMeta(env.MEETING_CACHE, meetingId);
		if (meta?.createdBy?.email) {
			prompt = await getUserPrompt(env.MEETING_CACHE, meta.createdBy.email);
		}
	}
	return prompt || undefined;
}

export async function buildMeetingContext(env: Pick<AppEnv, "MEETING_CACHE">, meetingId: string): Promise<string> {
	try {
		const [meta, participants] = await Promise.all([
			getMeetingMeta(env.MEETING_CACHE, meetingId),
			getParticipants(env.MEETING_CACHE, meetingId),
		]);
		if (!meta) return "";
		const title = meta.title || "Untitled Meeting";
		const hostName = meta.createdBy?.name || "Unknown";
		const date = new Date(meta.createdAt).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
		const participantNames = participants.length > 0
			? participants.map((p) => p.name || p.email).join(", ")
			: "Unknown";
		return `Meeting Context:\n- Title: ${title}\n- Host: ${hostName}\n- Date: ${date}\n- Participants: ${participantNames}\n\nUse this context to make your summary more accurate. Reference participants by name when possible.\n\n---\n\n`;
	} catch {
		return "";
	}
}

export type SummaryResult =
	| { status: "ok"; summary: string }
	| { status: "no_summary"; message: string };

export async function generateMeetingSummary(
	env: AppEnv,
	meetingId: string,
	transcript: string,
	customPrompt?: string,
	sessionId?: string,
): Promise<SummaryResult> {
	// Dedup guard: re-check cache — another process may have already generated the summary
	const cached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
	if (cached?.summary) {
		console.log("[summary-core] Summary already cached for", meetingId, "— skipping");
		return { status: "ok", summary: cached.summary };
	}

	// Acquire summary lock — prevents recording.statusUpdate + meeting.ended from
	// both generating summaries concurrently for the same session
	const lockOwner = `summary-${Date.now()}`;
	const acquired = await acquireSummaryLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId, 90);
	if (!acquired) {
		console.log("[summary-core] Summary lock held by another process for", meetingId, "— waiting");
		// Wait briefly and re-check cache — the other process should finish soon
		await new Promise((r) => setTimeout(r, 5000));
		const retried = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (retried?.summary) {
			console.log("[summary-core] Summary appeared while waiting for lock — using it");
			return { status: "ok", summary: retried.summary };
		}
		// Lock expired or other process failed — try to acquire again
		const reacquired = await acquireSummaryLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId, 90);
		if (!reacquired) {
			console.log("[summary-core] Still locked after wait — giving up");
			return { status: "no_summary", message: "Summary generation already in progress." };
		}
	}

	try {
		// Re-check cache after acquiring lock (another process may have just finished)
		const postLockCached = await getCachedResult(env.MEETING_CACHE, meetingId, sessionId);
		if (postLockCached?.summary) {
			console.log("[summary-core] Summary appeared after lock acquisition — using it");
			return { status: "ok", summary: postLockCached.summary };
		}

		const context = await buildMeetingContext(env, meetingId);
		const input = context + transcript;
		const prompt = customPrompt || await resolvePrompt(env, meetingId);

		if (input.length <= SUMMARY_DIRECT_MAX_CHARS) {
			console.log("[summary-core] Short transcript:", input.length, "chars — single call");
			let summary: string | undefined;
			const callStart = Date.now();
			for (let attempt = 1; attempt <= 3; attempt++) {
				summary = await generateSummary(input, env, prompt);
				if (summary) break;
				// Allow up to 25s for the direct path — it runs in waitUntil with a 30s budget,
				// and Workers AI can take 15-20s for a large 50k-char transcript.
				if (Date.now() - callStart > 12000) {
					console.log(`[summary-core] Attempt ${attempt} ran over time budget — deferring to next link`);
					return { status: "no_summary", message: `Summary attempt ${attempt} ran over budget. Will continue on next call.` };
				}
				console.log(`[summary-core] Summary attempt ${attempt}/3 failed${attempt < 3 ? " — retrying" : ""}`);
				if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
			}
			if (summary) {
				await persistSummary(env, meetingId, transcript, summary, prompt, sessionId);
				return { status: "ok", summary };
			}
			return { status: "no_summary", message: "Could not generate summary after 3 attempts." };
		}

		// Map-reduce for long transcripts
		const partialKey = sessionId ? `meeting:${meetingId}:session:${sessionId}:summary-partial` : `meeting:${meetingId}:summary-partial`;
		let partial: { chunkIndex: number; chunkSummaries: string[]; totalChunks: number } | null = null;
		try {
			const raw = await env.MEETING_CACHE.get(partialKey);
			if (raw) {
				const parsed = JSON.parse(raw) as { chunkIndex: number; chunkSummaries: string[]; totalChunks: number };
				partial = parsed;
				console.log("[summary-core] Resuming from chunk", parsed.chunkIndex + 1, "/", parsed.totalChunks);
			}
		} catch { }

		const numChunks = Math.ceil(input.length / SUMMARY_CHUNK_CHAR_SIZE);
		const chunkSummaries: string[] = [...(partial?.chunkSummaries || [])];
		let startChunk = partial?.chunkIndex ?? 0;
		const startTime = Date.now();

		console.log("[summary-core] Map-reduce:", input.length, "chars →", numChunks, "chunks");

		for (let i = startChunk; i < numChunks; i++) {
			const mapElapsed = Date.now() - startTime;
			if (mapElapsed > TIME_BUDGET_MS || (i > startChunk && mapElapsed + SUMMARY_RESERVE_MS > TIME_BUDGET_MS)) {
				console.log("[summary-core] Time budget exceeded at chunk", i + 1, "/", numChunks);
				await env.MEETING_CACHE.put(partialKey, JSON.stringify({ chunkIndex: i, chunkSummaries, totalChunks: numChunks }));
				return { status: "no_summary", message: `Summarized ${i}/${numChunks} chunks. Will continue on next call.` };
			}
			const start = i * SUMMARY_CHUNK_CHAR_SIZE;
			const chunkText = input.slice(start, Math.min(start + SUMMARY_CHUNK_CHAR_SIZE, input.length));
			try {
				const s = await summarizeChunk(chunkText, env);
				if (s) {
					chunkSummaries.push(s);
					console.log(`[summary-core] Chunk ${i + 1} summary:`, s.length, "chars");
				}
			} catch (e) {
				console.log(`[summary-core] Chunk ${i + 1} error:`, e instanceof Error ? e.message : String(e));
			}
		}

		if (chunkSummaries.length === 0) {
			return { status: "no_summary", message: "All chunk summaries failed." };
		}

		// If the combine call wouldn't fit in this link's remaining budget,
		// checkpoint with all chunks done — the next link skips straight to
		// combine with a fresh budget.
		if (Date.now() - startTime + SUMMARY_RESERVE_MS > TIME_BUDGET_MS) {
			console.log("[summary-core] Deferring combine to next link — checkpointing", chunkSummaries.length, "chunk summaries");
			await env.MEETING_CACHE.put(partialKey, JSON.stringify({ chunkIndex: numChunks, chunkSummaries, totalChunks: numChunks }));
			return { status: "no_summary", message: `Summarized ${numChunks}/${numChunks} chunks. Will continue on next call.` };
		}

		const combined = chunkSummaries.map((s, i) => `### Part ${i + 1} of ${numChunks}\n\n${s}`).join("\n\n---\n\n");
		const finalSummary = combined.length <= SUMMARY_DIRECT_MAX_CHARS
			? await combineChunkSummaries(combined, env, prompt)
			: await combineChunkSummaries(combined.slice(0, SUMMARY_DIRECT_MAX_CHARS) + "\n\n[...]", env, prompt);

		if (finalSummary) {
			await persistSummary(env, meetingId, transcript, finalSummary, prompt, sessionId);
			try { await env.MEETING_CACHE.delete(partialKey); } catch { }
			return { status: "ok", summary: finalSummary };
		}
		return { status: "no_summary", message: "Could not combine chunk summaries." };
	} finally {
		await releaseSummaryLock(env.MEETING_CACHE, meetingId, lockOwner, sessionId);
	}
}

async function persistSummary(env: AppEnv, meetingId: string, transcript: string, summary: string, prompt?: string, sessionId?: string): Promise<void> {
	await saveCachedResult(env.MEETING_CACHE, meetingId, { transcript, summary, cachedAt: new Date().toISOString() }, sessionId);
	await addSummaryVersion(env.MEETING_CACHE, meetingId, { summary, prompt, createdAt: new Date().toISOString() }, sessionId);
	console.log("[summary-core] Persisted summary for", meetingId, sessionId ? `session ${sessionId}` : "", "—", summary.length, "chars");
}

export async function maybeSendAutoEmail(env: AppEnv, meetingId: string, summary: string, appUrl: string, sessionId?: string): Promise<void> {
	try {
		// Atomic check-and-set: mark email as sent BEFORE sending, not after.
		// This prevents the race where both recording.statusUpdate and
		// meeting.ended fire simultaneously, both pass the isEmailSent check,
		// and both send duplicate emails. If isEmailSent already true, skip.
		const alreadySent = await isEmailSent(env.MEETING_CACHE, meetingId, sessionId);
		if (alreadySent) {
			console.log("[summary-core] Email already sent for", meetingId, sessionId ? `session ${sessionId}` : "");
			return;
		}
		// Claim the email-sent marker immediately — if another process already
		// claimed it between our check and now, skip.
		await markEmailSent(env.MEETING_CACHE, meetingId, sessionId);
		if (!env.SMTP_API_URL && !env.RESEND_API_KEY) return;
		const [meta, participants] = await Promise.all([
			getMeetingMeta(env.MEETING_CACHE, meetingId),
			getParticipants(env.MEETING_CACHE, meetingId),
		]);
		const recipients = [...participants];
		if (env.ALWAYS_EMAIL) {
			for (const addr of env.ALWAYS_EMAIL.split(",").map((s) => s.trim()).filter(Boolean)) {
				if (!recipients.some((p) => p.email.toLowerCase() === addr.toLowerCase())) {
					recipients.push({ email: addr, name: addr.split("@")[0], joinedAt: "" });
				}
			}
		}
		if (meta && !recipients.some((p) => p.email.toLowerCase() === meta.createdBy?.email?.toLowerCase()) && meta.createdBy?.email) {
			recipients.push({ email: meta.createdBy.email, name: meta.createdBy.name || meta.createdBy.email.split("@")[0], joinedAt: "" });
		}
		if (meta && recipients.length > 0) {
			const delivery = await sendSummaryEmails(env, {
				participants: recipients,
				meetingTitle: meta.title || "Untitled Meeting",
				creatorName: meta.createdBy?.name || "Someone",
				summary,
				meetingId,
				appUrl,
				alwaysEmail: env.ALWAYS_EMAIL,
				meetingDate: meta.createdAt,
				sessionId,
			});
			if (delivery.sent > 0) {
				console.log("[summary-core] Auto-email sent for", meetingId, sessionId ? `session ${sessionId}` : "", "to", recipients.length, "recipients");
			} else {
				// Record the failure so it is visible in the dashboard instead of
				// looking like a successful send.
				await markEmailFailed(env.MEETING_CACHE, meetingId, sessionId, delivery.error || "all providers failed");
				console.log("[summary-core] Auto-email FAILED for", meetingId, sessionId ? `session ${sessionId}` : "", "-", delivery.error);
			}
		}
	} catch (e) {
		console.log("[summary-core] Auto email error:", e);
	}
}
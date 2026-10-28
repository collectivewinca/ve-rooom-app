import type { AppEnv } from "./env";

type LLMEnv = Pick<AppEnv, "CF_ACCOUNT_ID" | "CF_API_TOKEN" | "OPENROUTER_API_KEY" | "OPENROUTER_MODEL" | "OPENROUTER_FREE_MODEL" | "OLLAMA_API_KEY" | "OLLAMA_BASE_URL" | "OLLAMA_MODEL" | "GEMINI_API_KEY">;

const SUMMARY_SYSTEM_PROMPT = `You are an expert meeting analyst and executive assistant. Your job is to analyze a meeting transcript and produce a comprehensive, detailed, well-structured Markdown summary.

This summary must be thorough enough that someone who did NOT attend the meeting can understand exactly what was discussed, what was decided, and what needs to happen next. Aim for depth, not brevity.

Here is the format you MUST follow:

## Meeting Summary
Write a detailed overview (2-3 paragraphs, 6-12 sentences total) explaining what the meeting was about, its purpose, the overall tone, the main themes discussed, and the key outcomes. Include who was present if identifiable from the transcript. Mention the meeting date or context if available.

## Key Topics Discussed
For EACH distinct topic discussed during the meeting, create a sub-section with:
- **Topic name** as a bold sub-heading
- 3-6 sentences explaining what was said about it in detail
- Specific points, numbers, quotes, or details mentioned by participants
- Who raised the topic and who responded
- Any disagreements or alternative viewpoints expressed

Do NOT combine multiple topics into one bullet. Each topic gets its own detailed paragraph. Aim for at least 5-10 topics if the meeting covered that many.

## Decisions Made
List every decision that was reached during the meeting. Each decision should be a bullet point with the decision in **bold** followed by 2-3 sentences explaining the rationale and who advocated for it. If no formal decisions were made, note that and describe what was still being deliberated.

## Action Items
Extract every action item, task, or follow-up mentioned. Format as a checklist:
- [ ] **Owner Name** — Task description (deadline if mentioned, context if available)
If an owner is not identifiable, use **Unassigned**. Include any deadlines, timelines, or dependencies mentioned. Also note who raised the action item.

## Open Questions
List any questions that were raised but not resolved during the meeting. For each, note who asked it and what context surrounded it. Format as bullet points. If none, note "No open questions."

## Participants
List the participants who spoke during the meeting (identifiable from the transcript). For each, note:
- Their name
- Their role in the discussion (e.g., "leading the meeting", "presenting updates", "asking questions")
- Key points they contributed

## Sentiment & Engagement
Provide a brief assessment (3-5 sentences) of the meeting's energy, engagement level, and any notable dynamics (e.g., disagreements, enthusiasm, confusion, urgency, side conversations, humor).

Rules:
- Be EXHAUSTIVE and detailed — this summary should be useful for someone who did NOT attend the meeting.
- Use the actual words, names, and details from the transcript. Do NOT invent information.
- Quote participants directly when they make important points (use "quotation marks").
- If the transcript is unclear or fragmented, do your best and note any gaps.
- Keep it professional, clear, and well-structured with proper Markdown formatting.
- Do NOT be brief. A good summary for a 1-hour meeting should be 1500-3000 words.
- Reference specific moments, numbers, dates, and names whenever they appear in the transcript.`;

export const DEFAULT_SUMMARY_PROMPT = SUMMARY_SYSTEM_PROMPT;

export async function generateSummary(
	transcriptText: string,
	env: LLMEnv,
	customPrompt?: string,
): Promise<string | undefined> {
	const systemPrompt = customPrompt && customPrompt.trim().length > 0 ? customPrompt.trim() : SUMMARY_SYSTEM_PROMPT;
	return callLLM(transcriptText, systemPrompt, env, true);
}

const CHUNK_SUMMARY_PROMPT = `You are summarizing a portion (chunk) of a long meeting transcript. This is one of several chunks that will be combined later, so focus ONLY on this section.

Produce a DETAILED structured summary of THIS chunk. Be thorough — capture as much substance as possible:
- Key topics discussed (with specifics: names, numbers, dates, quotes)
- Any decisions made (who decided, what was decided, why)
- Any action items or follow-ups (who, what, when)
- Notable quotes or important points (use quotation marks for direct quotes)
- Any open questions raised (who asked, what context)
- Participant dynamics (disagreements, enthusiasm, confusion)
- Technical details, numbers, or data points mentioned

Write in bullet points but be SPECIFIC and DETAILED. Do NOT write a brief overview — capture the substance. Aim for 200-400 words per chunk summary.

Do NOT write a general meeting overview — that will be done in the final combine step. Just extract the substance of THIS chunk with full detail.`;

const COMBINE_PROMPT = `You are given detailed summaries of several chunks from a long meeting. Each chunk summary covers a portion of the meeting in chronological order. Combine them into one comprehensive, detailed, well-structured Markdown summary.

This combined summary must be thorough enough that someone who did NOT attend the meeting can understand exactly what was discussed, decided, and what happens next. Aim for depth, not brevity.

Here is the format you MUST follow:

## Meeting Summary
Write a detailed overview (2-3 paragraphs, 6-12 sentences total) explaining what the meeting was about, its purpose, the overall tone, the main themes discussed, and the key outcomes. Include who was present.

## Key Topics Discussed
For EACH distinct topic discussed during the meeting, create a sub-section with:
- **Topic name** as a bold sub-heading
- 3-6 sentences explaining what was said about it in detail
- Specific points, numbers, quotes, or details mentioned by participants
- Who raised the topic and who responded
- Any disagreements or alternative viewpoints expressed

Merge duplicate topics across chunks. Do NOT combine multiple topics into one bullet. Each topic gets its own detailed paragraph. Order by importance, not by chunk order.

## Decisions Made
List every decision that was reached during the meeting. Each decision should be a bullet point with the decision in **bold** followed by 2-3 sentences explaining the rationale and who advocated for it.

## Action Items
Extract every action item, task, or follow-up mentioned. Format as a checklist:
- [ ] **Owner Name** — Task description (deadline if mentioned, context if available)

## Open Questions
List any questions that were raised but not resolved. For each, note who asked it and the context. Format as bullet points.

## Participants
List the participants who spoke (identifiable from the summaries). For each, note their role and key contributions.

## Sentiment & Engagement
Provide a brief assessment (3-5 sentences) of the meeting's energy and dynamics.

Rules:
- Be EXHAUSTIVE — useful for someone who did NOT attend.
- Use actual words, names, and quotes from the chunk summaries. Do NOT invent information.
- Do NOT be brief. A good combined summary for a 1-hour meeting should be 1500-3000 words.
- Keep it professional with proper Markdown formatting.`;

export async function summarizeChunk(
	chunkText: string,
	env: LLMEnv,
): Promise<string | undefined> {
	return callLLM(chunkText, CHUNK_SUMMARY_PROMPT, env, false);
}

export async function combineChunkSummaries(
	combinedText: string,
	env: LLMEnv,
	customPrompt?: string,
): Promise<string | undefined> {
	const prompt = customPrompt && customPrompt.trim().length > 0 ? customPrompt.trim() : COMBINE_PROMPT;
	return callLLM(combinedText, prompt, env, true);
}

async function callLLM(
	userContent: string,
	systemPrompt: string,
	env: LLMEnv,
	requireMarkdown = true,
): Promise<string | undefined> {
	const allProviders: { label: string; run: () => Promise<string | undefined> }[] = [];

	// Gemini models: 1M token input context → can summarize entire long transcripts
	// in a single call without chunking. Use Gemini 3.1 Flash Lite (500 RPD),
	// then 3.5 Flash Lite, 3.6 Flash, 3.5 Flash, 2.5 Flash as fallbacks.
	// Use Gemini for medium+ inputs (>10k chars) to avoid Workers AI output truncation.
	const isLargeInput = userContent.length > 10000;
	if (isLargeInput && env.GEMINI_API_KEY && env.GEMINI_API_KEY !== "placeholder") {
		const geminiModels = [
			"gemini-3.1-flash-lite",
			"gemini-3.5-flash-lite",
			"gemini-3.6-flash",
			"gemini-3.5-flash",
			"gemini-2.5-flash",
		];
		for (const model of geminiModels) {
			allProviders.push({
				label: `Gemini ${model}`,
				run: () => callGemini(model, systemPrompt, userContent, env.GEMINI_API_KEY!),
			});
		}
	}

	// Workers AI: in-network, ~5-10s per call. Primary for small transcripts.
	if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
		allProviders.push({
			label: "Workers AI llama-3.3-70b",
			run: async () => {
				try {
					const res = await fetch(
						`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CF_API_TOKEN}` },
							body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], max_tokens: 4096 }),
						},
					);
					if (res.ok) {
						const oj = await res.json() as { result?: { response?: string } };
						const c = oj.result?.response;
						if (c) return c;
					} else {
						const err = await res.text();
						console.log(`[summarizer] Workers AI ${res.status}: ${err.slice(0, 200)}`);
					}
				} catch (e) {
					console.log(`[summarizer] Workers AI error: ${e instanceof Error ? e.message : String(e)}`);
				}
				return undefined;
			},
		});
	}

	// OpenRouter (second for small inputs, before Gemini to conserve quota)
	const openrouterModels = [
		env.OPENROUTER_MODEL || "openrouter/free",
		env.OPENROUTER_FREE_MODEL || "openrouter/free",
	].filter((m, i, arr) => arr.indexOf(m) === i);
	for (const model of openrouterModels) {
		if (!env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY === "placeholder") continue;
		allProviders.push({
			label: `OpenRouter ${model}`,
			run: async () => {
				try {
					const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
						},
						body: JSON.stringify({
							model,
							messages: [
								{ role: "system", content: systemPrompt },
								{ role: "user", content: userContent },
							],
							max_tokens: 4096,
						}),
					});
					if (res.ok) {
						const oj = await res.json() as { choices?: { message?: { content?: string } }[] };
						const c = oj.choices?.[0]?.message?.content;
						if (c) return c;
					} else {
						const err = await res.text();
						console.log(`[summarizer] OpenRouter ${model} ${res.status}: ${err.slice(0, 200)}`);
					}
				} catch (e) {
					console.log(`[summarizer] OpenRouter ${model} error: ${e instanceof Error ? e.message : String(e)}`);
				}
				return undefined;
			},
		});
	}

	// Gemini as fallback for small inputs (after OpenRouter to conserve quota)
	if (!isLargeInput && env.GEMINI_API_KEY && env.GEMINI_API_KEY !== "placeholder") {
		allProviders.push({
			label: "Gemini 3.1 Flash Lite (small fallback)",
			run: () => callGemini("gemini-3.1-flash-lite", systemPrompt, userContent, env.GEMINI_API_KEY!),
		});
	}

	// Ollama (last resort)
	if (env.OLLAMA_BASE_URL && env.OLLAMA_API_KEY && env.OLLAMA_API_KEY !== "placeholder") {
		const model = env.OLLAMA_MODEL || "gpt-oss:120b";
		allProviders.push({
			label: `Ollama ${model}`,
			run: async () => {
				try {
					const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${env.OLLAMA_API_KEY}`,
						},
						body: JSON.stringify({
							model,
							stream: false,
							messages: [
								{ role: "system", content: systemPrompt },
								{ role: "user", content: userContent },
							],
						}),
					});
					if (res.ok) {
						const oj = await res.json() as { message?: { content?: string } };
						return oj.message?.content;
					}
				} catch (e) {
					console.log(`[summarizer] Ollama error: ${e instanceof Error ? e.message : String(e)}`);
				}
				return undefined;
			},
		});
	}

	for (const provider of allProviders) {
		const result = await provider.run();
		if (result && isValidSummary(result, requireMarkdown)) {
			return result;
		}
		if (result) {
			console.log(`[summarizer] ${provider.label} produced invalid summary (${result.length} chars, requireMarkdown=${requireMarkdown}), trying next provider`);
		}
	}

	return undefined;
}

/**
 * Call Google Gemini API (generativelanguage.googleapis.com).
 * Uses systemInstruction for the system prompt and contents for the user message.
 */
async function callGemini(model: string, systemPrompt: string, userContent: string, apiKey: string): Promise<string | undefined> {
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					systemInstruction: { parts: [{ text: systemPrompt }] },
					contents: [{ role: "user", parts: [{ text: userContent }] }],
					generationConfig: {
						temperature: 0.7,
						topP: 0.95,
						maxOutputTokens: 65536,
					},
				}),
			},
		);
		if (res.ok) {
			const oj = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
			const c = oj.candidates?.[0]?.content?.parts?.[0]?.text;
			if (c) return c;
		} else {
			const err = await res.text();
			console.log(`[summarizer] Gemini ${model} ${res.status}: ${err.slice(0, 300)}`);
		}
	} catch (e) {
		console.log(`[summarizer] Gemini ${model} error: ${e instanceof Error ? e.message : String(e)}`);
	}
	return undefined;
}

function isValidSummary(text: string, requireMarkdown = true): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 100) return false;
	const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
	if (words.length < 30) return false;
	if (requireMarkdown && !trimmed.includes("##") && !trimmed.includes("# ") && !trimmed.includes("- ")) return false;
	// Detect mid-sentence truncation: a well-formed summary should end with terminal
	// punctuation (., !, ?, :), a closing quote/paren, or a markdown list item. If it
	// ends on a word without any of these, the model was likely cut off by a token cap.
	const lastChar = trimmed.slice(-1);
	if (!/[.!?):"'-]/.test(lastChar)) {
		console.log(`[summarizer] Rejected likely-truncated summary (ends with "${lastChar}", ${words.length} words, ${trimmed.length} chars)`);
		return false;
	}
	return true;
}
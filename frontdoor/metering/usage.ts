/**
 * Reads token usage from Anthropic Messages API responses (P2-01).
 *
 * The reading follows pi-ai's own Anthropic stream (anthropic-messages.js),
 * so the proxy's tokens match what upstream records: message_start sets
 * every field, and each message_delta replaces the fields it carries.
 */

import type { TokenUsage } from "./store.ts";

interface AnthropicUsage {
	input_tokens?: unknown;
	output_tokens?: unknown;
	cache_read_input_tokens?: unknown;
	cache_creation_input_tokens?: unknown;
	cache_creation?: { ephemeral_1h_input_tokens?: unknown } | null;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const present = (value: unknown): value is number => typeof value === "number";

function fromUsage(usage: AnthropicUsage | undefined): TokenUsage {
	return {
		inputTokens: count(usage?.input_tokens),
		outputTokens: count(usage?.output_tokens),
		cacheReadTokens: count(usage?.cache_read_input_tokens),
		cacheWriteTokens: count(usage?.cache_creation_input_tokens),
		cacheWrite1hTokens: count(usage?.cache_creation?.ephemeral_1h_input_tokens),
	};
}

/** Replace only the fields a message_delta carries, as pi-ai does. */
function applyDelta(usage: TokenUsage, delta: AnthropicUsage): TokenUsage {
	return {
		inputTokens: present(delta.input_tokens) ? count(delta.input_tokens) : usage.inputTokens,
		outputTokens: present(delta.output_tokens) ? count(delta.output_tokens) : usage.outputTokens,
		cacheReadTokens: present(delta.cache_read_input_tokens) ? count(delta.cache_read_input_tokens) : usage.cacheReadTokens,
		cacheWriteTokens: present(delta.cache_creation_input_tokens) ? count(delta.cache_creation_input_tokens) : usage.cacheWriteTokens,
		cacheWrite1hTokens: present(delta.cache_creation?.ephemeral_1h_input_tokens) ? count(delta.cache_creation.ephemeral_1h_input_tokens) : usage.cacheWrite1hTokens,
	};
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };

export interface UsageTap {
	/** Feed the next chunk of the event stream, exactly as it was relayed. */
	push(chunk: Uint8Array): void;
	/** The stream ended or was cut off: read any last event. */
	end(): void;
	/** The usage seen so far, or null when no usage event arrived. */
	readonly usage: TokenUsage | null;
	/** The model the response named, if seen. */
	readonly model: string | undefined;
}

/** Watches a Messages API event stream for usage without changing it. */
export function createUsageTap(): UsageTap {
	const decoder = new TextDecoder();
	let pending = "";
	let usage: TokenUsage | null = null;
	let model: string | undefined;

	function onEvent(block: string): void {
		let event = "";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length === 0 || (event && event !== "message_start" && event !== "message_delta")) return;
		let parsed: { type?: unknown; message?: { model?: unknown; usage?: AnthropicUsage }; usage?: AnthropicUsage };
		try {
			parsed = JSON.parse(data.join("\n")) as typeof parsed;
		} catch {
			return;
		}
		if (parsed.type === "message_start") {
			usage = fromUsage(parsed.message?.usage);
			if (typeof parsed.message?.model === "string") model = parsed.message.model;
		} else if (parsed.type === "message_delta" && parsed.usage) {
			usage = applyDelta(usage ?? ZERO, parsed.usage);
		}
	}

	function drain(final: boolean): void {
		const blocks = pending.replace(/\r\n?/g, "\n").split("\n\n");
		pending = final ? "" : (blocks.pop() ?? "");
		for (const block of blocks) if (block.trim()) onEvent(block);
	}

	return {
		push(chunk) {
			pending += decoder.decode(chunk, { stream: true });
			drain(false);
		},
		end() {
			pending += decoder.decode();
			drain(true);
		},
		get usage() {
			return usage;
		},
		get model() {
			return model;
		},
	};
}

/** Usage and model from a whole (non-streaming) Messages API response body. */
export function usageFromMessage(body: unknown): { usage: TokenUsage | null; model: string | undefined } {
	if (!body || typeof body !== "object") return { usage: null, model: undefined };
	const message = body as { usage?: AnthropicUsage; model?: unknown };
	return {
		usage: message.usage && typeof message.usage === "object" ? fromUsage(message.usage) : null,
		model: typeof message.model === "string" ? message.model : undefined,
	};
}

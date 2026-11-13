/**
 * Checks a pasted Anthropic key with one free call before it is saved
 * (2026-11-13): GET /v1/models, which lists models and costs nothing.
 *
 *   200          ok: Anthropic took the key
 *   401, 403     refused: not a working key
 *   402          no-credit: the key's account cannot pay
 *   anything else, or no answer in time: unreachable (try again later)
 *
 * The key goes in x-api-key only, never in a URL, a log line or an error.
 */

export type KeyCheckResult = "ok" | "refused" | "no-credit" | "unreachable";
export type KeyCheck = (apiKey: string) => Promise<KeyCheckResult>;

const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com";

export function anthropicKeyCheck(options: { baseUrl?: string; timeoutMs?: number } = {}): KeyCheck {
	const base = (options.baseUrl ?? ANTHROPIC_DEFAULT_URL).replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? 10_000;
	return async (apiKey) => {
		let res: Response;
		try {
			res = await fetch(`${base}/v1/models?limit=1`, {
				method: "GET",
				headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			return "unreachable";
		}
		// The body is not needed.
		await res.body?.cancel().catch(() => undefined);
		if (res.ok) return "ok";
		if (res.status === 401 || res.status === 403) return "refused";
		if (res.status === 402) return "no-credit";
		return "unreachable";
	};
}

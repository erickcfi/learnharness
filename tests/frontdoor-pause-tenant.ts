/**
 * A stand-in tenant server for tests/frontdoor-pause-e2e.test.ts. The front
 * door's supervisor starts it as it starts upstream's server, with the
 * tenant's own environment (pass key, meter address). It answers:
 *
 *   GET  /                      "ok" (the supervisor's ready check)
 *   GET  /chat/<id>             a tutor page (HTML)
 *   GET  /api/...               the read-only upstream answers the export uses
 *   POST /api/chats             {"created": true} (a write)
 *   POST /api/wiring/raw-call   one Messages API call through the meter, made
 *                               with the tenant's own variables; answers the
 *                               status and body it got
 *
 * Plain Node runs it (type stripping). A helper, not a test file.
 */
import { createServer } from "node:http";
import { fakeUpstreamAnswers } from "./frontdoor-retention-helpers.ts";

const answers = fakeUpstreamAnswers();

async function rawCall(): Promise<unknown> {
	const res = await fetch(`${process.env.LH_ANTHROPIC_BASE_URL}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "pause test turn" }] }),
	});
	return { status: res.status, body: await res.text() };
}

createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://tenant");
	const json = (status: number, body: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (req.method === "POST" && url.pathname === "/api/wiring/raw-call") {
		rawCall().then(
			(body) => json(200, body),
			(error: unknown) => json(500, { error: (error as Error).message }),
		);
		return;
	}
	if (req.method === "POST" && url.pathname === "/api/chats") return json(200, { created: true });
	if (req.method === "GET" && url.pathname in answers) {
		const v = answers[url.pathname];
		if (typeof v === "string") {
			res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
			res.end(v);
			return;
		}
		return json(200, v);
	}
	if (url.pathname.startsWith("/chat/")) {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<!doctype html><title>tutor</title><p>tutor page</p>");
		return;
	}
	if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
	res.end("ok");
}).listen(Number(process.env.PORT), process.env.HOSTNAME);

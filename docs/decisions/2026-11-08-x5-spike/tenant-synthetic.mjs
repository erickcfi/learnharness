// X5 spike: a stand-in tenant that sends one SSE frame every GAP_MS ms.
// Each frame carries its send time, so a client can measure delay per frame.
// Headers copy upstream's SSE routes (src/server/events-stream.ts).
// /sse?plain=1 leaves out "no-transform", to see whether compression buffers.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4202);
const frames = Number(process.env.FRAMES ?? 25);
const gap = Number(process.env.GAP_MS ?? 200);

createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://x");
	if (url.pathname !== "/sse") {
		res.writeHead(404).end();
		return;
	}
	const cacheControl = url.searchParams.get("plain") === "1" ? "no-cache" : "no-cache, no-transform";
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": cacheControl, "X-Accel-Buffering": "no" });
	let seq = 0;
	const timer = setInterval(() => {
		res.write(`data: ${JSON.stringify({ seq, t: Date.now() })}\n\n`);
		seq += 1;
		if (seq >= frames) {
			clearInterval(timer);
			res.end();
		}
	}, gap);
	req.on("close", () => clearInterval(timer));
}).listen(port, "127.0.0.1");

// X5 spike: read an SSE stream and report how late each frame arrived.
// Usage: node client-sse.mjs <url> <label>
const [url, label] = process.argv.slice(2);
const started = Date.now();
const res = await fetch(url, { headers: { Accept: "text/event-stream", "Accept-Encoding": "gzip, deflate, br" } });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const delays = [];
const arrivals = [];
for (;;) {
	const { value, done } = await reader.read();
	if (done) break;
	const now = Date.now();
	buffer += decoder.decode(value, { stream: true });
	let end;
	while ((end = buffer.indexOf("\n\n")) >= 0) {
		const frame = buffer.slice(0, end);
		buffer = buffer.slice(end + 2);
		const line = frame.split("\n").find((l) => l.startsWith("data: "));
		if (!line) continue;
		const data = JSON.parse(line.slice(6));
		delays.push(now - data.t);
		arrivals.push(now - started);
	}
}
const sorted = [...delays].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? NaN;
console.log(
	JSON.stringify({
		label,
		status: res.status,
		encoding: res.headers.get("content-encoding") ?? "none",
		frames: delays.length,
		medianDelayMs: median,
		maxDelayMs: sorted.at(-1) ?? NaN,
		firstArrivalMs: arrivals[0] ?? NaN,
		lastArrivalMs: arrivals.at(-1) ?? NaN,
	}),
);

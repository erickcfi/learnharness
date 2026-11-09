// X5 spike: open LearnHarness's GET /api/events stream through one path,
// then create a session straight on the tenant (POST /api/chats). Each
// create sends one "chats-changed" frame. Report the time from the create
// call to the frame's arrival.
// Usage: node client-events.mjs <eventsUrl> <tenantOrigin> <count> <label>
const [eventsUrl, tenantOrigin, countArg, label] = process.argv.slice(2);
const count = Number(countArg ?? 10);
const controller = new AbortController();
const res = await fetch(eventsUrl, { headers: { Accept: "text/event-stream", "Accept-Encoding": "gzip, deflate, br" }, signal: controller.signal });
const arrivals = [];
let wake = () => {};
const reading = (async () => {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const now = Date.now();
			buffer += decoder.decode(value, { stream: true });
			let end;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (frame.includes("event: chats-changed")) {
					arrivals.push(now);
					wake();
				}
			}
		}
	} catch {
		// aborted at the end of the run
	}
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);
const delays = [];
for (let i = 0; i < count; i++) {
	const before = arrivals.length;
	const sent = Date.now();
	const arrived = new Promise((resolve) => {
		wake = () => {
			if (arrivals.length > before) resolve(arrivals[before]);
		};
	});
	await fetch(`${tenantOrigin}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: `x5 spike ${i}` }) });
	const at = await Promise.race([arrived, sleep(5000).then(() => NaN)]);
	delays.push(at - sent);
	await sleep(250);
}
controller.abort();
await reading;
const sorted = [...delays].sort((a, b) => a - b);
console.log(JSON.stringify({ label, status: res.status, encoding: res.headers.get("content-encoding") ?? "none", frames: delays.filter(Number.isFinite).length, of: count, medianDelayMs: sorted[Math.floor(sorted.length / 2)], maxDelayMs: sorted.at(-1) }));

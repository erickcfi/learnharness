// X5 spike: the front door's custom Node server (Next.js custom-server guide).
// /t/<port>/<path> is piped to the tenant on 127.0.0.1:<port> with node:http.
// Every other path goes to the front door's own Next.js app, which holds two
// more pass-through methods for comparison: /rh (route handler) and /px (proxy.js).
import { createServer, request as httpRequest } from "node:http";
import next from "next";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
const strip = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())));

function passThrough(req, res, port, path) {
	const upstream = httpRequest({ host: "127.0.0.1", port, method: req.method, path, headers: { ...strip(req.headers), host: `127.0.0.1:${port}` } }, (tenantRes) => {
		res.writeHead(tenantRes.statusCode ?? 502, strip(tenantRes.headers));
		tenantRes.pipe(res);
	});
	upstream.on("error", () => {
		if (!res.headersSent) res.writeHead(502);
		res.end();
	});
	res.on("close", () => upstream.destroy());
	req.pipe(upstream);
}

const port = Number(process.env.PORT ?? 4100);
const app = next({ dev: false, dir: import.meta.dirname });
const handle = app.getRequestHandler();
await app.prepare();
createServer((req, res) => {
	const m = /^\/t\/(\d+)(\/.*)$/.exec(req.url ?? "");
	if (m) return passThrough(req, res, Number(m[1]), m[2]);
	return handle(req, res);
}).listen(port, "127.0.0.1", () => console.log(`front door spike on ${port}`));

// X5 spike, method "rh": a Next.js route handler that fetches the tenant
// and returns its body as a stream. Path: /rh/<port>/<path>.
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
	const { path } = await params;
	const [port, ...rest] = path;
	const search = new URL(request.url).search;
	const upstream = await fetch(`http://127.0.0.1:${port}/${rest.join("/")}${search}`, {
		headers: { accept: request.headers.get("accept") ?? "*/*" },
		signal: request.signal,
		cache: "no-store",
	});
	const headers = new Headers(upstream.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(upstream.body, { status: upstream.status, headers });
}

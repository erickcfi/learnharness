/**
 * W2-6 wall B (PRD C1 req 4, master decision 2026-11-08): in hosted mode the
 * tutor's web tools refuse this machine and private networks, after the name
 * lookup and on every redirect. Outside hosted mode, plain fetch().
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { BLOCKED_ADDRESS_MESSAGE, BlockedAddressError, guardedFetch, isBlockedAddress, safeFetch } from "../frontdoor/isolation/safe-fetch.ts";

const BLOCKED = [
	"127.0.0.1", "127.255.255.254", "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "169.254.169.254", "169.254.0.1",
	"172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.2.5", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.1.1.1",
	"240.0.0.1", "255.255.255.255",
	"::1", "::", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:10.0.0.1", "::127.0.0.1",
	"64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1",
	"fc00::1", "fd12:3456::1", "fd00:ec2::254", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "2001:db8::1", "100::1", "2001::1",
	"not-an-address", "",
];
const ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"];

describe("address ranges", () => {
	it("blocks loopback, private, link-local, metadata, unique-local, multicast, reserved and documentation addresses", () => {
		const missed = BLOCKED.filter((a) => !isBlockedAddress(a));
		assert.deepEqual(missed, []);
	});

	it("allows public addresses, also when written inside IPv6", () => {
		const wrong = ALLOWED.filter((a) => isBlockedAddress(a));
		assert.deepEqual(wrong, []);
	});
});

let local: Server;
let localUrl = "";
const localHits: string[] = [];
let redirectTarget = "";

before(async () => {
	local = createServer((req, res) => {
		localHits.push(req.url ?? "");
		if (req.url === "/gz") {
			res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
			return res.end(gzipSync(Buffer.from("hello compressed world")));
		}
		if (req.url === "/redirect") {
			res.writeHead(302, { Location: redirectTarget });
			return res.end();
		}
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("local secret page");
	});
	await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
	localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise((r) => local.close(r));
});

afterEach(() => {
	localHits.length = 0;
	delete process.env.LH_HOSTED;
});

const port = () => (local.address() as AddressInfo).port;

describe("the guarded fetch", () => {
	it("refuses a loopback URL without connecting", async () => {
		await assert.rejects(guardedFetch(`${localUrl}/`), BlockedAddressError);
		assert.equal(localHits.length, 0);
	});

	it("refuses every way of writing a private address in a URL", async () => {
		for (const url of [
			`http://localhost:${port()}/`,
			`http://[::1]:${port()}/`,
			`http://[::ffff:127.0.0.1]:${port()}/`,
			`http://2130706433:${port()}/`,
			`http://0x7f000001:${port()}/`,
			`http://127.1:${port()}/`,
			`http://0:${port()}/`,
			"http://169.254.169.254/latest/meta-data/",
			"http://[fd00:ec2::254]/latest/meta-data/",
			"http://metadata.google.internal/computeMetadata/v1/",
		]) {
			await assert.rejects(guardedFetch(url, {}, { lookup: async (h) => (h === "metadata.google.internal" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]) }), BlockedAddressError, url);
		}
		assert.equal(localHits.length, 0);
	});

	it("checks the address the name resolves to, and refuses when any address is private", async () => {
		const looked: string[] = [];
		const lookup = async (host: string) => {
			looked.push(host);
			return [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
		};
		await assert.rejects(guardedFetch(`http://public-looking.example:${port()}/`, {}, { lookup }), BlockedAddressError);
		assert.deepEqual(looked, ["public-looking.example"]);
		assert.equal(localHits.length, 0);
	});

	it("connects only to the address it checked (no second lookup)", async () => {
		let calls = 0;
		const lookup = async () => {
			calls++;
			return [{ address: "127.0.0.1", family: 4 }];
		};
		// For this test 127.0.0.1 counts as public; the name is looked up once.
		const res = await guardedFetch(`http://pinned.example:${port()}/page`, {}, { lookup, isBlocked: () => false });
		assert.equal(await res.text(), "local secret page");
		assert.equal(calls, 1);
	});

	it("checks every redirect hop, by address and by name", async () => {
		const onlyLocalAllowed = (a: string) => a !== "127.0.0.1";
		redirectTarget = "http://169.254.169.254/latest/meta-data/";
		await assert.rejects(guardedFetch(`${localUrl}/redirect`, {}, { isBlocked: onlyLocalAllowed }), BlockedAddressError);
		redirectTarget = "http://inner.example/admin";
		await assert.rejects(guardedFetch(`${localUrl}/redirect`, {}, { isBlocked: onlyLocalAllowed, lookup: async () => [{ address: "10.0.0.5", family: 4 }] }), BlockedAddressError);
		assert.deepEqual(localHits, ["/redirect", "/redirect"]);
	});

	it("follows an allowed redirect, and reports the final URL", async () => {
		redirectTarget = "/final";
		const res = await guardedFetch(`${localUrl}/redirect`, {}, { isBlocked: () => false });
		assert.equal(res.status, 200);
		assert.equal(res.redirected, true);
		assert.equal(res.url, `${localUrl}/final`);
		assert.equal(await res.text(), "local secret page");
	});

	it("stops after too many redirects", async () => {
		redirectTarget = "/redirect";
		await assert.rejects(guardedFetch(`${localUrl}/redirect`, {}, { isBlocked: () => false, maxRedirects: 3 }), /Too many redirects/);
		assert.equal(localHits.length, 4);
	});

	it("decodes a gzip body like fetch()", async () => {
		const res = await guardedFetch(`${localUrl}/gz`, {}, { isBlocked: () => false });
		assert.equal(await res.text(), "hello compressed world");
	});

	it("sends GET and HEAD only, with no body", async () => {
		await assert.rejects(guardedFetch(`${localUrl}/`, { method: "POST" }, { isBlocked: () => false }), /GET and HEAD only/);
		await assert.rejects(guardedFetch("ftp://example.com/x"), /Only http/);
		await assert.rejects(guardedFetch("http://user:pass@example.com/"), /user name or password/);
	});
});

describe("safeFetch: hosted mode only", () => {
	it("outside hosted mode it is plain fetch(), so upstream's desktop runs and tests are unchanged", async () => {
		const res = await safeFetch(`${localUrl}/`);
		assert.equal(await res.text(), "local secret page");
	});

	it("in hosted mode it refuses this machine", async () => {
		process.env.LH_HOSTED = "1";
		await assert.rejects(safeFetch(`${localUrl}/`), BlockedAddressError);
		assert.equal(localHits.length, 0);
	});
});

describe("the tutor's real web tools in hosted mode", () => {
	const outputOf = (result: unknown) => JSON.stringify(result);

	it("web_fetch refuses another tenant's port, the meter's port, localhost and the metadata address", async () => {
		process.env.LH_HOSTED = "1";
		const { createWebTools } = await import("../src/agent/tools/web.ts");
		const tools = createWebTools(() => null);
		for (const url of [`${localUrl}/api/chats`, `http://localhost:${port()}/`, `http://[::1]:${port()}/`, "http://169.254.169.254/latest/meta-data/iam/"]) {
			const out = outputOf(await tools.web_fetch!.execute!("t1", { url }));
			assert.match(out, /web_fetch failed/, url);
			assert.ok(out.includes(BLOCKED_ADDRESS_MESSAGE), url);
		}
		assert.equal(localHits.length, 0);
	});

	it("web_fetch_pdf refuses them too", async () => {
		process.env.LH_HOSTED = "1";
		const { createPdfReadTools } = await import("../src/agent/tools/pdf-read.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-guard-"));
		try {
			const tools = createPdfReadTools(dir);
			for (const url of [`${localUrl}/doc.pdf`, "http://169.254.169.254/latest/doc.pdf"]) {
				const out = outputOf(await tools.web_fetch_pdf!.execute!("t2", { url }));
				assert.match(out, /web_fetch_pdf failed/, url);
				assert.ok(out.includes(BLOCKED_ADDRESS_MESSAGE), url);
			}
			assert.equal(localHits.length, 0);
			assert.deepEqual(fs.readdirSync(dir), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Wall B (W2-6, PRD C1 req 4, master decision 2026-11-08): the tutor's web
 * tools may not reach this machine or a private network.
 *
 * In hosted mode (LH_HOSTED=1, set by the front door for every tenant
 * server), safeFetch() refuses loopback, private-network, carrier-grade NAT,
 * link-local (which holds cloud metadata, 169.254.169.254), unique-local
 * (Railway's private network is fd12::/16), multicast, reserved and
 * documentation addresses. So a tenant's agent cannot reach another
 * tenant's server, the meter, or a metadata service.
 *
 * The check runs on the address the connection really uses: the name is
 * looked up once, every address it gives is checked, and the socket then
 * connects only to those checked addresses (no second lookup that a DNS
 * trick could answer differently). Redirects are followed by hand, and
 * every hop is checked the same way.
 *
 * With LH_HOSTED unset, safeFetch() is plain fetch(), so upstream's desktop
 * behavior and upstream's tests are unchanged.
 *
 * Used by upstream src/agent/tools/web.ts (web_fetch) and
 * src/agent/tools/pdf-read.ts (web_fetch_pdf). GET and HEAD only, which is
 * all they send.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";

export const BLOCKED_ADDRESS_MESSAGE = "This address is not allowed: it is on this server or a private network.";

export class BlockedAddressError extends Error {
	constructor(readonly address: string) {
		super(BLOCKED_ADDRESS_MESSAGE);
		this.name = "BlockedAddressError";
	}
}

export function fetchGuardOn(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	return env.LH_HOSTED === "1";
}

// ── address ranges ─────────────────────────────────────────────────────────

function parseIPv4(text: string): number | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		value = value * 256 + n;
	}
	return value;
}

function parseIPv6(text: string): bigint | null {
	let rest = text.toLowerCase();
	const zone = rest.indexOf("%");
	if (zone >= 0) rest = rest.slice(0, zone);
	let tail: number[] = [];
	const lastColon = rest.lastIndexOf(":");
	if (lastColon < 0) return null;
	const last = rest.slice(lastColon + 1);
	if (last.includes(".")) {
		// A dotted IPv4 tail ("::ffff:127.0.0.1") is the last two groups.
		const v4 = parseIPv4(last);
		if (v4 === null) return null;
		tail = [Math.floor(v4 / 65536), v4 % 65536];
		rest = rest.slice(0, lastColon + 1);
		if (!rest.endsWith("::")) rest = rest.slice(0, -1);
	}
	const halves = rest.split("::");
	if (halves.length > 2) return null;
	const read = (half: string) => (half === "" ? [] : half.split(":"));
	const head = read(halves[0] ?? "");
	const back = halves.length === 2 ? read(halves[1] ?? "") : [];
	const groups = [...head, ...back];
	if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	const missing = 8 - groups.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const words = [...head.map((g) => parseInt(g, 16)), ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...back.map((g) => parseInt(g, 16)), ...tail];
	if (words.length !== 8) return null;
	return words.reduce((acc, w) => (acc << 16n) | BigInt(w), 0n);
}

const V4_BLOCKED: ReadonlyArray<[string, number]> = [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, broadcast
];

const V6_BLOCKED: ReadonlyArray<[string, number]> = [
	["::", 128], // unspecified
	["::1", 128], // loopback
	["100::", 64], // discard
	["2001::", 32], // Teredo
	["2001:10::", 28], // ORCHID
	["2001:20::", 28], // ORCHIDv2
	["2001:db8::", 32], // documentation
	["3fff::", 20], // documentation
	["fc00::", 7], // unique local (Railway private network, AWS metadata fd00:ec2::254)
	["fe80::", 10], // link-local
	["fec0::", 10], // site-local
	["ff00::", 8], // multicast
];

const v4Ranges = V4_BLOCKED.map(([base, bits]) => ({ base: parseIPv4(base) ?? 0, bits }));
const v6Ranges = V6_BLOCKED.map(([base, bits]) => ({ base: parseIPv6(base) ?? 0n, bits }));

const inV4 = (value: number, base: number, bits: number) => bits === 0 || Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
const inV6 = (value: bigint, base: bigint, bits: number) => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));

function blockedV4(value: number): boolean {
	return v4Ranges.some((r) => inV4(value, r.base, r.bits));
}

function blockedV6(value: bigint): boolean {
	if (v6Ranges.some((r) => inV6(value, r.base, r.bits))) return true;
	const low32 = Number(value & 0xffffffffn);
	// IPv4 inside IPv6: mapped (::ffff:0:0/96), compatible (::/96), NAT64
	// (64:ff9b::/96 and 64:ff9b:1::/48), and 6to4 (2002::/16).
	if (value >> 32n === 0xffffn || value >> 32n === 0n) return blockedV4(low32);
	if (value >> 32n === 0x0064ff9b0000000000000000n || value >> 80n === 0x0064ff9b0001n) return blockedV4(low32);
	if (value >> 112n === 0x2002n) return blockedV4(Number((value >> 80n) & 0xffffffffn));
	return false;
}

/** True when an address (IPv4 or IPv6 text, brackets allowed) must not be reached. Unreadable text counts as blocked. */
export function isBlockedAddress(address: string): boolean {
	const text = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
	const family = isIP(text.split("%")[0] ?? "");
	if (family === 4) {
		const v4 = parseIPv4(text);
		return v4 === null || blockedV4(v4);
	}
	if (family === 6) {
		const v6 = parseIPv6(text);
		return v6 === null || blockedV6(v6);
	}
	return true;
}

// ── the guarded fetch ──────────────────────────────────────────────────────

export interface ResolvedAddress {
	address: string;
	family: number;
}

export interface GuardOptions {
	/** Name lookup (tests). Default: the system resolver, every address. */
	lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
	/** Default 10. */
	maxRedirects?: number;
	/** Tests only: which addresses count as blocked. Default isBlockedAddress. */
	isBlocked?: (address: string) => boolean;
}

const systemLookup = async (hostname: string): Promise<ResolvedAddress[]> => dnsLookup(hostname, { all: true });

/** Every address a URL's host may connect to, all checked. Throws BlockedAddressError. */
export async function checkedAddresses(url: URL, lookup: GuardOptions["lookup"] = systemLookup, isBlocked: (address: string) => boolean = isBlockedAddress): Promise<ResolvedAddress[]> {
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	const literal = isIP(host);
	const addresses = literal ? [{ address: host, family: literal }] : await lookup(host);
	if (addresses.length === 0) throw new Error(`No address for ${host}`);
	for (const { address } of addresses) if (isBlocked(address)) throw new BlockedAddressError(address);
	return addresses;
}

/** A lookup that answers only the addresses already checked. */
function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
	return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
		const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
		const first = addresses[0] as ResolvedAddress;
		if (all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
		else callback(null, first.address, first.family);
	}) as LookupFunction;
}

function plainHeaders(init: HeadersInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	new Headers(init).forEach((value, name) => {
		out[name] = value;
	});
	if (!out["accept-encoding"]) out["accept-encoding"] = "gzip, deflate, br";
	return out;
}

function requestOnce(url: URL, method: string, headers: Record<string, string>, addresses: ResolvedAddress[], signal: AbortSignal | undefined): Promise<http.IncomingMessage> {
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const req = transport.request(
			{
				protocol: url.protocol,
				hostname: host,
				port: url.port || undefined,
				path: `${url.pathname}${url.search}`,
				method,
				headers,
				agent: false,
				lookup: pinnedLookup(addresses),
				...(signal ? { signal } : {}),
			},
			resolve,
		);
		req.on("error", reject);
		req.end();
	});
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function toResponse(res: http.IncomingMessage, url: URL, method: string, redirected: boolean): Response {
	const headers = new Headers();
	const raw = res.rawHeaders;
	for (let i = 0; i + 1 < raw.length; i += 2) {
		try {
			headers.append(raw[i] as string, raw[i + 1] as string);
		} catch {
			/* a header fetch() would also drop */
		}
	}
	const status = res.statusCode ?? 502;
	let body: Readable | null = res;
	if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
		res.resume();
		body = null;
	} else {
		const encoding = (res.headers["content-encoding"] ?? "").toString().trim().toLowerCase();
		const decoder = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;
		if (decoder) {
			res.on("error", (error) => decoder.destroy(error));
			body = res.pipe(decoder);
		}
	}
	const response = new Response(body ? (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>) : null, { status, statusText: res.statusMessage ?? "", headers });
	Object.defineProperty(response, "url", { value: url.toString() });
	Object.defineProperty(response, "redirected", { value: redirected });
	return response;
}

/** fetch() for GET and HEAD that refuses private addresses on every hop. */
export async function guardedFetch(input: string | URL, init: RequestInit = {}, options: GuardOptions = {}): Promise<Response> {
	const method = (init.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") throw new Error("The guarded fetch sends GET and HEAD only.");
	if (init.body != null) throw new Error("The guarded fetch sends no body.");
	const headers = plainHeaders(init.headers);
	const maxRedirects = options.maxRedirects ?? 10;
	let url = new URL(input);
	for (let hop = 0; ; hop++) {
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
		if (url.username || url.password) throw new Error("URLs with a user name or password are not supported");
		const addresses = await checkedAddresses(url, options.lookup, options.isBlocked);
		const res = await requestOnce(url, method, headers, addresses, init.signal ?? undefined);
		const location = res.headers.location;
		if (REDIRECTS.has(res.statusCode ?? 0) && location && init.redirect !== "manual") {
			res.resume();
			if (init.redirect === "error") throw new Error("Redirect refused");
			if (hop >= maxRedirects) throw new Error("Too many redirects");
			url = new URL(location, url);
			continue;
		}
		return toResponse(res, url, method, hop > 0);
	}
}

/** fetch() in desktop mode; the guarded fetch in hosted mode (LH_HOSTED=1). */
export function safeFetch(input: string | URL, init: RequestInit = {}, options: GuardOptions = {}): Promise<Response> {
	if (!fetchGuardOn()) return fetch(input, init);
	return guardedFetch(input, init, options);
}

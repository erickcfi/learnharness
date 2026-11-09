/**
 * A small zip writer for the student's data export (P1-08, C1 req 6).
 * Deflate from node:zlib, CRC-32 from node:zlib, UTF-8 file names, no
 * dependency. Classic zip only (no ZIP64): the whole archive stays under
 * 4 GB and 65,535 files, far above one student's data; past that it throws.
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
	/** A relative path with forward slashes, for example "sessions/2026-11-08-metar.md". */
	name: string;
	data: Buffer | string;
	/** Defaults to the time the zip is made. */
	modified?: Date;
}

const LIMIT = 0xffffffff;
const UTF8_FLAG = 0x0800;

function assertSafeName(name: string): void {
	if (!name || name.length > 400) throw new Error("A zip entry needs a name of 1 to 400 characters.");
	if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) throw new Error(`Unsafe zip entry name: ${JSON.stringify(name).slice(0, 80)}`);
	if (name.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`Unsafe zip entry name: ${JSON.stringify(name).slice(0, 80)}`);
}

/** DOS date and time, in UTC, as zip stores them (2-second steps, 1980 to 2107). */
function dosDateTime(date: Date): { time: number; day: number } {
	const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
	return {
		time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
		day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
	};
}

export function createZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
	if (entries.length > 0xffff) throw new Error("Too many files for one zip.");
	const seen = new Set<string>();
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		assertSafeName(entry.name);
		if (seen.has(entry.name)) throw new Error(`Two zip entries share the name ${JSON.stringify(entry.name).slice(0, 80)}`);
		seen.add(entry.name);
		const name = Buffer.from(entry.name, "utf8");
		const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
		const deflated = deflateRawSync(data);
		// Keep a file as it is when deflate would not make it smaller.
		const stored = deflated.length >= data.length;
		const body = stored ? data : deflated;
		const crc = crc32(data);
		const { time, day } = dosDateTime(entry.modified ?? now);
		if (data.length > LIMIT || offset > LIMIT) throw new Error("The export is too large for a zip without ZIP64.");

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(UTF8_FLAG, 6);
		local.writeUInt16LE(stored ? 0 : 8, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(day, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(UTF8_FLAG, 8);
		central.writeUInt16LE(stored ? 0 : 8, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(day, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + body.length;
	}

	const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
	if (offset + centralSize > LIMIT) throw new Error("The export is too large for a zip without ZIP64.");
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}

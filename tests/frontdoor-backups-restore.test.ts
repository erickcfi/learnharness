/**
 * P1-09 (X3): the nightly tenant copies and the restore of one tenant
 * folder. X3's done criterion: a restore of one tenant folder from backup
 * works. Here a tenant folder is copied, damaged, then restored from the
 * copy into a scratch folder and into the live volume, and checked file by
 * file.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { hashTree } from "../frontdoor/backups/manifest.ts";
import { copyTenantsNightly, nightlyDir } from "../frontdoor/backups/nightly.ts";
import { findTenantServerPids, restoreTenantFolder } from "../frontdoor/backups/restore.ts";
import { tenantDir } from "../frontdoor/tenants/paths.ts";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-backups-"));
after(() => fs.rmSync(work, { recursive: true, force: true }));

let k = 0;
/** A volume with two tenants (nested folders, a binary file) and a library. */
function makeVolume(): string {
	const volume = path.join(work, `vol-${++k}`);
	for (const id of [A, B]) {
		const dir = tenantDir(volume, id);
		fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
		fs.mkdirSync(path.join(dir, "graph"), { recursive: true });
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 1, tenant: id }));
		fs.writeFileSync(path.join(dir, "chats", "chat_1.json"), JSON.stringify({ title: `METAR for ${id}` }));
		fs.writeFileSync(path.join(dir, "graph", "nodes.jsonl"), '{"id":"n1"}\n{"id":"n2"}\n');
		fs.writeFileSync(path.join(dir, "graph", "blob.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 10]));
	}
	fs.mkdirSync(path.join(volume, "library", "faa"), { recursive: true });
	fs.writeFileSync(path.join(volume, "library", "faa", "phak.pdf"), "pdf");
	return volume;
}

const at = (iso: string) => new Date(iso);

describe("nightly tenant copies", () => {
	it("waits for the copy hour, copies every tenant with a manifest, skips the library, and is safe to repeat", async () => {
		const volume = makeVolume();
		fs.mkdirSync(path.join(volume, "tenants", "not-a-tenant"));
		const early = await copyTenantsNightly({ volumeDir: volume, now: at("2026-11-08T09:59:00Z"), log: () => {} });
		assert.equal(early.night, null, "before 10:00 UTC nothing happens");

		const first = await copyTenantsNightly({ volumeDir: volume, now: at("2026-11-08T10:05:00Z"), log: () => {} });
		assert.deepEqual(first, { night: "2026-11-08", copied: 2, skipped: 0, failed: 0, pruned: 0 });
		const night = path.join(nightlyDir(volume), "2026-11-08");
		assert.deepEqual(fs.readdirSync(night).sort(), [A, `${A}.manifest.json`, B, `${B}.manifest.json`].sort());
		assert.deepEqual(await hashTree(path.join(night, A)), await hashTree(tenantDir(volume, A)), "the copy matches the folder");
		const manifest = JSON.parse(fs.readFileSync(path.join(night, `${A}.manifest.json`), "utf8"));
		assert.equal(manifest.tenantId, A);
		assert.equal(manifest.files.length, 4);
		assert.equal(fs.statSync(path.join(night, A, "settings.json")).mode & 0o777, 0o600);

		const again = await copyTenantsNightly({ volumeDir: volume, now: at("2026-11-08T11:05:00Z"), log: () => {} });
		assert.deepEqual(again, { night: "2026-11-08", copied: 0, skipped: 2, failed: 0, pruned: 0 });
	});

	it("keeps the newest 7 nights", async () => {
		const volume = makeVolume();
		for (let d = 1; d <= 9; d++) {
			await copyTenantsNightly({ volumeDir: volume, now: at(`2026-11-0${d}T10:00:00Z`), log: () => {} });
		}
		const nights = fs.readdirSync(nightlyDir(volume)).sort();
		assert.deepEqual(nights, ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
	});
});

describe("restore one tenant folder (X3 done criterion)", () => {
	async function damagedVolumeWithBackup() {
		const volume = makeVolume();
		const original = await hashTree(tenantDir(volume, A));
		const otherBefore = await hashTree(tenantDir(volume, B));
		await copyTenantsNightly({ volumeDir: volume, now: at("2026-11-07T10:00:00Z"), log: () => {} });
		const backupDir = path.join(nightlyDir(volume), "2026-11-07");
		// The damage: a chat is lost and a ledger is cut short.
		fs.rmSync(path.join(tenantDir(volume, A), "chats", "chat_1.json"));
		fs.writeFileSync(path.join(tenantDir(volume, A), "graph", "nodes.jsonl"), '{"id":"n1"}\n{"id');
		fs.writeFileSync(path.join(tenantDir(volume, A), "new-after-backup.json"), "{}");
		return { volume, backupDir, original, otherBefore };
	}

	it("restores into a scratch folder and checks it, touching nothing live", async () => {
		const { volume, backupDir, original } = await damagedVolumeWithBackup();
		const liveBefore = await hashTree(tenantDir(volume, A));
		const scratch = path.join(work, `scratch-${++k}`);
		const result = await restoreTenantFolder({ backupDir, tenantId: A, target: { kind: "scratch", dir: scratch } });
		assert.equal(result.restoredTo, path.join(scratch, A));
		assert.equal(result.files, 4);
		assert.equal(result.manifestChecked, true);
		assert.equal(result.keptAside, null);
		assert.deepEqual(await hashTree(path.join(scratch, A)), original, "the scratch copy is the folder as it was backed up");
		assert.deepEqual(await hashTree(tenantDir(volume, A)), liveBefore, "the live folder is untouched");
		assert.deepEqual(fs.readdirSync(scratch), [A], "no staging folder is left behind");
		await assert.rejects(restoreTenantFolder({ backupDir, tenantId: A, target: { kind: "scratch", dir: scratch } }), /already exists/);
	});

	it("restores into the live volume: the damaged folder is kept aside, the server is stopped, other tenants are untouched", async () => {
		const { volume, backupDir, original, otherBefore } = await damagedVolumeWithBackup();
		const damaged = await hashTree(tenantDir(volume, A));
		const stopped: string[] = [];
		const result = await restoreTenantFolder({
			backupDir,
			tenantId: A,
			target: { kind: "live", volumeDir: volume },
			stopTenant: async (id) => {
				stopped.push(id);
				assert.ok(fs.existsSync(path.join(tenantDir(volume, A), "chats", "chat_1.json")), "stopped after the swap");
			},
			now: at("2026-11-08T15:00:00Z"),
		});
		assert.deepEqual(await hashTree(tenantDir(volume, A)), original);
		assert.equal(fs.statSync(tenantDir(volume, A)).mode & 0o777, 0o700);
		assert.equal(result.keptAside, path.join(path.resolve(volume), "restore-kept", `${A}-20261108T150000Z`));
		assert.deepEqual(await hashTree(result.keptAside!), damaged, "the replaced folder is kept, not deleted");
		assert.deepEqual(stopped, [A]);
		assert.deepEqual(await hashTree(tenantDir(volume, B)), otherBefore);
		assert.deepEqual(fs.readdirSync(path.join(volume, "tenants")).sort(), [A, B].sort(), "no staging folder is left in tenants/");
	});

	it("restores from a whole-volume copy (tenants/<id>), for example one downloaded from a Railway backup", async () => {
		const copy = makeVolume();
		const scratch = path.join(work, `scratch-${++k}`);
		const result = await restoreTenantFolder({ backupDir: copy, tenantId: B, target: { kind: "scratch", dir: scratch } });
		assert.equal(result.manifestChecked, false);
		assert.deepEqual(await hashTree(path.join(scratch, B)), await hashTree(tenantDir(copy, B)));
	});

	it("refuses a backup that does not match its manifest, one with a symlink, a bad id, and a missing tenant", async () => {
		const { backupDir } = await damagedVolumeWithBackup();
		fs.appendFileSync(path.join(backupDir, A, "settings.json"), " ");
		await assert.rejects(restoreTenantFolder({ backupDir, tenantId: A, target: { kind: "scratch", dir: path.join(work, `s-${++k}`) } }), /does not match its manifest/);

		const copy = makeVolume();
		fs.symlinkSync("/etc/passwd", path.join(tenantDir(copy, B), "chats", "link"));
		await assert.rejects(restoreTenantFolder({ backupDir: copy, tenantId: B, target: { kind: "scratch", dir: path.join(work, `s-${++k}`) } }), /symlinks/);

		await assert.rejects(restoreTenantFolder({ backupDir: copy, tenantId: "../etc", target: { kind: "scratch", dir: work } }), /tenant id/);
		await assert.rejects(
			restoreTenantFolder({ backupDir: copy, tenantId: "cccccccc-3333-4333-8333-333333333333", target: { kind: "scratch", dir: work } }),
			/No folder for tenant/,
		);
	});
});

describe("the restore script", () => {
	const SCRIPT = path.join(import.meta.dirname, "..", "frontdoor", "backups", "restore-tenant.ts");

	it("runs with plain Node: a scratch restore prints counts and exits 0; wrong arguments exit 2", () => {
		const volume = makeVolume();
		const scratch = path.join(work, `cli-${++k}`);
		const ok = spawnSync(process.execPath, [SCRIPT, "--tenant", A, "--from", volume, "--scratch", scratch], { encoding: "utf8" });
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, /Restored 4 files/);
		assert.ok(fs.existsSync(path.join(scratch, A, "settings.json")));
		const bad = spawnSync(process.execPath, [SCRIPT, "--tenant", A, "--from", volume], { encoding: "utf8" });
		assert.equal(bad.status, 2);
		const fail = spawnSync(process.execPath, [SCRIPT, "--tenant", "nope", "--from", volume, "--scratch", scratch], { encoding: "utf8" });
		assert.equal(fail.status, 1);
		assert.match(fail.stdout, /Restore failed/);
	});

	it("a live restore stops the tutor server running on that folder", { skip: process.platform !== "linux" }, async () => {
		const volume = makeVolume();
		await copyTenantsNightly({ volumeDir: volume, now: at("2026-11-07T10:00:00Z"), log: () => {} });
		const folder = tenantDir(volume, A);
		const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, LH_DATA_DIR: folder }, stdio: "ignore" });
		const exited = new Promise<NodeJS.Signals | null>((resolve) => server.once("exit", (_code, signal) => resolve(signal)));
		await new Promise((r) => setTimeout(r, 200));
		assert.deepEqual(findTenantServerPids(folder), [server.pid]);
		const run = spawnSync(process.execPath, [SCRIPT, "--tenant", A, "--from", path.join(nightlyDir(volume), "2026-11-07"), "--live", "--volume", volume], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.match(run.stdout, /Stopped 1 running tutor server/);
		assert.match(run.stdout, /kept at/);
		assert.equal(await exited, "SIGTERM");
	});
});

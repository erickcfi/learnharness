/**
 * Tenant provisioning (PRD C1 req 2, C3 req 3 settings sync at create time).
 *
 * A new tenant gets <volume>/tenants/<tenantId>/ and a settings.json holding
 * the Owner's template: Strong = claude-opus-5-5 at high thinking, Cheap and
 * Vision = claude-sonnet-5-5 (Owner, 2026-11-08, until T7). The File access
 * section comes from a plug-in provider that w1-lockdown supplies (C5).
 * Upstream's own settings parser must accept what we write.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { CURRENT_SETTINGS_VERSION, sanitizeUserSettings } from "../src/core/settings.ts";
import { tenantAuthFile, tenantDir } from "../frontdoor/tenants/paths.ts";
import { provisionTenant } from "../frontdoor/tenants/provisioning.ts";
import { OWNER_MODELS, SETTINGS_VERSION, type FileAccessProvider } from "../frontdoor/tenants/settings-template.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-provision-"));
const volume = path.join(work, "volume");
after(() => fs.rmSync(work, { recursive: true, force: true }));

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("tenant provisioning", () => {
	it("creates the tenant folder at <volume>/tenants/<tenantId>/", () => {
		const result = provisionTenant({ volumeDir: volume, tenantId: ID_A });
		assert.equal(result.created, true);
		assert.equal(result.tenantDir, path.join(volume, "tenants", ID_A));
		assert.equal(tenantDir(volume, ID_A), result.tenantDir);
		assert.ok(fs.statSync(result.tenantDir).isDirectory());
		assert.equal(fs.statSync(result.tenantDir).mode & 0o777, 0o700);
	});

	it("writes the Owner's model template, and upstream's parser keeps it", () => {
		const file = path.join(tenantDir(volume, ID_A), "settings.json");
		const parsed = sanitizeUserSettings(readJson(file));
		assert.ok(parsed, "upstream accepts the file");
		assert.equal(parsed.version, CURRENT_SETTINGS_VERSION);
		assert.deepEqual(parsed.models, {
			strong: { model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" },
			cheap: { model: { provider: "anthropic", id: "claude-sonnet-5-5" } },
			vision: { model: { provider: "anthropic", id: "claude-sonnet-5-5" } },
		});
		assert.deepEqual(parsed.models, OWNER_MODELS);
		assert.equal(SETTINGS_VERSION, CURRENT_SETTINGS_VERSION);
	});

	it("leaves File access out until w1-lockdown plugs in its provider", () => {
		const settings = readJson(path.join(tenantDir(volume, ID_A), "settings.json")) as { agent?: { fileAccess?: unknown } };
		assert.equal(settings.agent?.fileAccess, undefined);
	});

	it("writes the File access section a provider returns, and upstream keeps it", () => {
		const library = path.join(volume, "library");
		const provider: FileAccessProvider = ({ volumeDir, tenantDir: dir }) => {
			assert.equal(volumeDir, volume);
			assert.equal(dir, tenantDir(volume, ID_B));
			return { restricted: true, folders: [library] };
		};
		provisionTenant({ volumeDir: volume, tenantId: ID_B, fileAccess: provider });
		const parsed = sanitizeUserSettings(readJson(path.join(tenantDir(volume, ID_B), "settings.json")));
		assert.deepEqual(parsed?.agent?.fileAccess, { restricted: true, folders: [library] });
	});

	it("creates an empty key file outside the tenant folder, readable by the server only", () => {
		const file = tenantAuthFile(volume, ID_A);
		assert.equal(file, path.join(volume, "auth", `${ID_A}.json`));
		assert.ok(!file.startsWith(tenantDir(volume, ID_A) + path.sep));
		assert.deepEqual(readJson(file), {});
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it("is safe to run again: keeps the student's own settings, rewrites the template parts", () => {
		const file = path.join(tenantDir(volume, ID_C), "settings.json");
		provisionTenant({ volumeDir: volume, tenantId: ID_C });
		const student = readJson(file);
		student.appearance = { theme: "dark" };
		student.models = { strong: { model: { provider: "anthropic", id: "claude-haiku-5-5" } } };
		fs.writeFileSync(file, JSON.stringify(student));
		fs.writeFileSync(tenantAuthFile(volume, ID_C), JSON.stringify({ SOME_KEY: "kept" }));

		const again = provisionTenant({ volumeDir: volume, tenantId: ID_C });
		assert.equal(again.created, false);
		const after = readJson(file);
		assert.deepEqual(after.appearance, { theme: "dark" });
		assert.deepEqual(after.models, OWNER_MODELS);
		assert.deepEqual(readJson(tenantAuthFile(volume, ID_C)), { SOME_KEY: "kept" }, "an existing key file is not touched");
	});

	it("refuses to overwrite a settings file it cannot read", () => {
		const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		fs.mkdirSync(tenantDir(volume, id), { recursive: true });
		fs.writeFileSync(path.join(tenantDir(volume, id), "settings.json"), "{ not json");
		assert.throws(() => provisionTenant({ volumeDir: volume, tenantId: id }), /settings\.json/);
		assert.equal(fs.readFileSync(path.join(tenantDir(volume, id), "settings.json"), "utf8"), "{ not json");
	});

	it("refuses tenant IDs that are not UUIDs", () => {
		for (const bad of ["../x", "a/b", "", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/..", "not-a-uuid"]) {
			assert.throws(() => provisionTenant({ volumeDir: volume, tenantId: bad }), /tenant id/i, bad);
		}
		assert.deepEqual(fs.readdirSync(path.join(volume, "tenants")).sort(), [ID_A, ID_B, ID_C, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"].sort());
	});
});

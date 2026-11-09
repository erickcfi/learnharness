/**
 * Tenant provisioning (PRD C1 req 2, C3 req 3 at create time).
 *
 * Creates <volume>/tenants/<tenantId>/ and writes the Owner's template into
 * its settings.json. Safe to run on every login: it never deletes anything,
 * keeps every section the template does not own, and never touches an
 * existing key file. It refuses to replace a settings file it cannot read,
 * so a damaged file is left for a person to look at.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tenantAuthFile, tenantDir } from "./paths.ts";
import { buildSettingsTemplate, SETTINGS_VERSION, type FileAccessProvider } from "./settings-template.ts";

export interface ProvisionOptions {
	volumeDir: string;
	tenantId: string;
	/** w1-lockdown's File access section (see settings-template.ts). */
	fileAccess?: FileAccessProvider;
}

export interface ProvisionResult {
	tenantDir: string;
	authFile: string;
	/** True when this call created the tenant folder. */
	created: boolean;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function writeAtomic(file: string, content: string, mode: number): void {
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temp, content, { mode });
	fs.renameSync(temp, file);
}

function readSettings(file: string): Json | null {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Refusing to replace ${file}: settings.json is not valid JSON.`);
	}
	if (!isObject(parsed)) throw new Error(`Refusing to replace ${file}: settings.json is not a JSON object.`);
	return parsed;
}

export function provisionTenant(options: ProvisionOptions): ProvisionResult {
	const dir = tenantDir(options.volumeDir, options.tenantId);
	const authFile = tenantAuthFile(options.volumeDir, options.tenantId);
	const created = !fs.existsSync(dir);

	fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);

	fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
	if (!fs.existsSync(authFile)) writeAtomic(authFile, "{}\n", 0o600);

	const settingsFile = path.join(dir, "settings.json");
	const existing = readSettings(settingsFile) ?? {};
	const template = buildSettingsTemplate({ volumeDir: path.resolve(options.volumeDir), tenantDir: dir }, options.fileAccess);
	const agent = isObject(existing.agent) ? { ...existing.agent } : {};
	if (template.fileAccess) agent.fileAccess = template.fileAccess;
	const next: Json = {
		...existing,
		version: typeof existing.version === "number" ? existing.version : SETTINGS_VERSION,
		models: template.models,
		...(Object.keys(agent).length > 0 ? { agent } : {}),
	};
	writeAtomic(settingsFile, `${JSON.stringify(next, null, "\t")}\n`, 0o600);

	return { tenantDir: dir, authFile, created };
}

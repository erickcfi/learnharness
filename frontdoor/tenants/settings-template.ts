/**
 * The Owner's settings template (PRD C3 req 3, N2).
 *
 * The front door writes these sections into each tenant's settings.json when
 * it creates the tenant. Writing them again whenever the Owner changes the
 * template is P2-04 (settings sync), which reuses this module.
 *
 * Models (Owner, 2026-11-08): Strong = claude-opus-5-5 at high thinking, as
 * the PRD says until T7. Cheap and Vision = claude-sonnet-5-5 with the
 * default thinking level, until the Owner sets them after T7.
 *
 * Types only come from upstream's pure core (src/core), so this file stays
 * free of upstream runtime code and runs under plain Node.
 */
import type { FileAccessSettings } from "../../src/core/file-access.ts";
import type { ModelsSettings } from "../../src/core/settings.ts";

/** Upstream's settings schema version (CURRENT_SETTINGS_VERSION). A test
 *  fails if upstream bumps it, so the template is checked again. */
export const SETTINGS_VERSION = 1;

export const OWNER_MODELS: ModelsSettings = {
	strong: { model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" },
	cheap: { model: { provider: "anthropic", id: "claude-sonnet-5-5" } },
	vision: { model: { provider: "anthropic", id: "claude-sonnet-5-5" } },
};

export interface TemplateContext {
	volumeDir: string;
	tenantDir: string;
}

/**
 * Returns the File access section for one tenant (C5, card P1-06). The
 * front door passes lockdown's: upstream's restricted mode with the library
 * as the only folder (wiring/front-door.ts). Return undefined to leave the
 * section out.
 */
export type FileAccessProvider = (context: TemplateContext) => FileAccessSettings | undefined;

/** No File access section (tests, and callers that do not set one). */
export const NO_FILE_ACCESS_SECTION: FileAccessProvider = () => undefined;

export interface TemplateSections {
	models: ModelsSettings;
	fileAccess?: FileAccessSettings;
}

export function buildSettingsTemplate(context: TemplateContext, fileAccess: FileAccessProvider = NO_FILE_ACCESS_SECTION): TemplateSections {
	const access = fileAccess(context);
	return {
		models: structuredClone(OWNER_MODELS),
		...(access ? { fileAccess: structuredClone(access) } : {}),
	};
}

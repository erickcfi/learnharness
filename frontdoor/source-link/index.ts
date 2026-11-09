/**
 * The AGPL source link (PRD cross-cutting requirement 1, D23).
 *
 * Owner decision, 2026-11-08: the front door pages carry a footer link, and
 * the student app's sidebar carries a small "Source code" link. Both point
 * at erickcfi/learnharness at the deployed commit, which Railway gives as
 * RAILWAY_GIT_COMMIT_SHA (the student app gets it at build time as
 * LH_SOURCE_COMMIT, through next.config.ts).
 *
 * Framework-free and runnable by plain Node (type stripping).
 */

export const SOURCE_REPOSITORY = "https://github.com/erickcfi/learnharness";
export const SOURCE_LINK_LABEL = "Source code";

/** The source at one commit. An unknown or malformed commit id gives the
 *  repository's home page, so no other text ever reaches the URL. */
export function sourceUrl(commit?: string | null): string {
	const sha = typeof commit === "string" ? commit.trim().toLowerCase() : "";
	return /^[0-9a-f]{7,40}$/.test(sha) ? `${SOURCE_REPOSITORY}/tree/${sha}` : SOURCE_REPOSITORY;
}

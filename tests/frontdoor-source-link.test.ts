/**
 * North Aero cross-cutting requirement 1 (AGPL): the app links to the
 * source of erickcfi/learnharness at the deployed commit. Railway sets
 * RAILWAY_GIT_COMMIT_SHA; next.config.ts carries it into the student app
 * at build time as LH_SOURCE_COMMIT. The front door reads it directly.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const prior = process.env.RAILWAY_GIT_COMMIT_SHA;
process.env.RAILWAY_GIT_COMMIT_SHA = SHA;
const { default: nextConfig } = await import("../next.config.ts");
if (prior === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA; else process.env.RAILWAY_GIT_COMMIT_SHA = prior;
const { SOURCE_REPOSITORY, sourceUrl } = await import("../frontdoor/source-link/index.ts");
const { SourceCodeLink } = await import("../components/sidebar.tsx");

describe("source link", () => {
	it("points at the deployed commit of erickcfi/learnharness", () => {
		assert.equal(SOURCE_REPOSITORY, "https://github.com/erickcfi/learnharness");
		assert.equal(sourceUrl(SHA), `https://github.com/erickcfi/learnharness/tree/${SHA}`);
		assert.equal(sourceUrl(` ${SHA.toUpperCase()} `), `https://github.com/erickcfi/learnharness/tree/${SHA}`);
		assert.equal(sourceUrl("0123abc"), "https://github.com/erickcfi/learnharness/tree/0123abc");
	});

	it("falls back to the repository page when the commit is unknown or not a commit id", () => {
		for (const commit of [undefined, null, "", "   ", "main", "abc", "0123abc/../../evil", "javascript:alert(1)", `${SHA}0`]) {
			assert.equal(sourceUrl(commit), SOURCE_REPOSITORY, JSON.stringify(commit));
		}
	});

	it("the student app build carries Railway's commit", () => {
		assert.equal(nextConfig.env?.LH_SOURCE_COMMIT, SHA);
	});

	it("the student app's sidebar shows a Source code link to that commit", () => {
		const previous = process.env.LH_SOURCE_COMMIT;
		process.env.LH_SOURCE_COMMIT = SHA;
		try {
			const html = renderToStaticMarkup(React.createElement(SourceCodeLink));
			assert.match(html, new RegExp(`href="https://github.com/erickcfi/learnharness/tree/${SHA}"`));
			assert.match(html, />Source code</);
			assert.match(html, /data-testid="source-code-link"/);
			assert.match(html, /rel="noreferrer"/);
		} finally {
			if (previous === undefined) delete process.env.LH_SOURCE_COMMIT; else process.env.LH_SOURCE_COMMIT = previous;
		}
	});
});

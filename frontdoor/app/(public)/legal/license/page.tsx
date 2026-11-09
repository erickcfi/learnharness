import { COPYRIGHT_NOTICE, LICENSE_NOTICE } from "../../../../legal-notices/index.ts";
import { licenseText } from "../../../../legal-notices/license-text.ts";
import { pageMetadata } from "../../../../marketing/metadata.ts";
import { LEGAL_PATHS } from "../../../../marketing/public-paths.ts";
import { SOURCE_LINK_LABEL, sourceUrl } from "../../../../source-link/index.ts";

/**
 * The AGPL's legal notices and the full license text (LICENSE section 0,
 * "Appropriate Legal Notices": how to view a copy of this License). Built
 * once at build time from the repository's LICENSE file.
 */
export const dynamic = "force-static";

export const metadata = pageMetadata({
	title: "License and source code",
	description: "The North Aero Ground Tutor is built on LearnHarness, free software under the GNU AGPL-3.0. The license and the source code.",
	path: LEGAL_PATHS.license,
});

export default function License() {
	const commit = process.env.RAILWAY_GIT_COMMIT_SHA;
	return (
		<section className="na-pagehead na-legal">
			<div className="na-wrap">
				<h1>License and source code</h1>
				<p className="na-lead">The North Aero Ground Tutor is built on LearnHarness.</p>
				<p>{COPYRIGHT_NOTICE}</p>
				<p>{LICENSE_NOTICE}</p>
				<p>
					<a href={sourceUrl(commit)} rel="noopener">
						{SOURCE_LINK_LABEL}
					</a>
					: the exact code running on this site, free to read, copy and share.
				</p>
				<p>The full license follows.</p>
				<pre data-testid="license-text" style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", lineHeight: 1.45, overflowWrap: "anywhere" }}>
					{licenseText()}
				</pre>
			</div>
		</section>
	);
}

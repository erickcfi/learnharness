import type { CSSProperties } from "react";
import { SOURCE_LINK_LABEL, sourceUrl } from "../source-link/index.ts";
import { COPYRIGHT_NOTICE, LICENSE_LINK_LABEL, LICENSE_NOTICE, LICENSE_PATH } from "./index.ts";

/** One small line with the AGPL's legal notices, for the account and admin screens. */
export function LegalNoticeLine({ commit, style }: { commit?: string | null; style?: CSSProperties }) {
	return (
		<p data-testid="legal-notice" style={{ margin: 0, fontSize: "0.75rem", lineHeight: 1.5, opacity: 0.75, ...style }}>
			{COPYRIGHT_NOTICE} {LICENSE_NOTICE}{" "}
			<a href={LICENSE_PATH}>{LICENSE_LINK_LABEL}</a>
			{" · "}
			<a href={sourceUrl(commit)} rel="noopener">
				{SOURCE_LINK_LABEL}
			</a>
		</p>
	);
}

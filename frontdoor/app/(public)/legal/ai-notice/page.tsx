import { ComingSoonPage } from "../../../../marketing/components/pages.tsx";
import { LEGAL } from "../../../../marketing/copy.ts";
import { pageMetadata } from "../../../../marketing/metadata.ts";
import { LEGAL_PATHS } from "../../../../marketing/public-paths.ts";

/** Placeholder until the legal texts (ticket T5) are approved. */
export const metadata = pageMetadata({ title: LEGAL.aiNotice.title, description: `${LEGAL.aiNotice.title} for the North Aero Ground Tutor.`, path: LEGAL_PATHS.aiNotice });

export default function AiNotice() {
	return <ComingSoonPage title={LEGAL.aiNotice.title} />;
}

import { HelpPage } from "../../../marketing/components/pages.tsx";
import { HELP } from "../../../marketing/copy.ts";
import { pageMetadata } from "../../../marketing/metadata.ts";
import { HELP_PATH } from "../../../marketing/public-paths.ts";
import { PLANS, TRIAL } from "../../../plans/index.ts";

export const metadata = pageMetadata({ ...HELP.meta, path: HELP_PATH });

export default function Help() {
	return <HelpPage plans={PLANS} trial={TRIAL} />;
}

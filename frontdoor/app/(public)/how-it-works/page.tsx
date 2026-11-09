import { HowItWorksPage } from "../../../marketing/components/pages.tsx";
import { HOW_IT_WORKS } from "../../../marketing/copy.ts";
import { pageMetadata } from "../../../marketing/metadata.ts";
import { HOW_IT_WORKS_PATH } from "../../../marketing/public-paths.ts";
import { PLANS, TRIAL } from "../../../plans/index.ts";

export const metadata = pageMetadata({ ...HOW_IT_WORKS.meta, path: HOW_IT_WORKS_PATH });

export default function HowItWorks() {
	return <HowItWorksPage plans={PLANS} trial={TRIAL} />;
}

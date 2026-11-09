import { LandingPage } from "../../marketing/components/pages.tsx";
import { LANDING } from "../../marketing/copy.ts";
import { pageMetadata } from "../../marketing/metadata.ts";
import { LANDING_PATH } from "../../marketing/public-paths.ts";
import { PLANS, TRIAL } from "../../plans/index.ts";

/** The landing page. The gateway shows it only to visitors with no login;
 *  a signed-in student's "/" is their tutor. */
export const metadata = pageMetadata({ title: LANDING.meta.title, description: LANDING.meta.description(TRIAL), path: LANDING_PATH, absoluteTitle: true });

export default function Landing() {
	return <LandingPage plans={PLANS} trial={TRIAL} />;
}

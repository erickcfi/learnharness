/**
 * The frame of every public page: header, main, footer (W2-11).
 *
 * Links are plain <a> tags on purpose. "/" may be the student's tutor (a
 * different app), so client-side navigation between the two must not
 * happen.
 */
import type { ReactNode } from "react";
import { SOURCE_LINK_LABEL, sourceUrl } from "../../source-link/index.ts";
import { BRAND, CTA, FOOTER, NAV } from "../copy.ts";
import { HELP_PATH, HOW_IT_WORKS_PATH, LANDING_PATH, LEGAL_PATHS, SIGN_IN_PATH, SIGN_UP_PATH } from "../public-paths.ts";
import { CONTACT_EMAIL } from "../site.ts";

/** North Aero's mark for the Ground Tutor: a heading chevron in a ring. */
export function BrandMark({ size = 28 }: { size?: number }) {
	return (
		<svg className="na-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
			<circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="2" />
			<path d="M16 7 L23 22 L16 18.5 L9 22 Z" fill="var(--na-orange)" />
		</svg>
	);
}

export function Wordmark() {
	return (
		<a className="na-wordmark" href={LANDING_PATH} aria-label={NAV.home}>
			<BrandMark />
			<span className="na-wordmark-text">
				<span className="na-wordmark-school">{BRAND.school}</span>
				<span className="na-wordmark-product">{BRAND.product}</span>
			</span>
		</a>
	);
}

export function SiteHeader() {
	return (
		<header className="na-header">
			<div className="na-wrap na-header-row">
				<Wordmark />
				<nav className="na-nav" aria-label="Main">
					<a href={HOW_IT_WORKS_PATH}>{NAV.howItWorks}</a>
					<a href={HELP_PATH}>{NAV.help}</a>
					<a href={SIGN_IN_PATH}>{NAV.signIn}</a>
				</nav>
				<a className="na-btn na-btn-small na-header-cta" href={SIGN_UP_PATH} data-cta="start-trial">
					{NAV.startTrial}
				</a>
			</div>
		</header>
	);
}

export function SiteFooter({ commit, year }: { commit?: string | null; year: number }) {
	return (
		<footer className="na-footer">
			<div className="na-wrap na-footer-grid">
				<div>
					<Wordmark />
					<p className="na-footer-tagline">{FOOTER.tagline}</p>
					<p className="na-footer-fine">{FOOTER.disclaimer}</p>
				</div>
				<nav className="na-footer-links" aria-label="Footer">
					<a href={HOW_IT_WORKS_PATH}>{NAV.howItWorks}</a>
					<a href={HELP_PATH}>{NAV.help}</a>
					<a href={SIGN_UP_PATH}>{CTA.startTrial}</a>
					<a href={`mailto:${CONTACT_EMAIL}`}>{FOOTER.contact}</a>
				</nav>
				<nav className="na-footer-links" aria-label="Legal">
					<a href={LEGAL_PATHS.terms}>{FOOTER.terms}</a>
					<a href={LEGAL_PATHS.privacy}>{FOOTER.privacy}</a>
					<a href={LEGAL_PATHS.aiNotice}>{FOOTER.aiNotice}</a>
					<a href={sourceUrl(commit)} rel="noopener">
						{SOURCE_LINK_LABEL}
					</a>
				</nav>
			</div>
			<div className="na-wrap na-footer-base">
				<span>{FOOTER.copyright(year)}</span>
				<span>{FOOTER.builtOn}</span>
			</div>
		</footer>
	);
}

/** Header, page, footer. `commit` is the deployed commit, for the AGPL link. */
export function PublicShell({ children, commit, year = new Date().getFullYear() }: { children: ReactNode; commit?: string | null; year?: number }) {
	return (
		<div className="na-site">
			<SiteHeader />
			<main id="main" className="na-main">
				{children}
			</main>
			<SiteFooter commit={commit} year={year} />
		</div>
	);
}

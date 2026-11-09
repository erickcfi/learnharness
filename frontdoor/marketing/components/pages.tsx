/**
 * The public pages' content (W2-11). The Next.js route files in
 * frontdoor/app/(public)/ render these. Prices and trial terms arrive as
 * props from frontdoor/plans, so a test can render a page with other
 * values and see them on the page.
 */
import type { Plan, Trial } from "../../plans/index.ts";
import { CTA, HELP, HOW_IT_WORKS, LANDING, LEGAL, planPriceLine, trialSummary } from "../copy.ts";
import { HOW_IT_WORKS_PATH, SIGN_UP_PATH } from "../public-paths.ts";
import { CONTACT_EMAIL } from "../site.ts";
import { PlayOnView } from "./play-on-view.tsx";
import { TutorScreen } from "./screens.tsx";
import { Tour } from "./tour.tsx";

function TrialButton({ plans, trial, dark = false }: { plans: readonly Plan[]; trial: Trial; dark?: boolean }) {
	return (
		<div className="na-cta">
			<a className="na-btn" href={SIGN_UP_PATH} data-cta="start-trial">
				{CTA.startTrial}
			</a>
			<p className={dark ? "na-cta-fine is-dark" : "na-cta-fine"}>{trialSummary(plans, trial)}</p>
		</div>
	);
}

function SectionHead({ eyebrow, title, lead, id }: { eyebrow: string; title: string; lead?: string; id?: string }) {
	return (
		<div className="na-section-head">
			<p className="na-eyebrow">{eyebrow}</p>
			<h2 id={id}>{title}</h2>
			{lead ? <p className="na-lead">{lead}</p> : null}
		</div>
	);
}

export function PlanCards({ plans, trial }: { plans: readonly Plan[]; trial: Trial }) {
	const p = LANDING.pricing;
	return (
		<>
			<div className="na-trial">
				<h3>{p.trialTitle(trial)}</h3>
				<p>{p.trialText(plans, trial)}</p>
			</div>
			<ul className="na-plans">
				{plans.map((plan) => {
					const line = planPriceLine(plan);
					return (
						<li key={plan.id} className="na-plan" data-plan={plan.id}>
							<h3>{plan.name}</h3>
							<p className="na-plan-price">
								<span className="na-plan-amount">{line.price}</span> <span className="na-plan-period">{line.period}</span>
							</p>
							{line.note ? <p className="na-plan-note">{line.note}</p> : null}
						</li>
					);
				})}
			</ul>
			<p className="na-plans-fine">{p.renewNote}</p>
			<p className="na-plans-fine">{p.studentCode}</p>
		</>
	);
}

export function LandingPage({ plans, trial }: { plans: readonly Plan[]; trial: Trial }) {
	const { hero, tour, audience, library, honest, pricing, final } = LANDING;
	return (
		<>
			<section className="na-hero">
				<div className="na-wrap na-hero-grid">
					<div className="na-hero-copy">
						<p className="na-eyebrow is-dark">{hero.eyebrow}</p>
						<h1>
							{hero.titleLines.map((line) => (
								<span key={line}>{line}</span>
							))}
						</h1>
						<p className="na-hero-lead">{hero.lead}</p>
						<TrialButton plans={plans} trial={trial} dark />
						<a className="na-textlink is-dark" href={HOW_IT_WORKS_PATH}>
							{CTA.seeHow} →
						</a>
					</div>
					<div className="na-hero-screen">
						<PlayOnView replayLabel={HOW_IT_WORKS.replay}>
							<TutorScreen id="ask" />
						</PlayOnView>
					</div>
				</div>
			</section>

			<section className="na-section" aria-labelledby="na-tour-title">
				<div className="na-wrap">
					<SectionHead eyebrow={tour.eyebrow} title={tour.title} lead={tour.lead} id="na-tour-title" />
					<Tour />
					<a className="na-textlink" href={HOW_IT_WORKS_PATH}>
						{CTA.fullTour} →
					</a>
				</div>
			</section>

			<section className="na-section is-sand" aria-labelledby="na-audience-title">
				<div className="na-wrap">
					<SectionHead eyebrow={audience.eyebrow} title={audience.title} id="na-audience-title" />
					<ul className="na-cards">
						{audience.items.map((item) => (
							<li key={item.title} className="na-card">
								<h3>{item.title}</h3>
								<p>{item.text}</p>
							</li>
						))}
					</ul>
					<p className="na-note">{audience.age}</p>
				</div>
			</section>

			<section className="na-section" aria-labelledby="na-library-title">
				<div className="na-wrap">
					<SectionHead eyebrow={library.eyebrow} title={library.title} lead={library.text} id="na-library-title" />
					<ul className="na-cards is-three">
						{library.sources.map((source) => (
							<li key={source.title} className="na-card">
								<h3>{source.title}</h3>
								<p>{source.text}</p>
							</li>
						))}
					</ul>
				</div>
			</section>

			<section className="na-section is-sand" aria-labelledby="na-honest-title">
				<div className="na-wrap">
					<SectionHead eyebrow={honest.eyebrow} title={honest.title} id="na-honest-title" />
					<div className="na-cards">
						<div className="na-card">
							<h3>{honest.isTitle}</h3>
							<ul className="na-list is-yes">
								{honest.is.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</div>
						<div className="na-card">
							<h3>{honest.isntTitle}</h3>
							<ul className="na-list is-no">
								{honest.isnt.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</div>
					</div>
				</div>
			</section>

			<section className="na-section" aria-labelledby="na-pricing-title" id="pricing">
				<div className="na-wrap">
					<SectionHead eyebrow={pricing.eyebrow} title={pricing.title} id="na-pricing-title" />
					<PlanCards plans={plans} trial={trial} />
				</div>
			</section>

			<section className="na-final">
				<div className="na-wrap na-final-inner">
					<h2>{final.title}</h2>
					<p>{final.text}</p>
					<TrialButton plans={plans} trial={trial} dark />
				</div>
			</section>
		</>
	);
}

export function HowItWorksPage({ plans, trial }: { plans: readonly Plan[]; trial: Trial }) {
	const h = HOW_IT_WORKS;
	return (
		<>
			<section className="na-pagehead">
				<div className="na-wrap">
					<p className="na-eyebrow">{h.eyebrow}</p>
					<h1>{h.title}</h1>
					<p className="na-lead">{h.lead}</p>
				</div>
			</section>
			<ol className="na-steps na-wrap">
				{h.steps.map((step) => (
					<li key={step.id} className="na-step" id={step.id} data-step={step.id}>
						<div className="na-step-copy">
							<p className="na-eyebrow">{step.kicker}</p>
							<h2>{step.title}</h2>
							{step.text.map((line) => (
								<p key={line}>{line}</p>
							))}
						</div>
						<div className="na-step-screen">
							<PlayOnView replayLabel={h.replay}>
								<TutorScreen id={step.id} />
							</PlayOnView>
						</div>
					</li>
				))}
			</ol>
			<section className="na-section is-sand">
				<div className="na-wrap na-memory">
					<h2>{h.memory.title}</h2>
					<p className="na-lead">{h.memory.text}</p>
				</div>
			</section>
			<section className="na-final">
				<div className="na-wrap na-final-inner">
					<h2>{LANDING.final.title}</h2>
					<TrialButton plans={plans} trial={trial} dark />
				</div>
			</section>
		</>
	);
}

export function HelpPage({ plans, trial }: { plans: readonly Plan[]; trial: Trial }) {
	const h = HELP;
	return (
		<>
			<section className="na-pagehead">
				<div className="na-wrap">
					<p className="na-eyebrow">{h.eyebrow}</p>
					<h1>{h.title}</h1>
					<p className="na-lead">
						{h.lead} <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
					</p>
					<nav className="na-toc" aria-label={h.title}>
						{h.sections.map((section) => (
							<a key={section.id} href={`#${section.id}`}>
								{section.title}
							</a>
						))}
						<a href="#faq">{h.faqTitle}</a>
					</nav>
				</div>
			</section>
			<div className="na-wrap na-help">
				{h.sections.map((section) => (
					<section key={section.id} id={section.id} className="na-help-section">
						<h2>{section.title}</h2>
						<ol>
							{section.steps.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ol>
						{"note" in section && section.note ? <p className="na-note">{section.note}</p> : null}
					</section>
				))}
				<section id="faq" className="na-help-section">
					<h2>{h.faqTitle}</h2>
					<div className="na-faq">
						{h.faq(plans, trial).map((item) => (
							<details key={item.q}>
								<summary>{item.q}</summary>
								{item.a.map((line) => (
									<p key={line}>{line}</p>
								))}
							</details>
						))}
					</div>
				</section>
			</div>
		</>
	);
}

export function ComingSoonPage({ title }: { title: string }) {
	return (
		<section className="na-pagehead na-legal">
			<div className="na-wrap">
				<h1>{title}</h1>
				<p className="na-lead">{LEGAL.comingSoon}</p>
				<p>{LEGAL.question}</p>
			</div>
		</section>
	);
}

"use client";

/**
 * The short tour on the landing page: Measure, Plan, Teach, Practice,
 * Record. It moves on by itself while it is on screen, with a Pause
 * button (a visitor can always stop moving content). Choosing a step stops
 * the auto-play. With reduced motion it shows still frames and never moves
 * on by itself; the step buttons still work.
 *
 * All five steps sit in the same spot and only the chosen one shows, so
 * the tour keeps the height of the tallest step and the page never jumps.
 */
import { useEffect, useRef, useState } from "react";
import { TOUR_TABS } from "../copy.ts";
import { motionAllowed } from "../motion.ts";
import { SCREEN_DURATION_MS, TutorScreen } from "./screens.tsx";

export const TOUR_LABELS = { steps: "Tour steps", pause: "Pause tour", play: "Play tour" };

export function Tour() {
	const ref = useRef<HTMLDivElement>(null);
	const [index, setIndex] = useState(0);
	const [allowed, setAllowed] = useState(false);
	const [visible, setVisible] = useState(false);
	const [auto, setAuto] = useState(true);

	useEffect(() => {
		if (!motionAllowed()) return;
		setAllowed(true);
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), { threshold: 0.3 });
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const step = TOUR_TABS[index]!;
	const running = allowed && visible && auto;

	useEffect(() => {
		if (!running) return;
		const timer = setTimeout(() => setIndex((i) => (i + 1) % TOUR_TABS.length), SCREEN_DURATION_MS[step.id]);
		return () => clearTimeout(timer);
	}, [running, step.id, index]);

	const motion = !allowed ? "still" : visible ? "playing" : "armed";

	return (
		<div ref={ref} className="na-tour" data-auto={running ? "on" : "off"}>
			<div className="na-tour-tabs" role="tablist" aria-label={TOUR_LABELS.steps}>
				{TOUR_TABS.map((tab, i) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={`na-tour-tab-${tab.id}`}
						aria-selected={i === index}
						aria-controls="na-tour-panel"
						className="na-tour-tab"
						onClick={() => {
							setAuto(false);
							setIndex(i);
						}}
					>
						<span className="na-tour-num">{i + 1}</span>
						{tab.tab}
						{i === index && running ? <span className="na-tour-progress" style={{ animationDuration: `${SCREEN_DURATION_MS[tab.id]}ms` }} aria-hidden="true" /> : null}
					</button>
				))}
			</div>
			<div className="na-tour-panel" id="na-tour-panel" role="tabpanel" aria-labelledby={`na-tour-tab-${step.id}`}>
				{TOUR_TABS.map((tab, i) => {
					const on = i === index;
					return (
						<div key={tab.id} className={on ? "na-tour-step is-on" : "na-tour-step"} aria-hidden={on ? undefined : true} inert={!on}>
							<div className="na-tour-copy">
								<h3>{tab.title}</h3>
								<p>{tab.text}</p>
							</div>
							<div key={on ? `on-${index}` : "off"} className="na-motion" data-motion={on ? motion : "still"}>
								<TutorScreen id={tab.id} />
							</div>
						</div>
					);
				})}
			</div>
			{allowed ? (
				<button type="button" className="na-tour-pause" aria-pressed={!auto} onClick={() => setAuto((a) => !a)}>
					{auto ? TOUR_LABELS.pause : TOUR_LABELS.play}
				</button>
			) : null}
		</div>
	);
}

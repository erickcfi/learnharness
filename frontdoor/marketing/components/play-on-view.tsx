"use client";

/**
 * Plays a tutor screen's animation once, when it scrolls into view, with a
 * Replay button. With reduced motion (or no JavaScript) the screen keeps
 * its still final frame and there is no Replay button.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motionAllowed, type MotionState } from "../motion.ts";

export function PlayOnView({ children, replayLabel }: { children: ReactNode; replayLabel: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [motion, setMotion] = useState<MotionState>("still");
	const [run, setRun] = useState(0);

	useEffect(() => {
		if (!motionAllowed()) return;
		const element = ref.current;
		if (!element) return;
		if (typeof IntersectionObserver === "undefined") {
			setMotion("playing");
			return;
		}
		setMotion("armed");
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setMotion("playing");
					observer.disconnect();
				}
			},
			{ threshold: 0.35 },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="na-pov">
			<div ref={ref} key={run} className="na-motion" data-motion={motion}>
				{children}
			</div>
			{motion === "still" ? null : (
				<button
					type="button"
					className="na-replay"
					onClick={() => {
						setMotion("playing");
						setRun((n) => n + 1);
					}}
				>
					{replayLabel}
				</button>
			)}
		</div>
	);
}

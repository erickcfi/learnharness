/**
 * Stylized tutor screens for the tour (W2-11). They copy the look and the
 * labels of the real student app (upstream LearnHarness: home.tsx,
 * new-session.tsx, question-dock.tsx, phase-divider.tsx, plan-block.tsx,
 * practice-dock.tsx, composer.tsx) and the printed study record
 * (frontdoor/records). All text comes from copy.ts.
 *
 * Plain markup and CSS only. Elements with class `na-fx` animate when a
 * wrapper sets data-motion="armed"/"playing" (see motion.ts). With no
 * wrapper state they show their final frame.
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { SCREENS, type ScreenId } from "../copy.ts";

/** Animation delay, in seconds, as the CSS variable --d. */
const d = (seconds: number, extra: Record<string, string> = {}): CSSProperties => ({ "--d": `${seconds.toFixed(2)}s`, ...extra }) as CSSProperties;

const WORD_STEP = 0.06;

/** Words that appear one after another, like text being written. */
function Words({ text, start, step = WORD_STEP }: { text: string; start: number; step?: number }) {
	const words = text.split(" ");
	return (
		<>
			{words.map((word, i) => (
				<Fragment key={i}>
					<span className="na-fx na-fx-word" style={d(start + i * step)}>
						{word}
					</span>
					{i < words.length - 1 ? " " : null}
				</Fragment>
			))}
		</>
	);
}

/** When the last word of `text` appears, starting at `start`. */
const after = (text: string, start: number, step = WORD_STEP) => start + text.split(" ").length * step;

/** How long each screen plays, in milliseconds, before the tour moves on. */
export const SCREEN_DURATION_MS: Record<ScreenId, number> = {
	ask: 7000,
	probe: 10000,
	plan: 8500,
	teach: 11000,
	practice: 11000,
	record: 8000,
};

function Frame({ title, phase, label, children }: { title: string; phase?: string; label: string; children: ReactNode }) {
	return (
		<div className="na-ts" role="img" aria-label={label}>
			<div className="na-ts-bar">
				<span className="na-ts-menu" aria-hidden="true" />
				<span className="na-ts-title">{title}</span>
				{phase ? <span className="na-ts-phase">{phase}</span> : null}
			</div>
			<div className="na-ts-body">{children}</div>
		</div>
	);
}

function Options({ options, picked, pickAt, dontKnow }: { options: readonly string[]; picked: number; pickAt: number; dontKnow?: string }) {
	return (
		<ul className="na-ts-options">
			{options.map((option, i) => (
				<li key={option} className={i === picked ? "na-ts-opt is-picked na-fx na-fx-pick" : "na-ts-opt"} style={i === picked ? d(pickAt) : undefined}>
					<span className="na-ts-radio" aria-hidden="true" />
					{option}
				</li>
			))}
			{dontKnow ? (
				<li className="na-ts-opt is-dk">
					<span className="na-ts-radio" aria-hidden="true" />
					{dontKnow}
				</li>
			) : null}
		</ul>
	);
}

function AskScreen() {
	const s = SCREENS.ask;
	const typed = 0.6;
	const press = after(s.typed, typed, 0.12) + 0.4;
	return (
		<div className="na-ts na-ts-home" role="img" aria-label={`Sample tutor home screen: "${s.typed}" typed in the box "${s.prompt}", with Teach chosen.`}>
			<div className="na-ts-bar">
				<span className="na-ts-menu" aria-hidden="true" />
			</div>
			<div className="na-ts-body">
				<p className="na-ts-newtitle">{s.title}</p>
				<div className="na-ts-composer">
					<span className="na-ts-placeholder na-fx na-fx-out" style={d(typed)}>
						{s.prompt}
					</span>
					<span className="na-ts-typed">
						<Words text={s.typed} start={typed} step={0.12} />
					</span>
					<span className="na-ts-enter na-fx na-fx-press" style={d(press)} aria-label={s.start}>
						↵
					</span>
				</div>
				<div className="na-ts-modes">
					<span className="is-on">{s.teach}</span>
					<span>{s.practice}</span>
				</div>
				<p className="na-ts-hint na-fx na-fx-fade" style={d(press + 0.5)}>
					{s.hint}
				</p>
			</div>
		</div>
	);
}

function ProbeScreen() {
	const s = SCREENS.probe;
	const pick = 1.6;
	const slide = pick + 0.9;
	const think = slide + 1.2;
	const submit = after(s.thinking, think) + 0.5;
	return (
		<Frame title={SCREENS.sessionTitle} phase={s.phase} label={`Sample tutor screen: a probe question, "${s.question}", with "${s.options[s.correct]}" picked, confidence ${s.confidence}%.`}>
			<div className="na-ts-card na-fx na-fx-rise" style={d(0.2)}>
				<div className="na-ts-kind">{s.kind}</div>
				<p className="na-ts-q">{s.question}</p>
				<Options options={s.options} picked={s.correct} pickAt={pick} dontKnow={s.dontKnow} />
				<div className="na-ts-conf">
					<span className="na-ts-label">{s.confidenceLabel}</span>
					<span className="na-ts-track">
						<span className="na-ts-fill na-fx na-fx-grow" style={d(slide, { width: `${s.confidence}%` })} />
						<span className="na-ts-thumb na-fx na-fx-slide" style={d(slide, { left: `${s.confidence}%` })} />
					</span>
					<span className="na-ts-pct na-fx na-fx-fade" style={d(slide + 0.6)}>
						{s.confidence}%
					</span>
				</div>
				<div className="na-ts-thinking">
					<span className="na-ts-label">{s.thinkingLabel}</span>
					<p>
						<Words text={s.thinking} start={think} />
					</p>
				</div>
				<div className="na-ts-actions">
					<span className="na-ts-submit na-fx na-fx-press" style={d(submit)}>
						{s.submit}
					</span>
				</div>
			</div>
		</Frame>
	);
}

/** Plan diagram geometry: a zigzag through the parts of a METAR. */
const PLAN_NODES = [
	{ x: 170, y: 20 },
	{ x: 86, y: 80 },
	{ x: 254, y: 80 },
	{ x: 254, y: 140 },
	{ x: 86, y: 140 },
	{ x: 170, y: 204 },
];
const PLAN_EDGES: [number, number][] = [
	[0, 1],
	[1, 2],
	[2, 3],
	[3, 4],
	[4, 5],
];
const NODE_W = 156;
const NODE_H = 30;

function edgePath(from: number, to: number): string {
	const a = PLAN_NODES[from]!;
	const b = PLAN_NODES[to]!;
	if (a.y === b.y) {
		const dir = b.x > a.x ? 1 : -1;
		return `M${a.x + (dir * NODE_W) / 2} ${a.y} L${b.x - (dir * NODE_W) / 2} ${b.y}`;
	}
	return `M${a.x} ${a.y + NODE_H / 2} C${a.x} ${(a.y + b.y) / 2} ${b.x} ${(a.y + b.y) / 2} ${b.x} ${b.y - NODE_H / 2}`;
}

function PlanScreen() {
	const s = SCREENS.plan;
	const divider = after(s.intro, 0.3) + 0.3;
	const nodeAt = (i: number) => divider + 0.4 + i * 0.45;
	return (
		<Frame title={SCREENS.sessionTitle} phase={s.phase} label={`Sample tutor screen: a plan of ${s.nodes.length} topics, from "${s.nodes[0]}" to "${s.nodes[s.nodes.length - 1]}".`}>
			<p className="na-ts-prose">
				<Words text={s.intro} start={0.3} />
			</p>
			<div className="na-ts-divider na-fx na-fx-fade" style={d(divider)}>
				<span>{s.divider}</span>
			</div>
			<svg className="na-ts-plan" viewBox="0 0 340 222" aria-hidden="true">
				{PLAN_EDGES.map(([from, to]) => (
					<path key={`${from}-${to}`} className="na-ts-edge na-fx na-fx-draw" pathLength={1} d={edgePath(from, to)} style={d(nodeAt(to) - 0.3)} />
				))}
				{s.nodes.map((name, i) => {
					const node = PLAN_NODES[i]!;
					const kind = i === 0 ? "is-held" : i === 1 ? "is-current" : i === s.nodes.length - 1 ? "is-goal" : "";
					return (
						<g key={name} className={`na-ts-node ${kind} na-fx na-fx-pop`} style={d(nodeAt(i))}>
							<rect x={node.x - NODE_W / 2} y={node.y - NODE_H / 2} width={NODE_W} height={NODE_H} rx={4} />
							<text x={node.x} y={node.y + 4} textAnchor="middle">
								{i === 0 ? `✓ ${name}` : name}
							</text>
						</g>
					);
				})}
			</svg>
			<div className="na-ts-actions">
				<span className="na-ts-chip na-fx na-fx-fade" style={d(nodeAt(s.nodes.length))}>
					{s.open}
				</span>
			</div>
		</Frame>
	);
}

function TeachScreen() {
	const s = SCREENS.teach;
	let t = 0.4;
	const lines = s.lines.map((line) => {
		const start = t;
		t = after(line, start) + 0.25;
		return { line, start };
	});
	const source = t;
	const card = source + 0.6;
	const pick = card + 1.6;
	return (
		<Frame title={SCREENS.sessionTitle} phase={s.phase} label={`Sample tutor screen: a short lesson on the METAR wind group, then a check question, "${s.question}".`}>
			<div className="na-ts-divider">
				<span>{s.phase}</span>
			</div>
			<div className="na-ts-prose">
				{lines.map(({ line, start }) => (
					<p key={line}>
						<Words text={line} start={start} />
					</p>
				))}
				<p className="na-ts-source na-fx na-fx-fade" style={d(source)}>
					{s.source}
				</p>
			</div>
			<div className="na-ts-card na-fx na-fx-rise" style={d(card)}>
				<div className="na-ts-kind">{s.kind}</div>
				<p className="na-ts-q">{s.question}</p>
				<Options options={s.options} picked={s.correct} pickAt={pick} />
				<div className="na-ts-actions">
					<span className="na-ts-submit na-fx na-fx-press" style={d(pick + 0.9)}>
						{s.submit}
					</span>
				</div>
			</div>
		</Frame>
	);
}

function PracticeScreen() {
	const s = SCREENS.practice;
	const work = 1.6;
	const reply = after(s.work, work) + 0.6;
	const done = after(s.reply, reply) + 0.4;
	return (
		<Frame title={s.title} label={`Sample practice screen: a METAR for Salinas, the question "${s.ask}", a worked answer, and the result "${s.outcome}".`}>
			<div className="na-ts-card na-ts-problem na-fx na-fx-rise" style={d(0.2)}>
				<div className="na-ts-kind">{s.problemLabel}</div>
				<p>{s.problem}</p>
				<code className="na-ts-metar">{s.metar}</code>
				<p className="na-ts-q">{s.ask}</p>
			</div>
			<div className="na-ts-thinking na-ts-work">
				<span className="na-ts-label">{s.workLabel}</span>
				<span className="na-ts-placeholder na-fx na-fx-out" style={d(work)}>
					{s.placeholder}
				</span>
				<p>
					<Words text={s.work} start={work} />
				</p>
			</div>
			<p className="na-ts-reply">
				<Words text={s.reply} start={reply} />
			</p>
			<div className="na-ts-actions">
				<span className="na-ts-outcome na-fx na-fx-pop" style={d(done)}>
					{s.outcome}
				</span>
				<span className="na-ts-next na-fx na-fx-press" style={d(done + 0.6)}>
					{s.next}
				</span>
			</div>
		</Frame>
	);
}

function RecordScreen() {
	const s = SCREENS.record;
	let t = 0.5;
	const sessions = s.sessions.map((session) => {
		const start = t;
		t += 0.3 + session.topics.length * 0.25;
		return { session, start };
	});
	const total = t + 0.1;
	return (
		<div className="na-ts na-ts-paper" role="img" aria-label={`Sample printed study record: ${s.total}. Labeled "${s.label}"`}>
			<div className="na-ts-paperlabel">{s.label}</div>
			<div className="na-ts-paperhead">
				<strong>{s.title}</strong>
				<span>
					{s.student} · {s.range}
				</span>
			</div>
			{sessions.map(({ session, start }) => (
				<div key={session.title} className="na-ts-session na-fx na-fx-rise" style={d(start)}>
					<div className="na-ts-sessionhead">
						<span>{session.title}</span>
						<span>{session.time}</span>
					</div>
					<ul>
						{session.topics.map((topic, i) => (
							<li key={topic.name} className="na-fx na-fx-fade" style={d(start + 0.3 + i * 0.25)}>
								<span>{topic.name}</span>
								<span className={`na-ts-status is-${topic.status.toLowerCase().replace(/\s+/g, "-")}`}>{topic.status}</span>
							</li>
						))}
					</ul>
				</div>
			))}
			<div className="na-ts-total na-fx na-fx-fade" style={d(total)}>
				{s.total}
			</div>
			<div className="na-ts-paperlabel">{s.label}</div>
			<div className="na-ts-actions">
				<span className="na-ts-chip na-fx na-fx-press" style={d(total + 0.6)}>
					{s.print}
				</span>
				<span className="na-ts-chip na-fx na-fx-press" style={d(total + 1.0)}>
					{s.email}
				</span>
			</div>
		</div>
	);
}

const SCREEN_COMPONENTS: Record<ScreenId, () => ReactNode> = {
	ask: AskScreen,
	probe: ProbeScreen,
	plan: PlanScreen,
	teach: TeachScreen,
	practice: PracticeScreen,
	record: RecordScreen,
};

/** One stylized tutor screen. */
export function TutorScreen({ id }: { id: ScreenId }) {
	const Screen = SCREEN_COMPONENTS[id];
	return <Screen />;
}

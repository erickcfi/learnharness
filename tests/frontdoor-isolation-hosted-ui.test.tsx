/**
 * W2-6 (P2-04, PRD C3 req 3, N2, N3, N13): in hosted mode the student never
 * sees a control that the front door would refuse. With hosted mode off,
 * upstream's UI is unchanged. Server-rendered (effects do not run, so no
 * fetch fires), as in tests/render-settings.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { ModelControl } from "../components/model-picker.tsx";
import { DictationBar, type Dictation } from "../components/dictation.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { HostedProvider } from "../frontdoor/isolation/hosted.tsx";

const render = (hosted: boolean, node: React.ReactNode) => renderToStaticMarkup(<HostedProvider hosted={hosted}>{node}</HostedProvider>);

const agentSection = (
	<AgentSection
		agent={{ fileAccess: { restricted: true, folders: ["/data/library"] } }}
		models={undefined}
		graph={undefined}
		compaction={undefined}
		onSectionChange={() => {}}
		onModelsChange={() => {}}
		onCompactionChange={() => {}}
	/>
);

const idleDictation = { phase: "idle", error: null, levelRef: { current: 0 }, toggle: () => {}, active: false, clearError: () => {} } as unknown as Dictation;

describe("Settings dialog", () => {
	it("hosted: no Providers and no General section, and it opens on Agent", () => {
		const html = render(true, <SettingsDialogBody onClose={() => {}} />);
		assert.ok(!html.includes('data-testid="settings-nav-keys"'));
		assert.ok(!html.includes('data-testid="settings-nav-general"'));
		for (const id of ["agent", "appearance", "graph", "keyboard"]) assert.ok(html.includes(`data-testid="settings-nav-${id}"`), id);
		const agentTag = html.slice(html.lastIndexOf("<", html.indexOf('data-testid="settings-nav-agent"')), html.indexOf(">", html.indexOf('data-testid="settings-nav-agent"')) + 1);
		assert.ok(agentTag.includes('aria-current="true"'));
	});

	it("hosted: a deep link to Providers lands on Agent instead", () => {
		const html = render(true, <SettingsDialogBody onClose={() => {}} initialSection="keys" initialRow="DEEPGRAM_API_KEY" />);
		assert.ok(!html.includes('data-testid="settings-nav-keys"'));
		const agentTag = html.slice(html.lastIndexOf("<", html.indexOf('data-testid="settings-nav-agent"')), html.indexOf(">", html.indexOf('data-testid="settings-nav-agent"')) + 1);
		assert.ok(agentTag.includes('aria-current="true"'));
	});

	it("not hosted: upstream's six sections, landing on Providers", () => {
		const html = render(false, <SettingsDialogBody onClose={() => {}} />);
		for (const id of ["keys", "agent", "appearance", "graph", "keyboard", "general"]) assert.ok(html.includes(`data-testid="settings-nav-${id}"`), id);
	});
});

describe("Settings → Agent", () => {
	it("hosted: no Models, File access, Search engine or System prompts; tools and compaction stay", () => {
		const html = render(true, agentSection);
		for (const id of ["group-models", "slot-row-strong", "slot-model-strong", "slot-thinking-strong", "file-access-row", "file-access-add", "search-engine-row", "group-prompts"]) {
			assert.ok(!html.includes(`data-testid="${id}"`), id);
		}
		for (const id of ["group-tools", "graph-tools-row", "quiz-mechanics-row", "tool-row-research", "compaction-row-threshold"]) assert.ok(html.includes(`data-testid="${id}"`), id);
	});

	it("not hosted: upstream's rows are all there", () => {
		const html = render(false, agentSection);
		for (const id of ["group-models", "slot-row-strong", "file-access-row", "search-engine-row", "group-prompts", "group-tools"]) assert.ok(html.includes(`data-testid="${id}"`), id);
	});
});

describe("Settings → Keyboard", () => {
	it("hosted: no shortcut rows for the hidden mic, model menu or thinking cycle", () => {
		const html = render(true, <KeyboardSection />);
		for (const label of ["Toggle dictation", "Model selector", "Cycle thinking level"]) assert.ok(!html.includes(label), label);
		assert.ok(html.includes('data-testid="kbd-scope-global"'));
		const plain = render(false, <KeyboardSection />);
		for (const label of ["Toggle dictation", "Model selector", "Cycle thinking level"]) assert.ok(plain.includes(label), label);
	});
});

describe("composer controls", () => {
	it("hosted: no model or thinking picker", () => {
		assert.equal(render(true, <ModelControl chatId="chat_1" />), "");
		assert.ok(render(false, <ModelControl chatId="chat_1" />).includes('data-testid="model-control"'));
	});

	it("hosted: no dictation mic", () => {
		assert.equal(render(true, <DictationBar dictation={idleDictation} />), "");
		assert.ok(render(false, <DictationBar dictation={idleDictation} />).includes('data-testid="dictation-toggle"'));
	});
});

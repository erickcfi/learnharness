/**
 * Runs as one tenant's server process (LH_DATA_DIR, LH_AUTH_FILE, HOME and
 * LH_LIBRARY_DIR set the way the front door sets them): loads upstream's
 * server composition root, then has the agent's own read tool read each
 * path in argv. Prints one REPORT line of JSON: [{ ok, text }].
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";

await import("../../../src/server/index.ts");
const { readTool } = await import("../../../src/agent/tools/read.ts");

async function run(tool: AgentTool<any>, input: unknown): Promise<{ ok: boolean; text: string }> {
	try {
		const result = await tool.execute!("tenant-read-library", input);
		return { ok: true, text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n") };
	} catch (error) {
		return { ok: false, text: error instanceof Error ? error.message : String(error) };
	}
}

const report = [];
for (const p of process.argv.slice(2)) report.push(await run(readTool, { path: p }));
process.stdout.write(`REPORT:${JSON.stringify(report)}\n`);
process.exit(0);

/**
 * Runs as one tenant's server process (env from tenantEnv in volume.ts):
 * loads the server composition root, then has the agent's own file tools
 * read one file in each library subfolder. Prints one REPORT line of JSON.
 * argv[2]: a file in ANOTHER tenant's folder, which must stay unreadable.
 */
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

await import("../../../src/server/index.ts");
const { readTool } = await import("../../../src/agent/tools/read.ts");
const { lsTool } = await import("../../../src/agent/tools/ls.ts");
const { grepTool } = await import("../../../src/agent/tools/grep.ts");

async function run(tool: AgentTool<any>, input: unknown): Promise<{ ok: boolean; text: string }> {
	try {
		const result = await tool.execute!("tenant-read", input);
		return { ok: true, text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n") };
	} catch (error) {
		return { ok: false, text: error instanceof Error ? error.message : String(error) };
	}
}

const library = process.env.LH_LIBRARY_DIR!;
const report = {
	dataDir: process.env.LH_DATA_DIR,
	faa: await run(readTool, { path: path.join(library, "faa", "far-91-103-sample.md") }),
	ntsb: await run(readTool, { path: path.join(library, "ntsb", "sample-report.md") }),
	poh: await run(readTool, { path: path.join(library, "poh", "C172S", "performance-sample.md") }),
	northAero: await run(readTool, { path: path.join(library, "north-aero", "syllabus-sample.md") }),
	roots: await run(lsTool, {}),
	search: await run(grepTool, { pattern: "LIBRARY_[A-Z_]+MARKER" }),
	otherTenant: await run(readTool, { path: process.argv[2] }),
};
process.stdout.write(`REPORT:${JSON.stringify(report)}\n`);
process.exit(0);

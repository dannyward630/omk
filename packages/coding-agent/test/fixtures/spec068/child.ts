// Spec 068 child process: creates one bash spill and one MCP no-session spill, then exits or waits.
// argv[2]: "exit" | "wait" | "persisted"
import { readFileSync, utimesSync } from "node:fs";
import { capMcpContent } from "../../../src/core/mcp/output-cap.ts";
import { registerTempOutputFile, touchRegisteredTempOutputFiles } from "../../../src/core/temp-output-cleanup.ts";
import { OutputAccumulator } from "../../../src/core/tools/output-accumulator.ts";

const mode = process.argv[2] ?? "exit";
// Real startup imports settings-manager.ts (and auth-storage.ts), which statically import proper-lockfile, which
// loads signal-exit 3.0.7 and installs its SIGINT/SIGTERM/SIGHUP listeners on the first lock call.
if (process.env.SPEC068_LOAD_SETTINGS === "1") {
	const { SettingsManager } = await import("../../../src/core/settings-manager.ts");
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "agent-"));
	const sm = SettingsManager.create(dir, dir);
	sm.setTheme?.("dark");
	await sm.flush?.();
	const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => process.listenerCount(sig));
	process.stderr.write(`listeners-after-settings ${JSON.stringify(listeners)}\n`);
}
const persisted = mode === "persisted";
const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${i === 2500 ? "MIDDLE-FACT-068" : "x".repeat(20)}`);
const big = lines.join("\n");

const acc = new OutputAccumulator({
	tempFilePrefix: "omk-bash",
	onTempFileCreated: (path) => registerTempOutputFile(path, { persisted }),
});
acc.append(Buffer.from(big));
acc.finish();
const snap = acc.snapshot({ persistIfTruncated: true });
await acc.closeTempFile();

const capped = capMcpContent([{ type: "text", text: big }], {
	sessionFile: undefined,
	cwd: process.cwd(),
	toolCallId: "c1",
});
const marker = capped.find((b) => b.type === "text" && b.text.startsWith("[MCP output truncated"));
const mcpPath = marker && marker.type === "text" ? /Full output: (\S+) \(/u.exec(marker.text)?.[1] : undefined;
const paths = [snap.fullOutputPath, mcpPath].filter((p): p is string => typeof p === "string");
// Mid-output fact recovery from the spilled files while the process is alive (criterion 2).
const recovered = paths.filter((p) => readFileSync(p, "utf-8").includes("MIDDLE-FACT-068")).length;

if (mode === "wait") {
	// Criterion 7: age the files past 24 h, then the touch tick refreshes them.
	const old = new Date(Date.now() - 48 * 3600 * 1000);
	for (const p of paths) utimesSync(p, old, old);
	touchRegisteredTempOutputFiles();
}
const listenerCounts = ["SIGINT", "SIGTERM", "SIGHUP"].map((sig) => process.listenerCount(sig));
process.stdout.write(`${JSON.stringify({ paths, recovered, listenerCounts })}\n`);
if (mode === "wait") setInterval(() => {}, 1000);

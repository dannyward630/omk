import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ImageContent, TextContent } from "omk-ai";
import { sessionArtifactDir } from "../session-artifacts.ts";
import { defaultTempFilePath } from "../tools/output-accumulator.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type HeadTailTruncationResult,
	truncateHeadTail,
} from "../tools/truncate.ts";

/**
 * Spec 066: MCP text output gets the same 2000-line / 50KB cap as the built-in tools (read/grep), on by default.
 * `OMK_MCP_OUTPUT_CAP=0` restores the uncapped behavior.
 */
export function mcpOutputCapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.OMK_MCP_OUTPUT_CAP !== "0";
}

/** The truncation strategy (Tech Lead: head+tail, so errors at the end survive), isolated in one place. */
export const truncateMcpText = (text: string): HeadTailTruncationResult => truncateHeadTail(text);

export interface McpSpillTarget {
	/** Session file (`.jsonl`); the spill lands in its artifact directory. Undefined for in-memory sessions. */
	readonly sessionFile: string | undefined;
	/** Directory the marker path is relative to (the tool cwd), so the model can `read` it. */
	readonly cwd: string;
	readonly toolCallId: string;
}

/** No session file (`--no-session`): same temp dir, name convention and 0600 mode as bash's full output. */
function spillToTemp(full: string): string {
	const file = defaultTempFilePath("omk-mcp");
	writeFileSync(file, full, { encoding: "utf-8", mode: 0o600, flag: "wx" });
	chmodSync(file, 0o600);
	return file;
}

/** Session mode: `<session>.artifacts/`, marker path relative to cwd. No session: a temp file, absolute path. */
function spill(full: string, resolveTarget: () => McpSpillTarget): string | undefined {
	try {
		const target = resolveTarget();
		if (!target.sessionFile) return spillToTemp(full);
		const dir = sessionArtifactDir(target.sessionFile);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const file = join(dir, `mcp-${target.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "_")}.txt`);
		writeFileSync(file, full, { encoding: "utf-8", mode: 0o600 });
		chmodSync(file, 0o600);
		return relative(target.cwd, file);
	} catch {
		return undefined;
	}
}

/**
 * Cap the text blocks of one MCP result (combined, joined by newlines). Returns `content` itself when nothing is cut,
 * so small outputs stay byte-identical. A target function is only called when output is cut. When cut, text becomes head, one marker at the cut, then tail (≤ 50KB / 2000
 * lines together); image blocks follow in their original order.
 */
export function capMcpContent(
	content: (TextContent | ImageContent)[],
	target: McpSpillTarget | (() => McpSpillTarget),
): (TextContent | ImageContent)[] {
	const texts = content.filter((block): block is TextContent => block.type === "text");
	if (texts.length === 0) return content;
	const full = texts.map((block) => block.text).join("\n");
	const cut = truncateMcpText(full);
	if (!cut.truncated) return content;
	const path = spill(full, typeof target === "function" ? target : () => target);
	const where = path
		? `Full output: ${path} (use read with offset/limit to see the middle).`
		: "Full output could not be saved.";
	const marker =
		`[MCP output truncated: kept the start and the end; cut ${cut.omittedLines} of ${cut.totalLines} lines ` +
		`(${formatSize(cut.omittedBytes)} of ${formatSize(cut.totalBytes)}) from the middle ` +
		`(${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)} limit). ${where}]`;
	return [
		{ type: "text", text: cut.head },
		{ type: "text", text: marker },
		{ type: "text", text: cut.tail },
		...content.filter((block) => block.type !== "text"),
	];
}

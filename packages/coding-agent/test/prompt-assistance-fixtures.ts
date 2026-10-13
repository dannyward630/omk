import type { StreamFn } from "omk-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "omk-ai";
import { vi } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { PromptAssistance } from "../src/modes/interactive/prompt-assistance.ts";

const catalog: Skill[] = [
	{
		name: "debugging",
		description: "Debug parser bugs and errors",
		disableModelInvocation: false,
		filePath: "/skills/debugging/SKILL.md",
		baseDir: "/skills/debugging",
		sourceInfo: { path: "/skills/debugging/SKILL.md", source: "test", scope: "user", origin: "top-level" },
	},
];
export function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}
export function scenario(suffix = " and verify the result") {
	const streamFn = vi.fn<StreamFn>(() => {
		const stream = createAssistantMessageEventStream();
		stream.end(message(suffix));
		return stream;
	});
	const runtime = {
		model: getModel("openai", "gpt-4o"),
		agent: { streamFn },
		isStreaming: false,
		isCompacting: false,
		sessionId: "s1",
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true as const,
				apiKey: "fixture-key",
				headers: { "X-Test": "fixture" },
			})),
		},
		resourceLoader: { getSkills: () => ({ skills: catalog }) },
	};
	const repaint = vi.fn();
	const assistance = new PromptAssistance(() => runtime, repaint, {});
	return { runtime, streamFn, assistance, repaint };
}

import { createAssistantMessageEventStream } from "omk-ai";
import { CombinedAutocompleteProvider, TUI, visibleWidth } from "omk-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { canAssistDraft, PromptAssistance } from "../src/modes/interactive/prompt-assistance.ts";
import { requestPromptCompletion } from "../src/modes/interactive/prompt-completion-request.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

import { message, scenario } from "./prompt-assistance-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	initTheme("dark");
});
afterEach(() => {
	vi.useRealTimers();
});

describe("automatic skill and prompt preview", () => {
	it("selects guidance locally before the debounced completion request", () => {
		const { assistance, streamFn } = scenario();
		expect(assistance.observe("Debug parser bugs", true).skills).toContain("debugging");
		expect(streamFn).not.toHaveBeenCalled();
		assistance.dispose();
	});

	it("previews a suffix without changing the draft, then accepts exactly once", async () => {
		const { assistance, streamFn, repaint } = scenario();
		assistance.observe("Debug parser bugs", true);
		await vi.advanceTimersByTimeAsync(800);
		expect(streamFn).toHaveBeenCalledOnce();
		expect(repaint).toHaveBeenCalledOnce();
		expect(assistance.observe("Debug parser bugs", true).suffix).toBe(" and verify the result");
		expect(assistance.accept("Debug parser bugs")).toBe("Debug parser bugs and verify the result");
		expect(assistance.accept("Debug parser bugs")).toBeUndefined();
		assistance.dispose();
	});

	it("discards a late response after text changes", async () => {
		const { assistance, streamFn } = scenario();
		const stream = createAssistantMessageEventStream();
		streamFn.mockReturnValue(stream);
		assistance.observe("Debug parser bugs", true);
		await vi.advanceTimersByTimeAsync(800);
		assistance.observe("Different question", true);
		stream.end(message(" stale"));
		await vi.advanceTimersByTimeAsync(0);
		expect(assistance.accept("Different question")).toBeUndefined();
		assistance.dispose();
	});

	it("discards completions when the session, model or focus changes", async () => {
		const { assistance, runtime } = scenario();
		assistance.observe("Debug parser bugs", true);
		await vi.advanceTimersByTimeAsync(800);
		runtime.sessionId = "s2";
		expect(assistance.accept("Debug parser bugs")).toBeUndefined();
		assistance.observe("Debug parser bugs", false);
		expect(assistance.accept("Debug parser bugs")).toBeUndefined();
		assistance.dispose();
	});

	it.each([{ OMK_PROMPT_COMPLETION: "0" }, { OMK_OFFLINE: "true" }])(
		"keeps local routing when remote completion is disabled",
		async (env) => {
			const { runtime, streamFn } = scenario();
			const assistance = new PromptAssistance(
				() => runtime,
				() => {},
				env,
			);
			expect(assistance.observe("Debug parser bugs", true).skills).toContain("debugging");
			await vi.advanceTimersByTimeAsync(20000);
			expect(streamFn).not.toHaveBeenCalled();
			assistance.dispose();
		},
	);

	it("cancels late work on disposal and limits requests to one per ten seconds", async () => {
		const { assistance, streamFn } = scenario();
		assistance.observe("Debug parser bugs", true);
		await vi.advanceTimersByTimeAsync(800);
		assistance.observe("Debug parser bugs again", true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(streamFn).toHaveBeenCalledOnce();
		assistance.dispose();
		await vi.advanceTimersByTimeAsync(20000);
		expect(streamFn).toHaveBeenCalledOnce();
		expect(assistance.accept("Debug parser bugs again")).toBeUndefined();
	});

	it("reports a generic completion failure while preserving local selection", async () => {
		const { assistance, streamFn } = scenario();
		streamFn.mockRejectedValueOnce(new Error("private provider error"));
		assistance.observe("Debug parser bugs", true);
		await vi.advanceTimersByTimeAsync(800);
		const view = assistance.observe("Debug parser bugs", true);
		expect(view.failed).toBe(true);
		expect(view.skills).toContain("debugging");
		expect(assistance.accept("Debug parser bugs")).toBeUndefined();
		assistance.dispose();
	});

	it("rechecks streaming state before a delayed provider request starts", async () => {
		const { assistance, runtime, streamFn } = scenario();
		assistance.observe("Debug parser bugs", true);
		runtime.isStreaming = true;
		await vi.advanceTimersByTimeAsync(20000);
		expect(streamFn).not.toHaveBeenCalled();
		assistance.dispose();
	});

	it("enforces the twenty-request lifetime ceiling", async () => {
		const { assistance, streamFn } = scenario();
		for (let index = 0; index < 24; index++) {
			assistance.observe(`Debug parser bug number ${index}`, true);
			await vi.advanceTimersByTimeAsync(10000);
		}
		expect(streamFn).toHaveBeenCalledTimes(20);
		assistance.dispose();
	});

	it("does not show or accept a completion after the cursor leaves the end", async () => {
		const { assistance } = scenario();
		const editor = new CustomEditor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme(), new KeybindingsManager());
		editor.focused = true;
		editor.setPromptAssistance(assistance);
		editor.setText("Debug parser bugs");
		editor.render(80);
		await vi.advanceTimersByTimeAsync(800);
		editor.handleInput("\x1b[D");
		expect(editor.render(80).join("\n")).not.toContain("tab complete");
		expect(assistance.accept(editor.getText())).toBeUndefined();
		assistance.dispose();
	});

	it("keeps slash-menu Tab acceptance ahead of stale prompt completions", async () => {
		const { assistance } = scenario();
		const editor = new CustomEditor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme(), new KeybindingsManager());
		editor.focused = true;
		editor.setPromptAssistance(assistance);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "model" }], "/fixture"));
		editor.setText("Debug parser bugs");
		editor.render(80);
		await vi.advanceTimersByTimeAsync(800);
		editor.setText("");
		editor.handleInput("/mo");
		await vi.advanceTimersByTimeAsync(300);
		editor.handleInput("\t");
		await vi.advanceTimersByTimeAsync(0);
		expect(editor.getText()).toBe("/model ");
		assistance.dispose();
	});

	it("ignores Tab contained in a bracketed paste", async () => {
		const { assistance } = scenario();
		const editor = new CustomEditor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme(), new KeybindingsManager());
		editor.focused = true;
		editor.setPromptAssistance(assistance);
		editor.setText("Debug parser bugs");
		editor.render(80);
		await vi.advanceTimersByTimeAsync(800);
		editor.handleInput("\x1b[200~literal");
		editor.handleInput("\t");
		editor.handleInput("\x1b[201~");
		expect(editor.getText()).not.toContain(" and verify the result");
		assistance.dispose();
	});

	it("preserves path and command completion ownership", () => {
		for (const draft of [
			"/model",
			"! ls",
			"!skill:debugging bug",
			"Review @src/app",
			"Change ./src/",
			"Read /tmp/file",
			"Read C:\\src\\file",
		])
			expect(canAssistDraft(draft)).toBe(false);
		expect(canAssistDraft("Debug the parser bug")).toBe(true);
	});

	it("uses Tab to accept a visible completion but never submits", async () => {
		const { assistance } = scenario();
		const editor = new CustomEditor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme(), new KeybindingsManager());
		editor.focused = true;
		editor.setPromptAssistance(assistance);
		editor.setText("Debug parser bugs");
		editor.render(80);
		await vi.advanceTimersByTimeAsync(800);
		const submit = vi.fn();
		editor.onSubmit = submit;
		expect(editor.render(80).join("\n")).toContain("complete");
		expect(editor.render(10).every((line) => visibleWidth(line) <= 10)).toBe(true);
		editor.handleInput("\t");
		expect(editor.getText()).toBe("Debug parser bugs and verify the result");
		expect(submit).not.toHaveBeenCalled();
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("Debug parser bugs");
		assistance.dispose();
	});
});

describe("isolated completion provider boundary", () => {
	it("uses current auth and makes a tool-free bounded request without session history", async () => {
		const { runtime, streamFn } = scenario();
		expect(await requestPromptCompletion(runtime, "Debug parser bugs", new AbortController().signal)).toBe(
			" and verify the result",
		);
		const call = streamFn.mock.calls[0];
		expect(call?.[1].messages).toHaveLength(1);
		expect(call?.[1].tools).toBeUndefined();
		expect(call?.[2]).toMatchObject({
			maxTokens: 128,
			maxRetries: 0,
			cacheRetention: "none",
			headers: { "X-Test": "fixture" },
		});
	});

	it.each(["\x1b]52;c;payload\x07", "Debug parser bugs duplicated", "x".repeat(321)])(
		"rejects unsafe or repeated suffix %j",
		async (suffix) => {
			const { runtime } = scenario(suffix);
			expect(await requestPromptCompletion(runtime, "Debug parser bugs", new AbortController().signal)).toBe("");
		},
	);

	it("rejects tool-call output without executing a tool", async () => {
		const { runtime, streamFn } = scenario();
		streamFn.mockImplementationOnce(() => {
			const stream = createAssistantMessageEventStream();
			stream.end({
				...message(""),
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "never execute" } }],
			});
			return stream;
		});
		expect(await requestPromptCompletion(runtime, "Debug parser bugs", new AbortController().signal)).toBe("");
	});

	it("does not call an agent-style API for a text preview", async () => {
		const { runtime, streamFn } = scenario();
		const unsupported = { ...runtime, model: { ...runtime.model, api: "cursor-agent" as const } };
		expect(await requestPromptCompletion(unsupported, "Debug parser bugs", new AbortController().signal)).toBe("");
		expect(streamFn).not.toHaveBeenCalled();
	});

	it("does not send credential-shaped drafts to the completion model", async () => {
		const { runtime, streamFn } = scenario();
		await requestPromptCompletion(
			runtime,
			"Use api_key=sk-live-1234567890abcdefghijklmnopqrstuvwxyz",
			new AbortController().signal,
		);
		expect(streamFn).not.toHaveBeenCalled();
	});
});

import { TUI } from "omk-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { scenario } from "./prompt-assistance-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	initTheme("dark");
});
afterEach(() => vi.useRealTimers());
function editorScenario() {
	const fixture = scenario();
	const editor = new CustomEditor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme(), new KeybindingsManager());
	editor.focused = true;
	editor.setPromptAssistance(fixture.assistance);
	editor.setText("Debug parser bugs");
	editor.render(80);
	return { ...fixture, editor };
}

describe("prompt preview acceptance boundaries", () => {
	it("lets Escape dismiss a preview without changing or submitting the question", async () => {
		const { editor, assistance } = editorScenario();
		await vi.advanceTimersByTimeAsync(800);
		expect(editor.render(80).join("\n")).toContain("tab complete");
		editor.handleInput("\x1b");
		expect(editor.render(80).join("\n")).not.toContain("tab complete");
		expect(editor.getText()).toBe("Debug parser bugs");
		assistance.dispose();
	});

	it("Enter submits only actual text, never a ghost suffix", async () => {
		const { editor, assistance } = editorScenario();
		await vi.advanceTimersByTimeAsync(800);
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput("\r");
		expect(submit).toHaveBeenCalledWith("Debug parser bugs");
		assistance.dispose();
	});

	it("renders ghost text inside the prompt without making it editor content", async () => {
		const { editor, assistance } = editorScenario();
		await vi.advanceTimersByTimeAsync(800);
		const lines = editor.render(80);
		expect(lines[1]).toContain("verify the result");
		expect(editor.getText()).toBe("Debug parser bugs");
		assistance.dispose();
	});
});

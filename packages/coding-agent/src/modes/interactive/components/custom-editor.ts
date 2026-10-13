import { Editor, type EditorOptions, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "omk-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { canAssistDraft, type PromptAssistance } from "../prompt-assistance.ts";
import { theme } from "../theme/theme.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private assistance: PromptAssistance | undefined;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	setPromptAssistance(assistance: PromptAssistance | undefined): void {
		this.assistance = assistance;
	}

	private assistanceEligible(): boolean {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return (
			this.focused &&
			!this.isInPaste &&
			!this.isShowingAutocomplete() &&
			cursor.line === lines.length - 1 &&
			cursor.col === lines[cursor.line]?.length &&
			canAssistDraft(this.getText())
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.assistance) return lines;
		const view = this.assistance.observe(this.getExpandedText(), () => this.assistanceEligible());
		if (view.skills.length > 0) {
			const names = stripAnsi(view.skills.join(", ")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
			lines.push(truncateToWidth(theme.fg("dim", `Auto skills: ${names}`), width, ""));
		}
		if (view.failed) lines.push(truncateToWidth(theme.fg("dim", "Prompt completion unavailable"), width, ""));
		if (view.suffix) {
			const key = this.keybindings.getKeys("tui.input.tab").join("/");
			const suffix = stripAnsi(view.suffix).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
			const cursorLine = lines.length - 2 - (view.skills.length > 0 ? 1 : 0) - (view.failed ? 1 : 0);
			const line = lines[cursorLine];
			if (line !== undefined) {
				const content = line.trimEnd();
				lines[cursorLine] =
					content + truncateToWidth(theme.fg("dim", suffix), Math.max(0, width - visibleWidth(content)), "");
			}
			lines.push(truncateToWidth(theme.fg("dim", `${key} complete → ${suffix}`), width, ""));
		}
		return lines;
	}

	handleInput(data: string): void {
		// Pasted control bytes are content, never app shortcuts.
		if (this.isInPaste || data.includes("\x1b[200~")) {
			super.handleInput(data);
			return;
		}
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		if (this.keybindings.matches(data, "app.interrupt") && !this.isShowingAutocomplete() && this.assistance) {
			const view = this.assistance.observe(this.getExpandedText(), () => this.assistanceEligible());
			if (view.suffix) {
				this.assistance.dismiss();
				return;
			}
		}

		if (this.keybindings.matches(data, "tui.input.tab") && this.assistanceEligible()) {
			const completed = this.assistance?.accept(this.getExpandedText());
			if (completed !== undefined) {
				this.setText(completed);
				return;
			}
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}

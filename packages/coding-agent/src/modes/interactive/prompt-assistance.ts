import { previewSkillNames } from "../../core/automatic-skills.ts";
import type { Skill } from "../../core/skills.ts";
import { type PromptCompletionRuntime, requestPromptCompletion } from "./prompt-completion-request.ts";

export interface PromptAssistanceRuntime extends PromptCompletionRuntime {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly sessionId?: string;
	readonly resourceLoader: { getSkills(): { readonly skills: readonly Skill[] } };
}

export interface PromptAssistanceView {
	readonly skills: readonly string[];
	readonly suffix: string;
	readonly failed?: boolean;
}

/** Owns one disposable draft projection, not session messages or persistent activation. */
export class PromptAssistance {
	private draft = "";
	private runtime: PromptAssistanceRuntime | undefined;
	private model: PromptCompletionRuntime["model"];
	private inventory: readonly Skill[] | undefined;
	private names: readonly string[] = [];
	private suffix = "";
	private failed = false;
	private sessionId: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private abort: AbortController | undefined;
	private requestTimer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private requests = 0;
	private running = false;
	private nextRequestAt = 0;
	private disposed = false;
	private eligible: () => boolean = () => false;
	private readonly getRuntime: () => PromptAssistanceRuntime;
	private readonly repaint: () => void;
	private readonly env: Readonly<Record<string, string | undefined>>;

	constructor(getRuntime: () => PromptAssistanceRuntime, repaint: () => void, env = process.env) {
		this.getRuntime = getRuntime;
		this.repaint = repaint;
		this.env = env;
	}

	observe(draft: string, eligible: boolean | (() => boolean)): PromptAssistanceView {
		this.eligible = typeof eligible === "function" ? eligible : () => eligible;
		if (this.disposed) return { skills: [], suffix: "" };
		const runtime = this.getRuntime();
		const inventory = runtime.resourceLoader.getSkills().skills;
		const active = this.eligible() && !runtime.isStreaming && !runtime.isCompacting;
		const text = active ? draft : "";
		if (
			text === this.draft &&
			runtime === this.runtime &&
			runtime.sessionId === this.sessionId &&
			runtime.model === this.model &&
			inventory === this.inventory
		)
			return { skills: this.names, suffix: this.suffix, failed: this.failed };
		this.cancel();
		this.runtime = runtime;
		this.model = runtime.model;
		this.sessionId = runtime.sessionId;
		this.inventory = inventory;
		this.draft = text;
		this.names = previewSkillNames(text, inventory, { provider: runtime.model?.provider, env: this.env });
		const completionEnabled = !["0", "false", "off", "no"].includes(
			this.env.OMK_PROMPT_COMPLETION?.trim().toLowerCase() ?? "",
		);
		if (
			completionEnabled &&
			text.trim().length >= 12 &&
			text.length <= 4096 &&
			runtime.model &&
			this.requests < 20 &&
			!["1", "true", "on", "yes"].includes(this.env.OMK_OFFLINE?.trim().toLowerCase() ?? "")
		) {
			const generation = this.generation;
			const delay = Math.max(800, this.nextRequestAt - Date.now());
			this.timer = setTimeout(() => {
				void this.complete(generation, runtime, text);
			}, delay);
		}
		return { skills: this.names, suffix: "" };
	}

	accept(draft: string): string | undefined {
		const runtime = this.getRuntime();
		if (
			this.disposed ||
			!this.eligible() ||
			draft !== this.draft ||
			runtime !== this.runtime ||
			runtime.sessionId !== this.sessionId ||
			runtime.model !== this.model ||
			runtime.resourceLoader.getSkills().skills !== this.inventory ||
			runtime.isStreaming ||
			runtime.isCompacting ||
			!this.suffix
		)
			return undefined;
		const completed = draft + this.suffix;
		this.cancel();
		this.draft = completed;
		this.names = previewSkillNames(completed, this.inventory ?? [], {
			provider: runtime.model?.provider,
			env: this.env,
		});
		return completed;
	}

	private async complete(generation: number, runtime: PromptAssistanceRuntime, draft: string): Promise<void> {
		this.timer = undefined;
		if (
			this.running ||
			this.disposed ||
			!this.eligible() ||
			generation !== this.generation ||
			runtime !== this.getRuntime() ||
			runtime.sessionId !== this.sessionId ||
			runtime.model !== this.model ||
			runtime.isStreaming ||
			runtime.isCompacting
		)
			return;
		const abort = new AbortController();
		this.abort = abort;
		const timeout = setTimeout(() => abort.abort(), 8000);
		this.requestTimer = timeout;
		timeout.unref?.();
		this.running = true;
		this.requests++;
		this.nextRequestAt = Date.now() + 10000;
		try {
			const suffix = await requestPromptCompletion(runtime, draft, abort.signal);
			if (
				!this.eligible() ||
				generation !== this.generation ||
				abort.signal.aborted ||
				this.disposed ||
				runtime !== this.getRuntime() ||
				runtime.sessionId !== this.sessionId ||
				runtime.model !== this.model ||
				runtime.resourceLoader.getSkills().skills !== this.inventory ||
				runtime.isStreaming ||
				runtime.isCompacting
			)
				return;
			this.suffix = suffix;
			this.repaint();
		} catch {
			// This optional provider boundary reports failure without leaking raw errors or changing the draft.
			if (generation === this.generation && !this.disposed && !abort.signal.aborted) {
				this.failed = true;
				this.repaint();
			}
		} finally {
			clearTimeout(timeout);
			if (this.requestTimer === timeout) this.requestTimer = undefined;
			this.running = false;
			if (this.abort === abort) this.abort = undefined;
		}
	}

	private cancel(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.abort?.abort();
		this.abort = undefined;
		if (this.requestTimer) clearTimeout(this.requestTimer);
		this.requestTimer = undefined;
		this.suffix = "";
		this.failed = false;
	}

	dismiss(): void {
		this.cancel();
		this.repaint();
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
		this.names = [];
	}
}

/** Commands, paths and explicit invocations retain existing completion ownership. */
export function canAssistDraft(text: string): boolean {
	return text.trim().length > 0 && !/^[!/]/u.test(text.trimStart()) && !/(?:^|\s)(?:[@#]\S*|\S*[\\/]\S*)$/u.test(text);
}

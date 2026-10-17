// Minimal types for signal-exit 3.x (CommonJS, `module.exports = function onExit`). Only what spec 068 uses;
// avoids @types/signal-exit, which would add a lockfile package.
declare module "signal-exit" {
	/** Runs `callback` on process exit or on a signal signal-exit handles; returns a remover. */
	function onExit(
		callback: (code: number | null, signal: NodeJS.Signals | null) => void,
		options?: { alwaysLast?: boolean },
	): () => void;
	export = onExit;
}

/**
 * Spec 057 R9-R11: provider ownership and the internal loaded-extension list.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	deriveLoadedExtensionName,
	LOADED_EXTENSIONS_SYMBOL,
	type LoadedExtensionInfo,
	type LoadedExtensionsAccessor,
} from "../src/core/extensions/internal-loaded-extensions.ts";
import { loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionAPI,
	ExtensionContextActions,
	ProviderConfig,
} from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const APIS_KEY = "__omk057ProviderOwnerApis";

const providerConfig: ProviderConfig = {
	baseUrl: "https://provider.test/v1",
	apiKey: "provider-test-key",
	api: "openai-completions",
	models: [
		{
			id: "owned-model",
			name: "Owned Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		},
	],
};

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

/** Fixture extension source: runs `body`, then keeps its API object for the test under `name`. */
function fixtureSource(name: string, body: string): string {
	return `
		export default function (omk) {
			${body}
			globalThis.${APIS_KEY} ??= {};
			globalThis.${APIS_KEY}[${JSON.stringify(name)}] = omk;
		}
	`;
}

function apiOf(name: string): ExtensionAPI {
	const apis = (globalThis as unknown as Record<string, Record<string, ExtensionAPI> | undefined>)[APIS_KEY];
	const api = apis?.[name];
	if (!api) throw new Error(`fixture ${name} did not load`);
	return api;
}

function listFrom(api: ExtensionAPI): ReadonlyArray<LoadedExtensionInfo> {
	const accessor = (api as unknown as Record<symbol, LoadedExtensionsAccessor | undefined>)[LOADED_EXTENSIONS_SYMBOL];
	if (typeof accessor !== "function") throw new Error("internal accessor missing");
	return accessor();
}

function entry(list: ReadonlyArray<LoadedExtensionInfo>, name: string): LoadedExtensionInfo {
	const found = list.find((item) => item.name === name);
	if (!found) throw new Error(`${name} not listed: ${list.map((item) => item.name).join(", ")}`);
	return found;
}

describe("spec 057: provider owners and the internal loaded-extension list", () => {
	let tempDir: string;
	let paths: Record<"owner" | "hook" | "proxy", string>;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-057-provider-owners-"));
		const config = JSON.stringify(providerConfig);
		paths = {
			owner: path.join(tempDir, "ext-owner.ts"),
			hook: path.join(tempDir, "ext-hook.ts"),
			proxy: path.join(tempDir, "ext-proxy.ts"),
		};
		fs.writeFileSync(paths.owner, fixtureSource("ext-owner", `omk.registerProvider("owned-provider", ${config});`));
		fs.writeFileSync(
			paths.hook,
			fixtureSource(
				"ext-hook",
				`omk.on("turn_end", async () => undefined); omk.on("before_provider_request", async () => undefined);`,
			),
		);
		fs.writeFileSync(
			paths.proxy,
			fixtureSource(
				"ext-proxy",
				`omk.registerProvider("anthropic", { baseUrl: "https://proxy.test", headers: { "x-proxy": "1" } });`,
			),
		);
		modelRegistry = ModelRegistry.create(AuthStorage.create(path.join(tempDir, "auth.json")));
	});

	afterEach(() => {
		delete (globalThis as unknown as Record<string, unknown>)[APIS_KEY];
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function loadAll() {
		return loadExtensions([paths.owner, paths.hook, paths.proxy], tempDir);
	}

	it("lists the owner of a provider registered at load and again after bind", async () => {
		const result = await loadAll();
		expect(result.errors).toEqual([]);
		expect(entry(listFrom(apiOf("ext-owner")), "ext-owner")).toMatchObject({
			path: paths.owner,
			resolvedPath: paths.owner,
			providers: ["owned-provider"],
			hooks: [],
		});

		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			SessionManager.inMemory(),
			modelRegistry,
		);
		runner.bindCore(extensionActions, extensionContextActions);
		apiOf("ext-owner").registerProvider("late-provider", providerConfig);

		expect(modelRegistry.find("late-provider", "owned-model")).toBeDefined();
		expect(entry(listFrom(apiOf("ext-hook")), "ext-owner").providers).toEqual(["late-provider", "owned-provider"]);
		expect(result.runtime.providerOwners.get("late-provider")).toBe(paths.owner);
	});

	it("reports event names with handlers in hooks, sorted", async () => {
		await loadAll();
		const list = listFrom(apiOf("ext-owner"));
		expect(entry(list, "ext-hook").hooks).toEqual(["before_provider_request", "turn_end"]);
		expect(entry(list, "ext-hook").providers).toEqual([]);
	});

	it("counts a baseUrl/headers override of a built-in provider as ownership (R11)", async () => {
		await loadAll();
		expect(entry(listFrom(apiOf("ext-proxy")), "ext-proxy").providers).toEqual(["anthropic"]);
	});

	it("lets only the owner's unregisterProvider clear the owner entry", async () => {
		const result = await loadAll();
		apiOf("ext-hook").unregisterProvider("owned-provider");
		expect(result.runtime.providerOwners.get("owned-provider")).toBe(paths.owner);
		expect(entry(listFrom(apiOf("ext-hook")), "ext-owner").providers).toEqual(["owned-provider"]);

		apiOf("ext-owner").unregisterProvider("owned-provider");
		expect(result.runtime.providerOwners.has("owned-provider")).toBe(false);
		expect(entry(listFrom(apiOf("ext-hook")), "ext-owner").providers).toEqual([]);
	});

	it("starts from a fresh owner map on reload", async () => {
		const first = await loadAll();
		const runner = new ExtensionRunner(
			first.extensions,
			first.runtime,
			tempDir,
			SessionManager.inMemory(),
			modelRegistry,
		);
		runner.bindCore(extensionActions, extensionContextActions);
		apiOf("ext-owner").registerProvider("late-provider", providerConfig);

		const second = await loadAll();
		expect(second.runtime).not.toBe(first.runtime);
		expect(second.runtime.providerOwners.has("late-provider")).toBe(false);
		expect(entry(listFrom(apiOf("ext-owner")), "ext-owner").providers).toEqual(["owned-provider"]);
	});

	it("returns a fresh frozen snapshot that skips built-in and inline extensions", async () => {
		const result = await loadAll();
		const builtin = await loadExtensionFromFactory(
			(omk) => omk.on("before_provider_request", async () => undefined),
			tempDir,
			createEventBus(),
			result.runtime,
			"<builtin:fixture>",
		);
		result.extensions.push(builtin);

		const first = listFrom(apiOf("ext-owner"));
		const second = listFrom(apiOf("ext-owner"));
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first[0])).toBe(true);
		expect(first.map((item) => item.name)).toEqual(["ext-owner", "ext-hook", "ext-proxy"]);
		expect(() => (first as LoadedExtensionInfo[]).pop()).toThrow(TypeError);
		expect(listFrom(apiOf("ext-owner"))).toHaveLength(3);
	});

	it("attaches the accessor as a non-enumerable, read-only symbol property", async () => {
		await loadAll();
		const api = apiOf("ext-owner") as unknown as Record<symbol, unknown>;
		expect(Object.getOwnPropertySymbols(api)).toContain(LOADED_EXTENSIONS_SYMBOL);
		expect(Object.prototype.propertyIsEnumerable.call(api, LOADED_EXTENSIONS_SYMBOL)).toBe(false);
		expect(Object.getOwnPropertySymbols({ ...api })).not.toContain(LOADED_EXTENSIONS_SYMBOL);
		expect(() => {
			api[LOADED_EXTENSIONS_SYMBOL] = () => [];
		}).toThrow(TypeError);
		expect(LOADED_EXTENSIONS_SYMBOL).toBe(Symbol.for("omk.internal.loadedExtensions"));
	});

	it("keeps the list off the public API surface", () => {
		expectTypeOf<Extract<keyof ExtensionAPI, symbol>>().toEqualTypeOf<never>();
		const srcDir = path.join(import.meta.dirname, "..", "src");
		const publicEntries = [
			path.join(srcDir, "index.ts"),
			path.join(srcDir, "core", "extensions", "index.ts"),
			path.join(srcDir, "core", "extensions", "types.ts"),
		];
		for (const file of publicEntries) {
			const text = fs.readFileSync(file, "utf8");
			for (const name of [
				"internal-loaded-extensions",
				"LOADED_EXTENSIONS_SYMBOL",
				"LoadedExtensionInfo",
				"LoadedExtensionsAccessor",
				"omk.internal.loadedExtensions",
			]) {
				expect(text, `${path.basename(file)} mentions ${name}`).not.toContain(name);
			}
		}
	});

	it("derives names per R4.2", () => {
		const named = (resolvedPath: string, source = "local", origin: "package" | "top-level" = "top-level") =>
			deriveLoadedExtensionName({
				path: resolvedPath,
				resolvedPath,
				sourceInfo: createSyntheticSourceInfo(resolvedPath, { source, origin }),
			});
		expect(named("/x/node_modules/@s/a/dist/index.js", "npm:@s/a@1.2.3", "package")).toBe("@s/a");
		expect(named("/x/node_modules/a/index.ts", "npm:a", "package")).toBe("a");
		expect(named("/x/git/host/owner/repo/ext.ts", "git:github.com/owner/repo@v1", "package")).toBe("repo");
		expect(named("/x/git/repo/ext.ts", "https://github.com/owner/repo.git", "package")).toBe("repo");
		expect(named("/home/u/.omk/agent/extensions/memory.ts")).toBe("memory");
		expect(named("/home/u/.omk/agent/extensions/my-mcp-adapter/index.ts")).toBe("my-mcp-adapter");
		expect(named("/home/u/.omk/agent/extensions/tool/index.mjs")).toBe("tool");
	});
});

// Regression: senpi#2514. Sessions outside the RPC host share one MCP service and its server
// connections, yet each session must keep its own binding: its own session ref and tool-search
// service, never the binding of whichever session attached last.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import mcpExtension from "../../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { parseSkillMcpDeclarations, type SkillLike } from "../../../src/core/extensions/builtin/mcp/skills.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../../src/core/extensions/builtin/mcp/startup-race.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import { getToolSearchService } from "../../../src/core/extensions/builtin/tool-search/service.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import type { ExtensionAPI, LoadExtensionsResult } from "../../../src/index.ts";
import { type CapturingPi, capturingPi, registeredTool } from "../../mcp/fixtures/register-call.ts";
import {
	cleanupRoots,
	makeRoot,
	readCounter,
	requiredPid,
	setConfig,
	stdioServer,
	type TestRoot,
} from "../../mcp/fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "../../mcp/fixtures/sharing-http.ts";
import { assertProcessDead, stdioFixtureCommand } from "../../mcp/fixtures/spawn-fixture.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const TOOL = "mcp_fx_tool_1";
const EXTRA_TOOL = "mcp_extra_tool_1";
const REGISTRATION_TIMEOUT_MS = 8_000;

const cleanupTasks: Array<() => Promise<void>> = [];
const open = new Set<Harness>();
const scopes: ProviderScope[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
let root: TestRoot;
let spawnCounter: string;
let catalogGate: string;

function configureServer(extraArgs: readonly string[] = []): void {
	setConfig(root, {
		fx: {
			...stdioServer(["--tools", "2", "--spawn-counter-file", spawnCounter, ...extraArgs]),
			exposure: "search",
			lifecycle: "eager",
		},
	});
}

function configureGatedServer(): void {
	// A zero startup window backgrounds every connect, so the gated catalog lands after both sessions attached.
	vi.stubEnv(MCP_STARTUP_TIMEOUT_ENV, "0");
	configureServer(["--list-tools-gate", catalogGate]);
}

function releaseCatalog(): void {
	writeFileSync(catalogGate, "");
}

/** Declare the `extra` server from a session's own extensions, so only that session's config has it. */
function registerExtraServer(pi: ExtensionAPI): void {
	const fixture = stdioFixtureCommand();
	pi.registerMcpServer("extra", {
		type: "stdio",
		command: fixture.command,
		args: [...fixture.args, "--tools", "1"],
		exposure: "search",
		lifecycle: "eager",
	});
}

function mcpExtensions(onLoad: (pi: ExtensionAPI) => void = () => {}): Promise<LoadExtensionsResult> {
	return createTestExtensionsResult([
		{ path: "<builtin:tool-search>", factory: toolSearchExtension },
		{ path: "<builtin:mcp>", factory: mcpExtension },
		{ path: "/extensions/probe.ts", factory: onLoad },
	]);
}

function reloadableLoader(initial: LoadExtensionsResult): ResourceLoader {
	let current = initial;
	return {
		...createTestResourceLoader(),
		getExtensions: () => current,
		reload: async () => {
			current = await mcpExtensions();
		},
	};
}

async function openSession(extensionsResult?: LoadExtensionsResult): Promise<Harness> {
	const harness = await createHarness({
		resourceLoader: reloadableLoader(extensionsResult ?? (await mcpExtensions())),
	});
	open.add(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function close(harness: Harness): void {
	open.delete(harness);
	harness.cleanup();
}

async function shutDown(harness: Harness, reason: "quit" | "new"): Promise<void> {
	await harness.getExtensionRunner().emit({ type: "session_shutdown", reason });
	close(harness);
}

async function reload(harness: Harness): Promise<void> {
	await harness.session.reload();
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "reload" });
}

function registeredNames(harness: Harness): string[] {
	return harness.session.getAllTools().map(({ name }) => name);
}

function untilToolRegistered(harness: Harness, name: string): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		if (registeredNames(harness).includes(name)) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`${name} never registered in session ${harness.session.sessionId}`));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!registeredNames(harness).includes(name)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

async function callMcpTool(harness: Harness, value: string, tool = TOOL): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(tool, { value }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(`call ${tool}`);
	const result = harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.findLast((message) => message.role === "toolResult" && message.toolName === tool);
	if (result === undefined) throw new Error(`no ${tool} result in session ${harness.session.sessionId}`);
	return getMessageText(result);
}

beforeEach(() => {
	resetMcpServiceForTests();
	root = makeRoot("2514-session-binding", cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	spawnCounter = join(root.agentDir, "spawns.txt");
	catalogGate = join(root.agentDir, "catalog-gate");
});

afterEach(async () => {
	// Quit every session still open, so a session-owned (provider-scoped) service is disposed even
	// when its test failed before its own shutdown.
	for (const harness of [...open]) await shutDown(harness, "quit");
	for (const scope of scopes.splice(0)) scope.close();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	vi.unstubAllEnvs();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	await cleanupRoots(cleanupTasks);
});

describe("senpi#2514: each session binds its own view of the shared MCP service", () => {
	it("shares one server process, yet lands and activates MCP tools in each session's own tool set", async () => {
		// Given: two live sessions attach while the shared server's catalog is still loading.
		configureGatedServer();
		const alpha = await openSession();
		const bravo = await openSession();

		// When: the catalog lands, and the model in the first session calls an MCP tool by name.
		releaseCatalog();
		await untilToolRegistered(alpha, TOOL);
		await untilToolRegistered(bravo, TOOL);
		const result = await callMcpTool(alpha, "from-alpha");

		// Then: one server process serves both, and the activation stays in the session that made it.
		expect(result).toContain("fixture tool_1 value=from-alpha");
		expect(await readCounter(spawnCounter)).toBe(1);
		expect(alpha.session.getActiveToolNames()).toContain(TOOL);
		expect(bravo.session.getActiveToolNames()).not.toContain(TOOL);
		expect(registeredNames(bravo)).toContain(TOOL);
	});

	it("keeps the other session's MCP tools resolving and activating after a session reloads and is replaced", async () => {
		// Given: two live sessions attach while the catalog loads; the second reloads, then is replaced.
		configureGatedServer();
		let alphaApi: ExtensionAPI | undefined;
		const alpha = await openSession(
			await mcpExtensions((pi) => {
				alphaApi = pi;
			}),
		);
		const bravo = await openSession();
		await reload(bravo);
		await shutDown(bravo, "new");

		// When: the catalog lands, and the remaining session calls the MCP tool by name. The call goes
		// through the session's own executeTool: a reload resets the process-wide API providers, which
		// unregisters this harness's faux model.
		releaseCatalog();
		await untilToolRegistered(alpha, TOOL);
		const outcome = await alphaApi?.executeTool(TOOL, { value: "after-replacement" }, { activateInactiveTool: true });
		const result = outcome?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";

		// Then: the call resolves and activates in the remaining session, with no stale-context failure.
		expect(result).toContain("fixture tool_1 value=after-replacement");
		expect(result).not.toMatch(/stale|disposed/);
		expect(alpha.session.getActiveToolNames()).toContain(TOOL);
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("keeps the shared connection serving the remaining session when another session quits", async () => {
		// Given: two live sessions with the shared server connected and its tools registered in both.
		configureServer();
		const alpha = await openSession();
		await untilToolRegistered(alpha, TOOL);
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const service = getMcpService();
		const connection = service.getConnection("fx");
		const pid = connection?.getRootPid();
		const generation = connection?.generation;

		// When: the second session quits the way a closed session does, and the first calls the MCP tool.
		await shutDown(bravo, "quit");
		const result = await callMcpTool(alpha, "after-quit");

		// Then: the call succeeds on the same process and connection generation: no re-spawn, no reconnect.
		expect(result).toContain("fixture tool_1 value=after-quit");
		expect(getMcpService()).toBe(service);
		expect(service.isDisposed()).toBe(false);
		expect(service.getConnection("fx")?.getRootPid()).toBe(pid);
		expect(service.getConnection("fx")?.generation).toBe(generation);
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("keeps a session's MCP tools working after a peer session with a different MCP config attaches (senpi#2597)", async () => {
		// Given: the first session's extensions declare an extra MCP server, so its resolved config differs from a
		// peer that loads without them (an OmO memory sidecar beside the main session), and both declare `fx`.
		configureServer();
		const alpha = await openSession(await mcpExtensions(registerExtraServer));
		await untilToolRegistered(alpha, TOOL);
		await untilToolRegistered(alpha, EXTRA_TOOL);

		// When: the peer attaches to the shared service, then the first session calls both servers' tools.
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const shared = await callMcpTool(alpha, "after-peer");
		const extra = await callMcpTool(alpha, "extra-after-peer", EXTRA_TOOL);

		// Then: the peer's attach neither retired the first session's tools nor tore down the server only it declares.
		expect(shared).toContain("fixture tool_1 value=after-peer");
		expect(extra).toContain("fixture tool_1 value=extra-after-peer");
		expect(registeredNames(bravo)).not.toContain(EXTRA_TOOL);
		expect(await callMcpTool(bravo, "from-bravo")).toContain("fixture tool_1 value=from-bravo");
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("stops a server only a released session declared, while the peer keeps its shared server (senpi#2597)", async () => {
		// Given: the first session alone declares `extra`, and a peer that declares only `fx` attaches after it.
		configureServer();
		const alpha = await openSession(await mcpExtensions(registerExtraServer));
		await untilToolRegistered(alpha, EXTRA_TOOL);
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const service = getMcpService();
		const extraPid = requiredPid(service, "extra");

		// When: the session that declared `extra` quits while the peer stays live.
		await shutDown(alpha, "quit");

		// Then: the server no live session declares is stopped, and the peer's shared server serves on, unrestarted.
		await assertProcessDead(extraPid);
		expect(service.getConnection("extra")).toBeUndefined();
		expect(await callMcpTool(bravo, "after-release")).toContain("fixture tool_1 value=after-release");
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("still gives a provider-scoped (RPC host) session its own service, apart from the shared one", async () => {
		// Given: a classic session on the shared service, and a session loaded inside a provider scope.
		configureServer();
		const classic = await openSession();
		await untilToolRegistered(classic, TOOL);
		const shared = getMcpService();
		const scope = new ProviderScope();
		scopes.push(scope);
		const scopedExtensions = await runWithProviderScope(scope, () => mcpExtensions());
		const scoped = await openSession(scopedExtensions);
		const scopedResult = await callMcpTool(scoped, "scoped");

		// When: the provider-scoped session quits.
		await shutDown(scoped, "quit");
		const result = await callMcpTool(classic, "after-scoped-quit");

		// Then: it ran its own server process and never attached to the shared service, which keeps serving.
		expect(scopedResult).toContain("fixture tool_1 value=scoped");
		expect(await readCounter(spawnCounter)).toBe(2);
		expect(shared.getSnapshot()).toMatchObject({ disposed: false, sessionStartCount: 1 });
		expect(result).toContain("fixture tool_1 value=after-scoped-quit");
	});
});

async function attachFake(pi: CapturingPi): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
}

function untilFakeRegistered(pi: CapturingPi, name: string): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		if (pi.registeredTools.includes(name)) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`${name} never registered`));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!pi.registeredTools.includes(name)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

function nextRegistration(): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("no MCP registration"));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

async function httpServer(): Promise<Awaited<ReturnType<typeof sharingHttpFixture>>> {
	const fixture = await sharingHttpFixture();
	cleanupTasks.push(() => fixture.close());
	setConfig(root, { fx: { type: "http", url: fixture.url, auth: false, lifecycle: "eager" } });
	return fixture;
}

/** Attach two sessions to the http server, then drain the connect's own refresh so later refreshes are the test's. */
async function twoHttpSessions(): Promise<{ alphaPi: CapturingPi; bravoPi: CapturingPi }> {
	const alphaPi = capturingPi();
	const bravoPi = capturingPi();
	await attachFake(alphaPi);
	await attachFake(bravoPi);
	await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
	const drained = nextRegistration();
	getMcpService().getConnection("fx")?.markToolsChanged();
	await drained;
	await untilFakeRegistered(alphaPi, "mcp_fx_echo");
	await untilFakeRegistered(bravoPi, "mcp_fx_echo");
	return { alphaPi, bravoPi };
}

describe("senpi#2514: the shared service keeps sessions apart under concurrency and failure", () => {
	it("gives each session without its own tool-search service a separate fallback service", async () => {
		// Given: two sessions whose extension loads own no tool-search service attach to the shared service.
		configureServer();
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		const alphaSearch = getToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => alphaPi.getActiveTools(),
			setActiveTools: (names) => alphaPi.setActiveTools([...names]),
		});
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		await attachFake(bravoPi);
		await untilFakeRegistered(bravoPi, TOOL);

		// When: the first session's tool search activates an MCP tool.
		const activated = alphaSearch.activateTool(TOOL);

		// Then: the tool is active in that session only.
		expect(activated).toBe(true);
		expect(alphaPi.getActiveTools()).toContain(TOOL);
		expect(bravoPi.getActiveTools()).not.toContain(TOOL);
	});

	it("keeps the shared service alive for a session whose attach is queued when the last bound session quits", async () => {
		// Given: one bound session with the server connected.
		configureServer();
		const service = getMcpService();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		const pid = service.getConnection("fx")?.getRootPid();

		// When: a second session's attach is queued, and the first quits before it binds.
		const bravoPi = capturingPi();
		const bravoAttach = attachFake(bravoPi);
		await service.releaseSession(alphaPi, "quit");
		await bravoAttach;

		// Then: the queued session binds to the live service on the same server process, and its own quit cleans up.
		expect(service.isDisposed()).toBe(false);
		expect(bravoPi.registeredTools).toContain(TOOL);
		expect(service.getConnection("fx")?.getRootPid()).toBe(pid);
		await service.releaseSession(bravoPi, "quit");
		expect(service.getSnapshot()).toMatchObject({ disposed: true, connectionCount: 0 });
		if (pid !== null && pid !== undefined) await assertProcessDead(pid);
	});

	it("refuses a session's earlier MCP tool once that session's own server configuration changes", async () => {
		// Given: a session whose `fx` tool is registered.
		configureServer();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await untilFakeRegistered(alphaPi, TOOL);
		const stale = registeredTool(alphaPi, TOOL);

		// When: its own `fx` configuration changes and it attaches again, as a reload does.
		setConfig(root, {
			fx: {
				...stdioServer(["--tools", "3", "--spawn-counter-file", spawnCounter]),
				exposure: "search",
				lifecycle: "eager",
			},
		});
		await attachFake(alphaPi);
		const result = await Reflect.apply(stale.execute, stale, ["stale", { value: "stale" }, undefined, undefined]);

		// Then: the offer made under the old configuration is refused instead of reaching the replaced server.
		expect(result).toMatchObject({ details: { error: { kind: "unavailable", server: "fx", tool: "tool_1" } } });
	});

	it("refuses an attach to a disposed service instead of opening connections nobody can close", async () => {
		// Given: the shared service was disposed.
		configureServer();
		const service = getMcpService();
		await service.dispose("quit");

		// When / Then: a late attach fails loudly and spawns no server.
		await expect(attachFakeTo(service, capturingPi())).rejects.toThrow(/disposed/);
		expect(service.getSnapshot().connectionCount).toBe(0);
		await expect(readCounter(spawnCounter)).rejects.toThrow();
	});

	it("re-registers a session that attached while a tool-list refresh was in flight", async () => {
		// Given: one session on an http server whose tool list then changes, with the refresh's listing held.
		const fixture = await httpServer();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		const drained = nextRegistration();
		getMcpService().getConnection("fx")?.markToolsChanged();
		await drained;
		const listing = fixture.holdLists();
		await fixture.changeTools("late");
		await listing;

		// When: a second session attaches mid-refresh, then the listing completes.
		const bravoPi = capturingPi();
		await attachFake(bravoPi);
		const refreshed = untilFakeRegistered(bravoPi, "mcp_fx_late");
		fixture.releaseLists();
		await refreshed;

		// Then: both sessions carry the refreshed tool list.
		expect(alphaPi.registeredTools).toContain("mcp_fx_late");
		expect(bravoPi.registeredTools).toContain("mcp_fx_late");
	});

	it("lands a late catalog in the first session when a second session attaches while it is still listing", async () => {
		// Given: an http server whose first tool listing is held, so the first session's connect outlives its startup window.
		vi.stubEnv(MCP_STARTUP_TIMEOUT_ENV, "0");
		const fixture = await httpServer();
		const listing = fixture.holdLists();
		const alphaPi = capturingPi();
		await attachFake(alphaPi);
		await listing;

		// When: a second session attaches while that listing is in flight, then the listing completes.
		const bravoPi = capturingPi();
		await attachFake(bravoPi);
		const alphaRegistered = untilFakeRegistered(alphaPi, "mcp_fx_echo");
		fixture.releaseLists();

		// Then: the first session still gets the server's tools, not only the session that attached last.
		await alphaRegistered;
		expect(alphaPi.registeredTools).toContain("mcp_fx_echo");
	});

	it("disposes the service when the only session quits before its own attach finishes", async () => {
		// Given: a session whose attach is still in progress.
		configureServer();
		const service = getMcpService();
		const alphaPi = capturingPi();
		const attach = attachFake(alphaPi);

		// When: it quits before the attach settles (a short-lived child that finishes immediately).
		await service.releaseSession(alphaPi, "quit");
		await attach.catch(() => undefined);
		await service.whenAttachSettled(REGISTRATION_TIMEOUT_MS);

		// Then: no session is left, so the service and its server process are released, not leaked.
		const pid = service.getConnection("fx")?.getRootPid();
		expect(service.getSnapshot()).toMatchObject({ disposed: true, connectionCount: 0 });
		if (pid !== null && pid !== undefined) await assertProcessDead(pid);
	});

	it("still delivers a refreshed tool list to the other sessions when one session's registration throws", async () => {
		// Given: two sessions on an http server, the first of which can no longer register tools.
		const fixture = await httpServer();
		const { alphaPi, bravoPi } = await twoHttpSessions();
		alphaPi.registerTool = () => {
			throw new Error("alpha's tool registry is broken");
		};

		// When: the server's tool list changes.
		const refreshed = untilFakeRegistered(bravoPi, "mcp_fx_late");
		await fixture.changeTools("late");

		// Then: the second session still receives the new tool.
		await refreshed;
		expect(bravoPi.registeredTools).toContain("mcp_fx_late");
		expect(alphaPi.registeredTools).not.toContain("mcp_fx_late");
	});
});

const SECRET_EXPR = "$" + "{SENPI_2986_SECRET}";

/** A skill whose sidecar declares `server` with a `${VAR}` in its stdio env. */
function skillDeclaring(name: string, scope: "user" | "project", server: string): SkillLike {
	const baseDir = join(root.cwd, "skills", name);
	mkdirSync(baseDir, { recursive: true });
	const filePath = join(baseDir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: test skill\n---\n\nBody.\n`);
	const raw = { ...stdioServer(["--tools", "1"]), env: { SENPI_2986_SECRET: SECRET_EXPR } };
	writeFileSync(join(baseDir, "mcp.json"), JSON.stringify({ [server]: raw }));
	return { baseDir, filePath, name, sourceInfo: { scope } };
}

async function attachAs(pi: CapturingPi, session: TestRoot, trusted: boolean, secret: string): Promise<void> {
	await getMcpService().attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: session.cwd, isProjectTrusted: () => trusted },
		pi,
		{ agentDir: session.agentDir, env: { SENPI_2986_SECRET: secret } },
	);
}

describe("senpi#2986: a session's skill servers follow its own trust, env and agent dir", () => {
	it("keeps an untrusted session's project skill server literal after a trusted peer attaches", async () => {
		// Given: an untrusted session, then a trusted peer with its own environment and agent dir attaching after it.
		setConfig(root, {});
		const peerRoot = makeRoot("2986-trusted-peer", cleanupTasks);
		setConfig(peerRoot, {});
		const alphaPi = capturingPi();
		await attachAs(alphaPi, root, false, "alpha-secret");
		await attachAs(capturingPi(), peerRoot, true, "peer-secret");

		// When: the untrusted session's skills declare a project-scoped and a user-scoped server.
		const skills = [skillDeclaring("cloned", "project", "fxp"), skillDeclaring("own", "user", "fxu")];
		const warnings = await getMcpService().attachSkillMcpServers(parseSkillMcpDeclarations(skills).servers, alphaPi);

		// Then: the project skill stays literal under the declaring session's trust, the user skill expands from that
		// session's env, and the servers' credentials resolve in its agent dir, never the trusted peer's.
		const service = getMcpService();
		expect(warnings).toEqual([expect.stringContaining("trust the project")]);
		expect(service.getAuthTarget("fxp")?.config.env).toEqual({ SENPI_2986_SECRET: SECRET_EXPR });
		expect(service.getAuthTarget("fxu")?.config.env).toEqual({ SENPI_2986_SECRET: "alpha-secret" });
		expect(service.getAuthTarget("fxu")).toMatchObject({
			agentDir: root.agentDir,
			env: { SENPI_2986_SECRET: "alpha-secret" },
		});
	});

	it("never offers a session a shared connection that carries a peer's credentials", async () => {
		// Given: an http server whose bearer token comes from each session's own env, and a session holding the
		// connection made with its token.
		const fixture = await sharingHttpFixture();
		cleanupTasks.push(() => fixture.close());
		setConfig(root, {
			fx: { type: "http", url: fixture.url, auth: "bearer", bearerTokenEnv: "SENPI_2986_TOKEN", lifecycle: "eager" },
		});
		const alphaPi = capturingPi();
		const bravoPi = capturingPi();
		const attachWithToken = (pi: CapturingPi, token: string) =>
			getMcpService().attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true },
				pi,
				{ agentDir: root.agentDir, env: { SENPI_2986_TOKEN: token } },
			);
		await attachWithToken(alphaPi, "alpha-token");
		await untilFakeRegistered(alphaPi, "mcp_fx_echo");

		// When: a peer declaring the same server with the same config but its own token attaches, and both call it.
		await attachWithToken(bravoPi, "bravo-token");
		await getMcpService().whenAttachSettled(REGISTRATION_TIMEOUT_MS);
		await untilFakeRegistered(bravoPi, "mcp_fx_echo");
		const alphaTool = registeredTool(alphaPi, "mcp_fx_echo");
		const bravoTool = registeredTool(bravoPi, "mcp_fx_echo");
		const alphaResult = await Reflect.apply(alphaTool.execute, alphaTool, [
			"a",
			{ value: "a" },
			undefined,
			undefined,
		]);
		const bravoResult = await Reflect.apply(bravoTool.execute, bravoTool, [
			"b",
			{ value: "b" },
			undefined,
			undefined,
		]);

		// Then: the first session is refused instead of riding on the peer's token; the peer's own call goes through.
		expect(alphaResult).toMatchObject({ details: { error: { kind: "unavailable", server: "fx", tool: "echo" } } });
		expect(bravoResult).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ value: "b" }) }] });
		expect(fixture.callAuthorizations).toEqual(["Bearer bravo-token"]);
	});
});

async function attachFakeTo(service: ReturnType<typeof getMcpService>, pi: CapturingPi): Promise<void> {
	await service.attachSession(
		{ type: "session_start", reason: "startup" },
		{ cwd: root.cwd, isProjectTrusted: () => true },
		pi,
		{ agentDir: root.agentDir },
	);
}

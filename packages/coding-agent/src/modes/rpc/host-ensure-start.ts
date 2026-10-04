/** Starting a fresh generation for `ensureHost`: settings first, then the supervisor, its pidfile, its readiness. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { type DaemonPidFile, readProcessStartTime, waitForStartTime } from "../app-server/daemon/process.ts";
import type { HostDaemonPaths } from "./host-daemon-paths.ts";
import { clearHostRegistration, writeHostRegistration } from "./host-daemon-registration.ts";
import { writeHostSettings } from "./host-daemon-state.ts";
import { HOST_PROTOCOL_VERSION, REQUIRED_HOST_CAPABILITIES } from "./host-decision.ts";
import { hostChildArgv, isCompatible } from "./host-ensure-client.ts";
import { delay, isNodeErrorCode, stopSpawnedChild } from "./host-ensure-stop.ts";
import type { EnsuredHost, EnsureHostOptions } from "./host-ensure-types.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle.ts";
import { type ChildExit, pollProtocolInfo } from "./host-readiness.ts";
import { initialHostEnvironment } from "./host-spawn-environment.ts";
import { hostLaunchProfile } from "./protocol-identity.ts";
import { createSocketSecret, socketSecretPath } from "./socket-transport.ts";

export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/**
 * `generation` is 0 for a fresh endpoint; a start that leaves a stranded generation running beside
 * the new one numbers it after that generation, as a handoff would.
 */
export async function startHost(
	paths: HostDaemonPaths,
	socket: string,
	options: EnsureHostOptions,
	generation = 0,
): Promise<EnsuredHost> {
	const testOptions = options._test;
	// The generation this ensure is about to spawn, chosen HERE so its directory exists before the
	// host boots and the pointer can name it the moment the host is registered.
	const instanceId = randomUUID();
	// The settings file must exist before the supervisor reads it at boot, so it
	// records the policy before the spawn instead of beside the pidfile.
	if (process.platform === "win32") await createSocketSecret(socketSecretPath(socket));
	await writeHostSettings(paths, {
		socket,
		capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
		coldStart: options.policy?.coldStart ?? "transient",
		idleExitMs: options.policy?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		generation,
		instanceId,
	});
	// A stranded generation is still writing its diagnostics here; only a fresh endpoint starts over.
	const stderr = await open(paths.stderrLog, generation === 0 ? "w" : "a", 0o600);
	let pidFile: DaemonPidFile | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let exitedEarly: ChildExit | undefined;
	let childExit: Promise<ChildExit> | undefined;
	try {
		const supervisorArgs = ["--socket", socket, ...(options.hostArgs ?? [])];
		const launch = testOptions?.spawn ?? testOptions?.launch?.(supervisorArgs) ?? defaultHostLaunch(supervisorArgs);
		child = spawn(launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: initialHostEnvironment({
				agentDir: options.agentDir,
				env: options.env,
				paths,
				instanceId,
				generation,
			}),
			stdio: ["ignore", "ignore", stderr.fd],
		});
		childExit = new Promise((resolveExit) => {
			child!.once("exit", (code, signal) => {
				exitedEarly = { code, signal };
				resolveExit(exitedEarly);
			});
		});
		if (child.pid === undefined) throw new Error("failed to spawn RPC socket host");
		const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
		const observedStartTime = await Promise.race([
			waitForStartTime(child.pid, 10_000, probe),
			childExit.then(() => {
				throw new Error("RPC socket host exited before its start time could be read");
			}),
		]);
		// UNKNOWN identity on a live child: the probe was starved, not the host. Give the CIM table
		// one unhurried read (the per-attempt win32 default is 1s, which a loaded runner exceeds on
		// every attempt) before deciding.
		const unhurriedProbe = testOptions?.readProcessStartTime
			? testOptions.readProcessStartTime
			: (pid: number) => readProcessStartTime(pid, process.platform, 15_000);
		const processStartTime = observedStartTime ?? (await unhurriedProbe(child.pid).catch(() => undefined));
		// Still unreadable: the host is ours, alive, and about to prove itself on the socket, so it is
		// registered WITHOUT an ownership guard instead of being torn down for a starved probe. A
		// guard-less record never claims ownership and never authorizes a signal - every later caller
		// reads it as unknown - so the worst case is a fresh host next time, not a killed healthy one.
		pidFile = { pid: child.pid, processStartTime: processStartTime ?? null };
		await testOptions?.beforePidFileWrite?.();
		await writeHostRegistration(paths, {
			record: pidFile,
			socket,
			instanceId,
			generation,
			launchProfileId: hostLaunchProfile(hostChildArgv(options.hostArgs ?? []), process.cwd()).profile_id,
			build: engineBuildIdentity(),
		});
		child.unref();
	} catch (error: unknown) {
		// Whether the child died on its own decides which diagnostic is true, and the
		// cleanup kill below records an `exitedEarly` indistinguishable from a real
		// self-exit. Latch it before killing, or the catch reports the SIGTERM it is
		// about to send and discards the actual startup failure.
		const exitedBeforeCleanup = exitedEarly;
		// Keep the ChildProcess handle owned until registration succeeds. If startup
		// fails before the pidfile is written, terminate this exact child through
		// its still-attached handle rather than leaving an unmanaged daemon behind.
		if (!exitedBeforeCleanup && child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {}
			if (childExit) await Promise.race([childExit, delay(2_000)]);
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		}
		if (!exitedBeforeCleanup) {
			await clearHostRegistration(paths);
			throw error;
		}
		const diagnostic = await appendStderr(
			paths,
			`RPC socket host exited with code ${exitedBeforeCleanup.code ?? "null"}${exitedBeforeCleanup.signal ? ` (${exitedBeforeCleanup.signal})` : ""} before answering get_protocol_info`,
		);
		await clearHostRegistration(paths);
		throw new Error(diagnostic);
	} finally {
		await stderr.close();
	}
	const readinessTimeoutMs = testOptions?.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const result = await pollProtocolInfo(socket, readinessTimeoutMs, isCompatible, childExit);
	if (result.ready) return { pid: pidFile.pid, socket, reused: false, release: result.hold.release };
	// Teardown runs for the diagnostic's sake, so it must never replace it: a stop
	// failure here (unreadable identity, a host that outlives SIGKILL) would other-
	// wise propagate instead of the readiness message and skip cleanupState below,
	// leaving the pidfile and socket behind. Record it and keep going.
	// This child is ours and its handle is still attached: stop it through the handle.
	// Validating ownership through the pidfile would re-run the identity probe whose
	// failure is the very thing a loaded runner produces here.
	const stopFailure = await stopSpawnedChild(
		child,
		childExit,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
	).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	const message = result.protocol
		? `RPC socket host answered get_protocol_info with protocolVersion ${result.protocol.protocolVersion}, serverVersion ${result.protocol.serverVersion} and capabilities ${JSON.stringify(result.protocol.capabilities)}, but is incompatible with protocol version ${HOST_PROTOCOL_VERSION} and required capabilities ${JSON.stringify(REQUIRED_HOST_CAPABILITIES)}`
		: result.exited
			? `RPC socket host exited with code ${result.exited.code ?? "null"}${result.exited.signal ? ` (${result.exited.signal})` : ""} before answering get_protocol_info`
			: `spawned RPC socket host did not answer get_protocol_info within ${readinessTimeoutMs}ms`;
	const diagnostic = await appendStderr(
		paths,
		stopFailure === undefined ? message : `${message} (teardown also reported: ${stopFailure})`,
	);
	await clearHostRegistration(paths);
	// The supervisor may have failed before binding, or another owner may have
	// appeared while readiness was being checked. Never unlink an endpoint we
	// cannot prove this start owned.
	throw new Error(diagnostic);
}

export async function appendStderr(paths: HostDaemonPaths, message: string): Promise<string> {
	try {
		const stderr = (await readFile(paths.stderrLog, "utf8")).trim();
		return stderr ? `${message}\n${stderr}` : message;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return message;
		throw error;
	}
}

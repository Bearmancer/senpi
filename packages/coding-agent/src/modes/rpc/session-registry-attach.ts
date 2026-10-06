/**
 * Attach-on-open: a live session outlives individual client attachments, so a resume (or a second
 * surface) for an already-hosted path joins the existing runtime instead of failing. An entry still
 * opening keeps the exclusive reservation and rejects as before.
 */
import {
	invalidPermissionPresetMessage,
	parsePermissionPresetFlag,
} from "../../core/extensions/builtin/permission-system/cli.ts";
import type { SessionPathReservations } from "./host-reservations.ts";
import {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
} from "./session-registry-types.ts";

/**
 * An attach that names a permission preset the engine does not know is refused before it changes
 * anything, so the live session keeps the preset it enforces.
 */
export function assertAttachPermissionPreset(preset: string | undefined): void {
	if (preset !== undefined && parsePermissionPresetFlag(preset) === undefined)
		throw new RpcSessionRegistryError("open_failed", invalidPermissionPresetMessage(preset));
}

export async function attachToOpenSession(
	entries: ReadonlyMap<string, RpcSessionEntry>,
	sessionPath: string,
	profile: RpcSessionLaunchProfile,
	options: RpcSessionOpenOptions | undefined,
	pathReservations: SessionPathReservations | undefined,
	now: number,
): Promise<OpenRpcSession> {
	const existing = [...entries].find(([, entry]) => entry.reservationKey === sessionPath && entry.state === "open");
	if (!existing) throw new RpcSessionRegistryError("session_path_in_use");
	const [handle, entry] = existing;
	assertAttachPermissionPreset(profile.permissionPreset);
	const wasParked = entry.retainOnDisconnect === true && entry.attachments === 0;
	entry.attachments += 1;
	entry.detachedAt = undefined;
	// The claim carries the attachment state another generation decides on: a path this host is
	// actively serving a client on is never reclaimable from it.
	pathReservations?.setAttached(sessionPath, true);
	// Retention is a property of the live session: any attach may ask for it, and
	// no attach may revoke it for the clients that already rely on it.
	if (options?.retainOnDisconnect) entry.retainOnDisconnect = true;
	if (!entry.durableSessionId) throw new RpcSessionRegistryError("session_path_in_use");
	// The surface, browser engine and permission preset follow the client: an attach that names one
	// moves the live session to it; an attach without one keeps what the session has.
	if (profile.promptSurface !== undefined && profile.promptSurface !== entry.profile.promptSurface) {
		entry.profile = frozenProfile({ ...entry.profile, promptSurface: profile.promptSurface });
		entry.runtime?.setPromptSurface(profile.promptSurface);
	}
	if (profile.browserEngine !== undefined && profile.browserEngine !== entry.profile.browserEngine) {
		entry.profile = frozenProfile({ ...entry.profile, browserEngine: profile.browserEngine });
		entry.runtime?.setBrowserEngine(profile.browserEngine);
	}
	if (profile.permissionPreset !== undefined && profile.permissionPreset !== entry.profile.permissionPreset) {
		entry.profile = frozenProfile({ ...entry.profile, permissionPreset: profile.permissionPreset });
		entry.runtime?.setPermissionPreset(profile.permissionPreset);
	}
	entry.lastCommandAt = now;
	if (wasParked) {
		entry.lifecycleMutex = entry.lifecycleMutex.then(() => entry.runtime?.emitAttachmentEvent("session_resumed"));
		await entry.lifecycleMutex;
	}
	return {
		sessionId: handle,
		durableSessionId: entry.durableSessionId,
		sessionPath: entry.sessionPath,
		attached: true,
	};
}

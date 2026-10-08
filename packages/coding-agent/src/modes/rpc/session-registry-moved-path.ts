import { existsSync } from "node:fs";
import { resolveMovedPath } from "../../core/extensions/builtin/moved-path-guard/resolve.ts";
import { type RpcSessionLaunchProfile, RpcSessionRegistryError } from "./session-registry-types.ts";

/**
 * The launch profile with paths the OmO desktop moved resolved to where they live now (senpi#2898), taken before
 * the reservation so an old spelling of a moved file is the same session. The result is validated like the request,
 * and a moved session file that is gone is reported where it should be, never re-created there.
 */
export function resolveMovedProfile(
	requested: RpcSessionLaunchProfile,
	validate: (profile: RpcSessionLaunchProfile) => void,
): RpcSessionLaunchProfile {
	const profile: RpcSessionLaunchProfile = {
		...requested,
		cwd: resolveMovedPath(requested.cwd),
		...(requested.sessionPath ? { sessionPath: resolveMovedPath(requested.sessionPath) } : {}),
	};
	validate(profile);
	if (profile.sessionPath !== requested.sessionPath && profile.sessionPath && !existsSync(profile.sessionPath))
		throw new RpcSessionRegistryError("open_failed", `moved session file does not exist: ${profile.sessionPath}`);
	return profile;
}

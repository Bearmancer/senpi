/**
 * Vendored contract: the ownership marker `omo-desktop-home.json` the OmO desktop writes in every data home it
 * owns (omo-desktop-app `packages/contracts/src/desktopDataHome.ts`, plan section 2). A breadcrumb is trusted only
 * when the home it points at carries this marker with the same `homeId` (senpi#2898).
 */
export const DESKTOP_HOME_MARKER_FILE = "omo-desktop-home.json";

export function parseDesktopHomeId(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	if (record.kind !== "omo-desktop-data-home" || record.appId !== "com.omo.desktop" || record.schemaVersion !== 1)
		return undefined;
	return typeof record.homeId === "string" && record.homeId.length > 0 ? record.homeId : undefined;
}

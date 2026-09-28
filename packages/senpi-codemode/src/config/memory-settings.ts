import type { Static } from "typebox";
import { Type } from "typebox";
import type { CodemodeSettings, Environment } from "./settings.ts";

export const DEFAULT_RETAINED_RESULTS_MB = 32;
export const DEFAULT_RETAINED_IMAGES_MB = 256;

export const RETAINED_RESULTS_ENVIRONMENT_FLAG = "SENPI_CODEMODE_RETAINED_RESULTS_MB";
export const RETAINED_IMAGES_ENVIRONMENT_FLAG = "SENPI_CODEMODE_RETAINED_IMAGES_MB";

export const codemodeMemorySettingsSchema = Type.Object(
	{
		retainedResultsMb: Type.Optional(Type.Number({ minimum: 0 })),
		retainedImagesMb: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

export interface CodemodeMemorySettings {
	/** In-memory byte budget (MiB) for settled-cell snapshots kept for `peek`/`list`; 0 keeps only the count cap. */
	readonly retainedResultsMb: number;
	/** Disk budget (MiB) for settled-cell images spilled under the session artifacts dir; 0 keeps only the count cap. */
	readonly retainedImagesMb: number;
}

export const defaultMemorySettings: CodemodeMemorySettings = {
	retainedResultsMb: DEFAULT_RETAINED_RESULTS_MB,
	retainedImagesMb: DEFAULT_RETAINED_IMAGES_MB,
};

export function mergeMemorySettings(
	input: Static<typeof codemodeMemorySettingsSchema> | undefined,
): CodemodeMemorySettings {
	return {
		retainedResultsMb: input?.retainedResultsMb ?? defaultMemorySettings.retainedResultsMb,
		retainedImagesMb: input?.retainedImagesMb ?? defaultMemorySettings.retainedImagesMb,
	};
}

/** Settled-cell in-memory snapshot byte budget; the environment override accepts 0 (count cap only). */
export function resolveRetainedResultsBytes(settings: CodemodeSettings, env: Environment = process.env): number {
	const megabytes =
		nonNegativeIntegerOverride(env[RETAINED_RESULTS_ENVIRONMENT_FLAG]) ??
		settings.memory?.retainedResultsMb ??
		DEFAULT_RETAINED_RESULTS_MB;
	return megabytes * 1024 * 1024;
}

/** Settled-cell image spill disk budget; the environment override accepts 0 (count cap only). */
export function resolveRetainedImagesBytes(settings: CodemodeSettings, env: Environment = process.env): number {
	const megabytes =
		nonNegativeIntegerOverride(env[RETAINED_IMAGES_ENVIRONMENT_FLAG]) ??
		settings.memory?.retainedImagesMb ??
		DEFAULT_RETAINED_IMAGES_MB;
	return megabytes * 1024 * 1024;
}

function nonNegativeIntegerOverride(value: string | undefined): number | undefined {
	if (value === undefined || !/^\s*\d+\s*$/u.test(value)) return undefined;
	return Number.parseInt(value, 10);
}

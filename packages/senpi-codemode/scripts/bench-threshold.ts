import { percentile, trimmedMean, trimmedMeanStandardError } from "./bench-stats.ts";

/** No gated row may regress more than this, whatever its measured noise. */
export const MAX_BAND = 0.05;

/**
 * Standard errors added to a row's A/A offset. About 3.3 is a one-sided 5% family-wise bound over the ~120
 * gated rows; the margin above it absorbs the standard error itself being estimated from the calibration pairs.
 */
export const THRESHOLD_Z = 4;

/**
 * `row`: every row gets its own band from ITS calibration pairs through `rowNoiseBand` - one rule, row-sized constants.
 * `global`: one band for all rows, the p95 over rows of the A/A trimmed-mean deviation.
 */
export type BandScope = "row" | "global";
export const DEFAULT_BAND_SCOPE: BandScope = "row";

export function parseBandScope(value: string): BandScope {
	if (value === "row" || value === "global") return value;
	throw new RangeError(`--band-scope expects row or global, got ${value}`);
}

/** The single calibration rule: |A/A offset| + THRESHOLD_Z standard errors, as a ratio deviation. */
export function rowNoiseBand(calibrationLogRatios: readonly number[]): number {
	const offset = Math.abs(trimmedMean(calibrationLogRatios));
	return Math.expm1(offset + THRESHOLD_Z * trimmedMeanStandardError(calibrationLogRatios));
}

export function globalNoiseBand(calibrationLogRatiosPerRow: readonly (readonly number[])[]): number {
	return percentile(
		calibrationLogRatiosPerRow.map((logRatios) => Math.abs(Math.expm1(trimmedMean(logRatios)))),
		0.95,
	);
}

export function cappedThreshold(band: number): number {
	return Math.min(band, MAX_BAND);
}

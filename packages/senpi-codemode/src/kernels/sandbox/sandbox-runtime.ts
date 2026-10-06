import codemodePackage from "../../../package.json" with { type: "json" };
import type { EvalRuntimeInfo } from "../../tool/types.ts";

/** What an isolated cell's result reports as its runtime: the pinned QuickJS build, never the persistent kernel's. */
export const SANDBOX_RUNTIME: EvalRuntimeInfo = {
	name: "quickjs",
	version: codemodePackage.dependencies["quickjs-wasi"],
	isolation: "sandbox",
};

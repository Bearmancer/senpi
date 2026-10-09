import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The worker imports this plain-JS module; .ts files may not import .js, so it is loaded by URL.
const noticeModuleUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "group-signal-notice.js")).href;
let signalsProcessGroup: (commandText: string) => boolean = () => {
	throw new Error("group-signal-notice.js not loaded");
};

beforeAll(async () => {
	const loaded: unknown = await import(noticeModuleUrl);
	if (
		typeof loaded !== "object" ||
		loaded === null ||
		!("signalsProcessGroup" in loaded) ||
		typeof loaded.signalsProcessGroup !== "function"
	) {
		throw new Error("group-signal-notice.js does not export signalsProcessGroup");
	}
	const scan = loaded.signalsProcessGroup;
	signalsProcessGroup = (commandText) => scan(commandText) === true;
});

describe("process-group signal detection (senpi#2995)", () => {
	it.each([
		["PG=$(ps -o pgid= -p $W | tr -d ' '); kill -TERM -- -$PG"],
		["kill -9 -1234"],
		["kill -- -1234"],
		["kill -s TERM -$" + "{PG}"],
		["kill -TERM -$(cat /tmp/job.pgid)"],
		["bash -lc 'kill -KILL -- -$GROUP'"],
		["pkill -g 77 sleep"],
		["killall bun"],
		["sh -c 'killall -TERM node'"],
	])("Given %s when scanned then it is a group signal", (command) => {
		// when / then
		expect(signalsProcessGroup(command)).toBe(true);
	});

	it.each([
		["kill 1234"],
		["kill -9 1234"],
		["kill -TERM $PID"],
		["kill -l"],
		["skill -9 1234"],
		["echo killed -- -1"],
		['echo "run kill -9 on the stuck pid"'],
		['echo "use kill -9 1234 if needed"'],
		["grep -c killall notes.txt"],
	])("Given %s when scanned then it is not a group signal", (command) => {
		// when / then
		expect(signalsProcessGroup(command)).toBe(false);
	});
});

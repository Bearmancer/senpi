// senpi#2995: Bun.$ and node:child_process exec/execFile cannot start their children in a new process group under
// Bun (Bun.$ has no such option and Bun ignores `detached` there), so those children share the agent's group and a
// group-wide signal from the same cell stops the agent. A command that signals a process group gets a notice.

// `kill [-SIG | -s SIG | -n N] ... -- -<pgid>` or `kill -SIG -<pgid>` (a second dash argument is a group), and
// `pkill -g <pgid>`, and `killall`. A `$var`, `${var}` or `$(...)` group counts too, since the agent's group is often computed.
const GROUP_TARGET = String.raw`-(?:\d+|\$\{?\w+\}?|\$\()`;
const KILL_GROUP = new RegExp(
	String.raw`\bkill\b(?:\s+--\s+${GROUP_TARGET}|(?:\s+(?:-s\s+\w+|-n\s+\d+|-[A-Za-z]+\d*|-\d+))+\s+(?:--\s+)?${GROUP_TARGET})`,
	"u",
);
const PKILL_GROUP = /\bpkill\b[^\n;|&]*\s-g\b/u;
// `killall <name>` in command position signals every process with that name, which can include the agent's own (bun, node, senpi).
const KILLALL = /(?:^|[;|&(`'"]\s*)killall\s/mu;

export function signalsProcessGroup(commandText) {
	return KILL_GROUP.test(commandText) || PKILL_GROUP.test(commandText) || KILLALL.test(commandText);
}

export function groupSignalNotice(api) {
	const pgid = agentProcessGroup();
	const group = pgid === undefined ? "the agent's process group" : `the agent's process group (${pgid})`;
	return (
		`[senpi] This command signals a process group. Children of ${api} share ${group}, so signalling that ` +
		"group can stop this session. Start background jobs with Bun.spawn or child_process.spawn, which give them " +
		"their own group, or signal them by pid.\n"
	);
}

function agentProcessGroup() {
	const result = globalThis.Bun?.spawnSync?.(["ps", "-o", "pgid=", "-p", String(process.pid)]);
	const text = result?.success ? result.stdout.toString().trim() : "";
	return /^\d+$/u.test(text) ? text : undefined;
}

export function shellCommandText(strings, expressions) {
	if (!Array.isArray(strings)) return String(strings ?? "");
	return strings.reduce((text, part, index) => text + part + (index < expressions.length ? String(expressions[index]) : ""), "");
}

// node:child_process exec/execFile ignore `detached` under Bun; their command text is scanned before they run.
export function noticeChildProcessGroupSignals(emitText, isActive) {
	const childProcess = process.getBuiltinModule("node:child_process");
	const originals = new Map();
	for (const name of ["exec", "execFile"]) {
		const original = childProcess[name];
		if (typeof original !== "function") continue;
		originals.set(name, original);
		childProcess[name] = Object.assign(function scannedSpawner(...args) {
			const command = name === "exec" ? String(args[0]) : [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(" ");
			if (isActive() && signalsProcessGroup(command)) emitText("stderr", groupSignalNotice(`child_process.${name}`));
			return original.apply(this, args);
		}, original);
	}
	return () => {
		for (const [name, original] of originals) childProcess[name] = original;
	};
}

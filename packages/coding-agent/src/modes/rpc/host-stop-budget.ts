/** Shared with callers so they never kill a supervisor while it is reaping its child. */
export const CHILD_STOP_TIMEOUT_MS = 5_000;
export const CHILD_KILL_EXIT_TIMEOUT_MS = 30_000;

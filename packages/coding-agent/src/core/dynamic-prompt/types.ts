export type PromptSurface = "terminal" | "app";

export interface AvailableTool {
	name: string;
	category: "search" | "session" | "command" | "other";
}

export interface NativeDesktopEngineUnavailableDiagnostic {
	readonly code: "native-unavailable";
	readonly host: string;
	readonly attemptedPath: string;
	readonly message: string;
}

export type NativeDesktopEngineResult =
	| {
			readonly path: string;
			readonly diagnostic: null;
	  }
	| {
			readonly path: null;
			readonly diagnostic: NativeDesktopEngineUnavailableDiagnostic;
	  };

export function resolveNativeDesktopEngine(): NativeDesktopEngineResult;

export const nativeDesktopEngine: NativeDesktopEngineResult;

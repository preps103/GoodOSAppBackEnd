export interface GoodbaseTelemetryClient {
  recordSession(appId: string, lifecycle: Record<string, unknown>): Promise<unknown>;
  captureCrash(appId: string, crash: Record<string, unknown>): Promise<unknown>;
  recordTrace(appId: string, trace: Record<string, unknown>): Promise<unknown>;
  remoteConfig?(appId: string, context?: Record<string, string>): Promise<unknown>;
  experimentAssignments?(appId: string, anonymousId?: string): Promise<unknown>;
}
export interface GoodbaseTelemetryOptions {
  appId: string; client: GoodbaseTelemetryClient; release: string; buildNumber: string;
  consent?: "granted"|"essential"|"denied"; anonymousId?: string; installationId?: string;
  distributionTrack?: string; bufferLimit?: number; autoPerformance?: boolean;
}
export class GoodbaseTelemetry {
  constructor(options: GoodbaseTelemetryOptions);
  start(): Promise<void>; stop(): Promise<void>; flush(): Promise<void>;
  setConsent(consent: "granted"|"essential"|"denied"): Promise<void>;
  breadcrumb(message: string, data?: Record<string, unknown>): void;
  setCustomKey(key: string, value: unknown): void;
  captureException(error: unknown, options?: {fatal?: boolean; exceptionType?: string}): Promise<void>;
  trace<T>(name: string, operation: () => Promise<T>|T, type?: "startup"|"screen"|"network"|"custom"): Promise<T>;
}

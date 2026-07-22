export * from "./telemetry";
export declare class GoodbaseError extends Error { status?: number; code?: string; requestId?: string; }
export declare class GoodbaseClient {
  constructor(options?: {baseUrl?: string; accessToken?: string; attestationToken?: string; fetch?: typeof fetch});
  accessToken: string | null; attestationToken: string | null;
  request(path: string, options?: {method?: string; headers?: Record<string,string>; body?: unknown; signal?: AbortSignal}): Promise<any>;
  recordSession(appId: string, payload: Record<string,unknown>): Promise<any>;
  captureCrash(appId: string, payload: Record<string,unknown>): Promise<any>;
  recordTrace(appId: string, payload: Record<string,unknown>): Promise<any>;
  remoteConfig(appId: string, query?: string): Promise<any>;
  experimentAssignments(appId: string): Promise<any>;
  registerPushToken(payload: Record<string,unknown>): Promise<any>;
  syncChanges(collectionId: string, cursor?: number, limit?: number): Promise<any>;
  syncMutations(collectionId: string, deviceId: string, mutations: unknown[]): Promise<any>;
  exchangeAttestation(appId: string, platform: string, assertion: Record<string,unknown>): Promise<any>;
}
export function createGoodbaseReactBindings(React: unknown, client: GoodbaseTelemetryClient): Record<string, unknown>;
export function createGoodbaseServerClient(createClient: Function, request: Request, options?: {baseUrl?: string}): unknown;
import type { GoodbaseTelemetryClient } from "./telemetry";

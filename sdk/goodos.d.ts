export interface GoodOSClientOptions {
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
  rootUrl?: string;
  headers?: Record<string, string>;
}

export interface GoodOSApiKeyContext {
  id: string;
  name: string;
  type: string;
  scopes: string[];
  allowedAppIds: string[];
}

export interface GoodOSResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  [key: string]: unknown;
}

export interface GoodOSApp {
  id: string;
  name: string;
  domain?: string;
  status: string;
  memberCount?: number;
}

export interface GoodOSFunctionRun {
  id: string;
  status: string;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
}

export class GoodOSError extends Error {
  status: number;
  payload: unknown;
  response: Response | null;
}

export class GoodOSClient {
  constructor(options?: GoodOSClientOptions);
  setApiKey(apiKey: string): this;
  setAccessToken(accessToken: string): this;
  platformRequest<T = unknown>(path: string, options?: RequestInit & { body?: unknown }): Promise<T>;
  issueDataToken(): Promise<{ success: true; token: string; tokenType: "Bearer"; expiresIn: string; endpoint: string }>;
  dataRows<T = Record<string, unknown>>(resource: string, params?: Record<string, string | number | boolean>): Promise<T[]>;
  createDataRow<T = Record<string, unknown>>(resource: string, row?: Record<string, unknown>): Promise<T[]>;
  updateDataRows<T = Record<string, unknown>>(resource: string, filters?: Record<string, string>, changes?: Record<string, unknown>): Promise<T[]>;
  deleteDataRows<T = Record<string, unknown>>(resource: string, filters?: Record<string, string>): Promise<T[]>;
  request<T = unknown>(path: string, options?: RequestInit & { body?: unknown }): Promise<GoodOSResponse<T>>;
  health(): Promise<GoodOSResponse>;
  apps(): Promise<GoodOSResponse<{ apps: GoodOSApp[] }>>;
  dbTables(): Promise<GoodOSResponse>;
  dbRows(tableSlug: string, params?: { limit?: number; offset?: number; search?: string }): Promise<GoodOSResponse>;
  dbRow(tableSlug: string, id: string): Promise<GoodOSResponse>;
  createDbRow(tableSlug: string, row?: Record<string, unknown>): Promise<GoodOSResponse>;
  updateDbRow(tableSlug: string, id: string, row?: Record<string, unknown>): Promise<GoodOSResponse>;
  deleteDbRow(tableSlug: string, id: string): Promise<GoodOSResponse>;
  notifications(): Promise<GoodOSResponse>;
  createNotification(input?: Record<string, unknown>): Promise<GoodOSResponse>;
  billingPlans(): Promise<GoodOSResponse>;
  usage(): Promise<GoodOSResponse>;
  authSession(): Promise<GoodOSResponse>;
  authRoles(): Promise<GoodOSResponse>;
  setupMfa(label?: string): Promise<GoodOSResponse>;
  verifyMfa(factorId: string, token: string): Promise<GoodOSResponse>;
  requestPasswordReset(email: string): Promise<GoodOSResponse>;
  completePasswordReset(token: string, password: string): Promise<GoodOSResponse>;
  realtimeChannels(): Promise<GoodOSResponse>;
  realtimeEvents(params?: { channel?: string; limit?: number; offset?: number }): Promise<GoodOSResponse>;
  publishRealtimeEvent(channel?: string, event?: { eventType?: string; event_type?: string; message?: string; payload?: Record<string, unknown> }): Promise<GoodOSResponse>;
  realtimeStreamUrl(channel?: string, rootUrl?: string): string;
  realtimeWebSocketUrl(channel?: string, options?: { rootUrl?: string; apiKey?: string }): string;
  connectRealtimeWebSocket(channel?: string, options?: { rootUrl?: string; apiKey?: string }): WebSocket;
  track(appId: string, events: Record<string, unknown> | Array<Record<string, unknown>>, context?: Record<string, unknown>): Promise<GoodOSResponse>;
  captureCrash(appId: string, crash: Record<string, unknown>): Promise<GoodOSResponse>;
  recordTrace(appId: string, trace: Record<string, unknown>): Promise<GoodOSResponse>;
  remoteConfig(appId: string, context?: Record<string, string>): Promise<GoodOSResponse>;
  experimentAssignments(appId: string, anonymousId?: string): Promise<GoodOSResponse>;
  storageBuckets(): Promise<GoodOSResponse>;
  storagePublicUrl(bucketName: string, objectKey: string, rootUrl?: string): string;
  storageFiles(params?: { bucket?: string }): Promise<GoodOSResponse>;
  callFunction<TInput = Record<string, unknown>, TOutput = unknown>(
    slug: string,
    input?: TInput,
    options?: { method?: "GET" | "POST" }
  ): Promise<GoodOSResponse<TOutput>>;
}

export function createClient(options?: GoodOSClientOptions): GoodOSClient;

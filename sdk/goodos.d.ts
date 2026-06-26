export interface GoodOSClientOptions {
  apiKey?: string;
  baseUrl?: string;
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
  request<T = unknown>(path: string, options?: RequestInit & { body?: unknown }): Promise<GoodOSResponse<T>>;
  health(): Promise<GoodOSResponse>;
  apps(): Promise<GoodOSResponse<{ apps: GoodOSApp[] }>>;
  storageBuckets(): Promise<GoodOSResponse>;
  storageFiles(params?: { bucket?: string }): Promise<GoodOSResponse>;
  callFunction<TInput = Record<string, unknown>, TOutput = unknown>(
    slug: string,
    input?: TInput,
    options?: { method?: "GET" | "POST" }
  ): Promise<GoodOSResponse<TOutput>>;
}

export function createClient(options?: GoodOSClientOptions): GoodOSClient;

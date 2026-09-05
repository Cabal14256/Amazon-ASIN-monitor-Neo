export type Region = 'US' | 'EU';
export type Country = 'US' | 'UK' | 'DE' | 'FR' | 'IT' | 'ES';
export type Priority = 1 | 2 | 3;
export interface Credentials {
  lwaClientId: string;
  lwaClientSecret: string;
  refreshToken: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}
export interface SpApiConfig {
  useAwsSignature: boolean;
  regions: Record<Region, Credentials>;
}
export interface ConfigSource {
  get(signal: AbortSignal): Promise<SpApiConfig>;
  reload(signal: AbortSignal): Promise<SpApiConfig>;
}
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
export interface HttpInput {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface Transport {
  request(input: HttpInput): Promise<HttpResponse>;
}
export interface AttemptContext {
  region: Region;
  operation: string;
  priority: Priority;
  signal: AbortSignal;
}
export interface ResponseMetadata {
  region: Region;
  operation: string;
  statusCode: number;
  rateLimit?: number;
  requestId?: string;
}
/** Required production adapter: schedule, atomically charge once, then await task.
 * Must honor signal, invoke task at most once, and never return before task settles.
 */
export interface QuotaExecutor {
  execute<T>(context: AttemptContext, task: () => Promise<T>): Promise<T>;
  observe(metadata: ResponseMetadata): Promise<void> | void;
}
export type Query = Readonly<
  Record<
    string,
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly (string | number | null | undefined)[]
  >
>;

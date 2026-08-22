import type { Middleware } from './routing.js';

const RESET = '\x1b[0m';
const paint = (code: number, text: string): string => `\x1b[${code}m${text}${RESET}`;

const METHOD_COLORS: Record<string, number> = {
  GET: 32,
  POST: 36,
  PUT: 33,
  PATCH: 35,
  DELETE: 31,
  OPTIONS: 34,
  HEAD: 2,
  ALL: 37,
};

const STATUS_LABELS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export interface LogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  sizeBytes?: number;
  timestamp: Date;
  error?: unknown;
}

export interface LoggerOptions {
  /** Timestamp style. Default `'time'`. */
  timestamp?: 'time' | 'iso' | 'none';
  /** Append the query string to the path. Default `true`. */
  showQuery?: boolean;
  /** Print the response body size. Default `true`. */
  showSize?: boolean;
  /** Force ANSI colors on/off. Defaults to `true` when stdout is a TTY. */
  colors?: boolean;
  /** Sink hook called for every finished request (useful for tests, dashboards…). */
  onLog?: (entry: LogEntry) => void;
}

function statusColor(status: number): number {
  if (status >= 500) return 31;
  if (status >= 400) return 33;
  if (status >= 300) return 36;
  return 32;
}

function symbolFor(status: number): string {
  if (status >= 500) return '\u2717';
  if (status >= 400) return '!';
  if (status >= 300) return '\u2197';
  return '\u2713';
}

function durationColor(ms: number): number {
  if (ms >= 200) return 31;
  if (ms >= 50) return 33;
  return 32;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(ms >= 10 ? 0 : 1)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sizeOfResponse(response: Response): number | undefined {
  const length = response.headers.get('content-length');
  if (length !== null) {
    const parsed = Number(length);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sizeOfValue(value: unknown): number | undefined {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value === null || typeof value !== 'object') return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/**
 * Beautiful, zero-dependency request logger.
 *
 * ```
 * [14:03:22] GET    /api/users       200 ✓ OK           2 ms   120 B
 * [14:03:25] DELETE /api/users/1     204 ✓ No Content   1 ms     —
 * [14:03:40] POST   /api/users       400 ! Bad Request  3 ms   240 B
 * [14:03:55] GET    /boom            500 ✗ Internal Server Error 12 ms
 * ```
 */
export function logger(options: LoggerOptions = {}): Middleware {
  const colors = options.colors ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
  const showQuery = options.showQuery ?? true;
  const showSize = options.showSize ?? true;
  const timestamp = options.timestamp ?? 'time';
  const onLog = options.onLog;

  const colorize = (code: number, text: string): string => (colors ? paint(code, text) : text);

  return async (ctx, next) => {
    const started = performance.now();
    const query = ctx.query.toString();
    const path = showQuery && query ? `${ctx.path}?${query}` : ctx.path;
    let entry: LogEntry;

    try {
      const response = await next();
      entry = {
        method: ctx.method,
        path,
        status: response instanceof Response ? response.status : ctx.set.status,
        durationMs: performance.now() - started,
        sizeBytes:
          response instanceof Response ? sizeOfResponse(response) : sizeOfValue(response),
        timestamp: new Date(),
      };
      emit(entry, colorize, timestamp, showSize);
      onLog?.(entry);
      return response;
    } catch (error) {
      entry = {
        method: ctx.method,
        path,
        status: 500,
        durationMs: performance.now() - started,
        timestamp: new Date(),
        error,
      };
      emit(entry, colorize, timestamp, showSize);
      onLog?.(entry);
      throw error;
    }
  };
}

function emit(
  entry: LogEntry,
  colorize: (code: number, text: string) => string,
  timestamp: 'time' | 'iso' | 'none',
  showSize: boolean,
): void {
  const parts: string[] = [];

  if (timestamp !== 'none') {
    const stamp =
      timestamp === 'iso'
        ? entry.timestamp.toISOString()
        : entry.timestamp.toLocaleTimeString('en-GB', { hour12: false });
    parts.push(colorize(2, `[${stamp}]`));
  }

  const method = entry.method.padEnd(7);
  parts.push(colorize(1, colorize(METHOD_COLORS[entry.method] ?? 37, method)));
  parts.push(colorize(1, entry.path));
  parts.push(colorize(2, '\u2192'));

  const label = STATUS_LABELS[entry.status] ?? '';
  const status = `${entry.status} ${symbolFor(entry.status)}${label ? ` ${label}` : ''}`;
  parts.push(colorize(statusColor(entry.status), status));

  parts.push(colorize(durationColor(entry.durationMs), formatDuration(entry.durationMs)));

  if (showSize) {
    parts.push(colorize(2, entry.sizeBytes === undefined ? '\u2014' : formatBytes(entry.sizeBytes)));
  }

  if (entry.error !== undefined) {
    const message =
      entry.error instanceof Error ? entry.error.message : String(entry.error);
    parts.push(colorize(31, message));
  }

  const line = parts.join(' ');
  if (entry.status >= 500) {
    console.error(line);
  } else {
    console.log(line);
  }
}
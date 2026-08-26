import type { Middleware } from './routing.js';

export interface CorsOptions {
  /**
   * Value for `Access-Control-Allow-Origin`.
   * - `'*'` (default) — allow any origin.
   * - A specific origin string — only that origin is reflected.
   * - An array of strings — the request `Origin` header is matched against
   *   the list; the matching origin is reflected or `*` is used when omitted.
   * - A function `(origin: string) => string | null` — dynamic resolution.
   */
  origin?: string | string[] | ((origin: string) => string | null);

  /** Value for `Access-Control-Allow-Methods`. Default `'GET,HEAD,PUT,PATCH,POST,DELETE'`. */
  methods?: string;

  /** Value for `Access-Control-Allow-Headers`. Default `'*'`. */
  allowedHeaders?: string;

  /** Value for `Access-Control-Expose-Headers`. Default `''`. */
  exposedHeaders?: string;

  /** Value for `Access-Control-Allow-Credentials`. Default `false`. */
  credentials?: boolean;

  /** Value for `Access-Control-Max-Age`. Default `86400` (24 h). */
  maxAge?: number;

  /** Send preflight responses with status `204` (default) or `200`. */
  preflightStatus?: 200 | 204;
}

function resolveOrigin(origin: string, option: CorsOptions['origin']): string | null {
  if (option === undefined || option === '*') return '*';
  if (typeof option === 'function') return option(origin);
  if (Array.isArray(option)) return option.includes(origin) ? origin : null;
  return option === origin ? option : null;
}

/**
 * CORS middleware.
 *
 * @example
 * ```ts
 * import { Espresso } from 'espresso-mvc';
 * import { cors } from 'espresso-mvc';
 *
 * const app = new Espresso();
 * app.use(cors());
 * ```
 */
export function cors(options: CorsOptions = {}): Middleware {
  const {
    methods = 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders = '*',
    exposedHeaders = '',
    credentials = false,
    maxAge = 86400,
    preflightStatus = 204,
  } = options;

  return async (ctx, next) => {
    const requestOrigin = ctx.headers.get('origin');
    const origin = requestOrigin
      ? resolveOrigin(requestOrigin, options.origin)
      : (options.origin === undefined ? '*' : null);

    if (origin === null) {
      return next();
    }

    if (ctx.method === 'OPTIONS' && ctx.headers.has('access-control-request-method')) {
      const res = new Response(null, { status: preflightStatus });
      res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.set('Access-Control-Allow-Methods', methods);
      res.headers.set('Access-Control-Allow-Headers', allowedHeaders);
      if (credentials) res.headers.set('Access-Control-Allow-Credentials', 'true');
      res.headers.set('Access-Control-Max-Age', String(maxAge));
      return res;
    }

    const result = await next();
    if (result instanceof Response) {
      result.headers.set('Access-Control-Allow-Origin', origin);
      if (exposedHeaders) result.headers.set('Access-Control-Expose-Headers', exposedHeaders);
      if (credentials) result.headers.set('Access-Control-Allow-Credentials', 'true');
      return result;
    }
    ctx.set.headers['Access-Control-Allow-Origin'] = origin;
    if (exposedHeaders) ctx.set.headers['Access-Control-Expose-Headers'] = exposedHeaders;
    if (credentials) ctx.set.headers['Access-Control-Allow-Credentials'] = 'true';
    return result;
  };
}

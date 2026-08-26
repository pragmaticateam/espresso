import { randomBytes } from 'node:crypto';
import type { Middleware } from './routing.js';

export interface CsrfOptions {
  /** Cookie name. Default `'_csrf'`. */
  cookieName?: string;
  /** Request header name. Default `'X-CSRF-Token'`. */
  headerName?: string;
  /** HTTP methods that require validation. Default `'POST,PUT,PATCH,DELETE'`. */
  methods?: string;
  /** Token byte length (before hex encoding). Default `32` (256-bit). */
  tokenLength?: number;
  /** Cookie `Path` attribute. Default `'/'`. */
  cookiePath?: string;
  /** Cookie `SameSite` attribute. Default `'Strict'`. */
  cookieSameSite?: 'Strict' | 'Lax' | 'None';
  /**
   * Custom token generator. Receives the byte length and returns a string token.
   * Default: `randomBytes(len).toString('hex')`.
   */
  generateToken?: (length: number) => string;
  /**
   * Extract the submitted token from the request.
   * Receives the context and returns the token string, or `null` to skip.
   * Default: reads `headerName` header, then falls back to `_csrf` body field.
   */
  getToken?: (ctx: { headers: Headers; method: string }) => string | null;
  /**
   * Custom validator. Receives the cookie token and the submitted token and
   * returns `true` if they match. Default: `cookie === submitted`.
   */
  validateToken?: (cookieToken: string, submittedToken: string) => boolean;
  /**
   * Set to `true` to validate tokens on safe methods (GET, HEAD, OPTIONS) as well.
   * Default `false`.
   */
  validateAllMethods?: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(value); }
      catch { out[key] = value; }
    }
  }
  return out;
}

function defaultGetToken(
  ctx: { headers: Headers },
  headerName: string,
): string | null {
  return ctx.headers.get(headerName);
}

function cookieString(name: string, value: string, opts: { path: string; sameSite: string }): string {
  return `${name}=${encodeURIComponent(value)}; Path=${opts.path}; SameSite=${opts.sameSite}; HttpOnly=false`;
}

/**
 * CSRF / XSRF protection middleware using the double-submit cookie pattern.
 *
 * - On every request, ensures a CSRF token cookie exists (auto-generates if missing).
 * - For state-changing methods (POST, PUT, PATCH, DELETE), validates that the
 *   submitted token (from header or body) matches the cookie value.
 * - Returns `403` with `{ error: 'CSRF token missing or invalid' }` on failure.
 *
 * @example
 * ```ts
 * import { Espresso, csrf } from 'espresso-mvc';
 *
 * const app = new Espresso();
 * app.use(csrf());
 * ```
 */
export function csrf(options: CsrfOptions = {}): Middleware {
  const {
    cookieName = '_csrf',
    headerName = 'X-CSRF-Token',
    methods = 'POST,PUT,PATCH,DELETE',
    tokenLength = 32,
    cookiePath = '/',
    cookieSameSite = 'Strict',
    generateToken = (len) => randomBytes(len).toString('hex'),
    getToken,
    validateToken = (a, b) => a === b,
    validateAllMethods = false,
  } = options;

  const protectedMethods = new Set(
    methods.split(',').map((m) => m.trim().toUpperCase()),
  );

  return async (ctx, next) => {
    const requestCookies = parseCookies(ctx.headers.get('cookie') ?? '');
    let token = requestCookies[cookieName];

    if (!token) {
      token = generateToken(tokenLength);
    }

    const needsValidation = validateAllMethods || protectedMethods.has(ctx.method);

    if (needsValidation) {
      const submitted =
        defaultGetToken(ctx, headerName) ??
        (typeof getToken === 'function' ? getToken(ctx) : null);

      if (!submitted || !validateToken(token, submitted)) {
        const res = new Response(
          JSON.stringify({ error: 'CSRF token missing or invalid' }),
          {
            status: 403,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
        res.headers.append(
          'set-cookie',
          cookieString(cookieName, token, { path: cookiePath, sameSite: cookieSameSite }),
        );
        return res;
      }
    }

    const result = await next();
    const cookieHeader = cookieString(cookieName, token, { path: cookiePath, sameSite: cookieSameSite });

    if (result instanceof Response) {
      if (!requestCookies[cookieName]) {
        result.headers.append('set-cookie', cookieHeader);
      }
      return result;
    }

    if (!requestCookies[cookieName]) {
      ctx.set.headers['set-cookie'] = cookieHeader;
    }
    return result;
  };
}

import type { Context } from './Context.js';
import type { ParamsFromPath } from './types.js';

export type Handler<Path extends string = string> = (
  ctx: Context<ParamsFromPath<Path>>,
) => unknown | Promise<unknown>;

export type Middleware = (
  ctx: Context,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

export interface RouteEntry {
  method: string;
  path: string;
  segments: string[];
  handler: Handler;
}

export interface MiddlewareEntry {
  /** Path prefix this middleware runs for, or `null` for every request. */
  path: string | null;
  handler: Middleware;
}

export interface StaticEntry {
  prefix: string;
  dir: string;
}

export function normalizePath(path: string): string {
  let p = path.startsWith('/') ? path : `/${path}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function splitPath(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

export function joinPath(prefix: string, path: string): string {
  const a = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const b = path.startsWith('/') ? path : `/${path}`;
  return normalizePath(`${a}${b}`);
}

/** Does `prefix` cover `pathname` (prefix match on a segment boundary)? */
export function pathnameMatches(prefix: string, pathname: string): boolean {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function matchRoute(
  routeSegments: string[],
  pathSegments: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const seg = routeSegments[i];
    if (seg === '*') {
      params['*'] = pathSegments.slice(i).join('/');
      return params;
    }
    const actual = pathSegments[i];
    if (actual === undefined) return null;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(actual);
    } else if (seg !== actual) {
      return null;
    }
  }
  if (routeSegments.length !== pathSegments.length) return null;
  return params;
}
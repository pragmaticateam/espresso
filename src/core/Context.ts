import { Templating } from './libs/templating/index.js';

/** Response state the handler can mutate before returning a value. */
export interface SetState {
  status: number;
  headers: Record<string, string>;
  cookies: Record<string, string>;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

export class Context<P extends Record<string, string> = Record<string, string>> {
  readonly request: Request;
  /** Route params, e.g. `/users/:id` -> `{ id: '1' }`. Typed from the route path. */
  params: P;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;
  /** Parsed request cookies. */
  readonly cookies: Record<string, string>;
  /** Mutable response state. */
  readonly set: SetState = { status: 200, headers: {}, cookies: {} };
  private bodyPromise: Promise<unknown> | null = null;
  private readonly viewsDir: string;
  private readonly partialsDir: string;
  private templating: Templating | null = null;

  constructor(request: Request, params: P, viewsDir: string, partialsDir?: string) {
    this.request = request;
    this.params = params;
    const url = new URL(request.url);
    this.query = url.searchParams;
    this.path = url.pathname;
    this.method = request.method.toUpperCase();
    this.headers = request.headers;
    this.cookies = parseCookies(request.headers.get('cookie') ?? '');
    this.viewsDir = viewsDir;
    this.partialsDir = partialsDir ?? `${viewsDir}/partials`;
  }

  /**
   * Lazily parsed request body. JSON, form-urlencoded and multipart are parsed
   * automatically; anything else is returned as raw text (or `undefined`).
   */
  get body(): Promise<unknown> {
    this.bodyPromise ??= parseBody(this.request);
    return this.bodyPromise;
  }

  json = (data: unknown, status: number = this.set.status): Response =>
    this.respond(JSON.stringify(data), JSON_TYPE, status);

  text = (data: string, status: number = this.set.status): Response =>
    this.respond(data, TEXT_TYPE, status);

  html = (data: string, status: number = this.set.status): Response =>
    this.respond(data, HTML_TYPE, status);

  redirect = (location: string, status: number = 302): Response =>
    this.respond(null, '', status, { location });

  /**
   * Renders a view from the views directory using the templating engine.
   * Supports `.espresso` and `.html` files, partials from `views/partials`,
   * interpolation, `#each`, `#if` and `#section` blocks.
   */
  view = async (name: string, data?: Record<string, unknown>): Promise<Response> => {
    const html = await this.getTemplating().renderFile(name, data ?? {});
    return this.html(html);
  };

  /** The lazily created templating engine. */
  getTemplating(): Templating {
    this.templating ??= new Templating({
      viewsDir: this.viewsDir,
      partialsDir: this.partialsDir,
    });
    return this.templating;
  }

  private respond(
    body: string | null,
    contentType: string,
    status: number,
    extra?: Record<string, string>,
  ): Response {
    const headers = new Headers({ ...this.set.headers, ...extra });
    if (contentType) headers.set('content-type', contentType);
    if (body !== null) headers.set('content-length', String(Buffer.byteLength(body)));
    const response = new Response(body, { status, headers });
    for (const [key, value] of Object.entries(this.set.cookies)) {
      response.headers.append('set-cookie', `${key}=${encodeURIComponent(value)}; Path=/`);
    }
    return response;
  }
}

async function parseBody(request: Request): Promise<unknown> {
  if (!request.body) return undefined;
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return request.json();
  if (type.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (type.includes('multipart/form-data')) return request.formData();
  const text = await request.text();
  return text.length > 0 ? text : undefined;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { Context, type SetState } from './Context.js';
import {
  joinPath,
  matchRoute,
  normalizePath,
  pathnameMatches,
  splitPath,
  type Middleware,
  type MiddlewareEntry,
  type RouteEntry,
  type Handler,
  type StaticEntry,
} from './routing.js';
import { serveStaticFile } from './static.js';

export interface EspressoConfig {
  /** Directory for `ctx.view()` HTML templates. Default `src/views`. */
  viewsDir?: string;
  /** Directory for template partials. Default `viewsDir/partials`. */
  partialsDir?: string;
  /** Directory served by `.assets()`. Default `src/assets`. */
  assetsDir?: string;
  /** Directory served by `.public()`. Default `src/public`. */
  publicDir?: string;
}

export type ErrorHandler = (error: unknown, ctx: Context) => unknown;

const JSON_TYPE = 'application/json; charset=utf-8';

export class Espresso {
  private readonly routes: RouteEntry[] = [];
  private readonly middlewares: MiddlewareEntry[] = [];
  private readonly statics: StaticEntry[] = [];
  private readonly config: Required<EspressoConfig>;
  private errorHandler: ErrorHandler = (error) => {
    const body = JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal Server Error',
    });
    return new Response(body, {
      status: 500,
      headers: { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(body)) },
    });
  };
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: EspressoConfig = {}) {
    const viewsDir = config.viewsDir ?? 'src/views';
    this.config = {
      viewsDir,
      partialsDir: config.partialsDir ?? `${viewsDir}/partials`,
      assetsDir: config.assetsDir ?? 'src/assets',
      publicDir: config.publicDir ?? 'src/public',
    };
  }

  get<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('GET', path, handler);
  }
  post<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('POST', path, handler);
  }
  put<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('PUT', path, handler);
  }
  patch<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('PATCH', path, handler);
  }
  delete<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('DELETE', path, handler);
  }
  options<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('OPTIONS', path, handler);
  }
  head<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('HEAD', path, handler);
  }
  all<Path extends string>(path: Path, handler: Handler<Path>): this {
    return this.add('*', path, handler);
  }

  private add<Path extends string>(method: string, path: Path, handler: Handler<Path>): this {
    this.routes.push({ method, path: normalizePath(path), segments: splitPath(path), handler });
    return this;
  }

  /** Register a global middleware. */
  use(middleware: Middleware): this;
  /** Register a middleware for a path prefix. */
  use(path: string, middleware: Middleware): this;
  /** Mount a sub-application (routes, middlewares and static dirs). */
  use(app: Espresso): this;
  use(pathOrApp: string | Espresso | Middleware, maybeMiddleware?: Middleware): this {
    if (typeof pathOrApp === 'string') {
      this.middlewares.push({ path: normalizePath(pathOrApp), handler: maybeMiddleware! });
    } else if (pathOrApp instanceof Espresso) {
      this.mount('', pathOrApp);
    } else {
      this.middlewares.push({ path: null, handler: pathOrApp });
    }
    return this;
  }

  /** Mount a sub-application under a path prefix. */
  mount(prefix: string, app: Espresso): this {
    for (const route of app.routes) {
      const path = joinPath(prefix, route.path);
      this.routes.push({ ...route, path, segments: splitPath(path) });
    }
    for (const mw of app.middlewares) {
      this.middlewares.push({
        path: mw.path === null ? normalizePath(prefix) : joinPath(prefix, mw.path),
        handler: mw.handler,
      });
    }
    for (const stat of app.statics) {
      this.statics.push({ prefix: joinPath(prefix, stat.prefix), dir: stat.dir });
    }
    return this;
  }

  /** Serve a directory of static files under a URL prefix. */
  static(prefix: string, dir: string): this {
    this.statics.push({ prefix: normalizePath(prefix), dir });
    return this;
  }
  /** Serve `src/assets` (css, js, images, fonts) under `/assets`. */
  assets(prefix = '/assets'): this {
    return this.static(prefix, this.config.assetsDir);
  }
  /** Serve `src/public` (manifest, robots.txt, etc.) at the given prefix. */
  public(prefix = '/'): this {
    return this.static(prefix, this.config.publicDir);
  }
  /** Serve `src/views` as static HTML. */
  views(prefix = '/'): this {
    return this.static(prefix, this.config.viewsDir);
  }

  onError(handler: ErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /** Full request pipeline. Works with any web-standard `Request`. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ctx = new Context(request, {}, this.config.viewsDir, this.config.partialsDir);
    try {
      const chain = this.middlewares.filter((mw) =>
        mw.path === null ? true : pathnameMatches(mw.path, url.pathname),
      );
      const run = (index: number): Promise<unknown> => {
        const mw = chain[index];
        if (!mw) return this.dispatch(url, ctx);
        return Promise.resolve(mw.handler(ctx, () => run(index + 1)));
      };
      return normalize(await run(0), ctx);
    } catch (error) {
      return normalize(this.errorHandler(error, ctx), ctx);
    }
  }

  private async dispatch(url: URL, ctx: Context): Promise<unknown> {
    const pathSegments = splitPath(url.pathname);
    for (const route of this.routes) {
      if (route.method !== '*' && route.method !== ctx.method) continue;
      const params = matchRoute(route.segments, pathSegments);
      if (params) {
        ctx.params = params;
        return route.handler(ctx);
      }
    }
    for (const stat of this.statics) {
      if (pathnameMatches(stat.prefix, url.pathname)) {
        const response = await serveStaticFile(stat.dir, url.pathname.slice(stat.prefix.length));
        if (response) return response;
      }
    }
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: {
        'content-type': JSON_TYPE,
        'content-length': String(Buffer.byteLength('{"error":"Not Found"}')),
      },
    });
  }

  /** Start listening. Returns `this` so the app can be chained further. */
  listen(callback?: () => void): this;
  listen(port?: number, callback?: () => void): this;
  listen(port?: number, hostname?: string, callback?: () => void): this;
  listen(
    portOrCallback: number | (() => void) = 3000,
    hostnameOrCallback?: string | (() => void),
    maybeCallback?: () => void,
  ): this {
    const port = typeof portOrCallback === 'function' ? 3000 : portOrCallback;
    const eagerCallback = typeof portOrCallback === 'function' ? portOrCallback : undefined;
    const hostname = typeof hostnameOrCallback === 'string' ? hostnameOrCallback : '0.0.0.0';
    const callback =
      eagerCallback ?? (typeof hostnameOrCallback === 'function' ? hostnameOrCallback : maybeCallback);
    this.server = createServer((req, res) => {
      void this.handleConnection(req, res);
    });
    this.server.listen(port, hostname, callback);
    return this;
  }

  private async handleConnection(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const request = toWebRequest(req);
      const response = await this.handle(request);
      await writeWebResponse(req, res, response);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', JSON_TYPE);
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }));
    }
  }

  /** Underlying node http.Server. */
  get serverInstance() {
    return this.server;
  }
}

function normalize(result: unknown, ctx: Context): Response {
  if (result instanceof Response) return result;
  const { set } = ctx;
  if (result === undefined || result === null) {
    return new Response(null, { status: set.status, headers: new Headers(set.headers) });
  }
  if (typeof result === 'string') {
    return applyCookies(
      new Response(result, {
        status: set.status,
        headers: { ...set.headers, 'content-type': 'text/plain; charset=utf-8' },
      }),
      set,
    );
  }
  if (result instanceof Uint8Array || result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
    return new Response(result as BodyInit, {
      status: set.status,
      headers: new Headers(set.headers),
    });
  }
  return applyCookies(
    new Response(JSON.stringify(result), {
      status: set.status,
      headers: { ...set.headers, 'content-type': JSON_TYPE },
    }),
    set,
  );
}

function applyCookies(response: Response, set: SetState): Response {
  for (const [key, value] of Object.entries(set.cookies)) {
    response.headers.append('set-cookie', `${key}=${encodeURIComponent(value)}; Path=/`);
  }
  return response;
}

function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const init: RequestInit & { duplex: 'half' } = {
    method: req.method,
    headers: req.headers as Record<string, string>,
    duplex: 'half',
  };
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
  }
  return new Request(url, init);
}

async function writeWebResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    res.setHeader(key, value);
  }
  for (const cookie of response.headers.getSetCookie()) {
    res.appendHeader('set-cookie', cookie);
  }
  if (req.method === 'HEAD' || response.body === null) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  stream.pipe(res);
}
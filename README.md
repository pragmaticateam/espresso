# espresso-mvc

**espresso** is a lightweight TypeScript framework for building REST APIs and MVC
applications on top of web-standard `Request` / `Response` objects.

- **Zero runtime dependencies** — install only what you use
- **Fully typed routes** — params are inferred from path templates
- **Middleware with `next()`** — global or scoped to a path prefix
- **Composable sub-apps** via `.mount()` / `router()`
- **Built-in templating engine** (`.espresso` templates) with partials and caching
- **Static file serving** with path-traversal protection
- **Beautiful zero-config request logger**
- Framework core is transport-free: `app.handle(request)` works on any
  web-standard `Request`, so it runs on Node's http server today and ports
  anywhere `Request`/`Response` do

Requires Node.js >= 20.

## Install

```sh
npm install espresso-mvc
```

MongoDB support lives in a separate package so the core stays tiny:

```sh
npm install espresso-mongo mongodb
```

## Quick start

```ts
import { Espresso, logger } from 'espresso-mvc';

const app = new Espresso();

app
  .use(logger())
  .get('/', () => ({ hello: 'world' }))
  .get('/users/:id', ({ params, query }) => ({ id: params.id, admin: query.get('admin') }))
  .post('/echo', async (ctx) => ({ method: ctx.method, body: await ctx.body }));

app.listen(3000, () => console.log('http://localhost:3000'));
```

Handlers can return plain objects (sent as JSON), strings, `Uint8Array` /
`ArrayBuffer`, a web `Response`, or nothing at all — whatever you return is
normalized for you.

### A runnable example

The [`example/`](./example) folder contains a small café API + website using
routes, mounted sub-apps, scoped auth middleware, cookies, views and static
assets. Run it directly with Node's native TypeScript support (Node >= 23):

```sh
npm run build
npm link && npm link espresso-mvc   # make 'espresso-mvc' importable
node example/server.ts              # Node >= 23 for native TS stripping
```

## The Context object

Every handler receives a `ctx`:

| Member | Description |
| --- | --- |
| `ctx.request` | The original web-standard `Request` |
| `ctx.params` | Route params, typed from the path (`/users/:id` → `{ id: string }`) |
| `ctx.query` | `URLSearchParams` of the query string |
| `ctx.headers` | Request `Headers` |
| `ctx.method` | Uppercase HTTP method |
| `ctx.path` | URL pathname |
| `ctx.cookies` | Parsed request cookies |
| `ctx.body` | Lazily parsed body (JSON, form-urlencoded, multipart, or raw text) |
| `ctx.set` | Mutable response state: `{ status, headers, cookies }` |
| `ctx.json(data, status?)` | JSON response |
| `ctx.text(data, status?)` | Plain-text response |
| `ctx.html(data, status?)` | HTML response |
| `ctx.redirect(location, status?)` | Redirect (default `302`) |
| `ctx.view(name, data?)` | Render a template from the views directory |

Cookies set via `ctx.set.cookies[key] = value` are appended automatically.
Status and headers set via `ctx.set` apply even when you return a bare object.

## Routing

Typed methods for every HTTP verb, plus `all()`:

```ts
app.get('/users/:id/posts/:postId', ({ params }) => params.id); // { id, postId }
app.post('/users', handler);
app.all('/health', handler);
```

Catch-all segments: `/files/*` → `params['*']`.

## Middleware

```ts
// global
app.use(async (ctx, next) => {
  const started = performance.now();
  const res = await next();
  console.log(ctx.path, performance.now() - started);
  return res;
});

// scoped to /admin/*
app.use('/admin', authMiddleware);

// short-circuit by never calling next()
app.use((ctx) => ctx.json({ blocked: true }, 401));
```

Middleware runs in registration order; route matching happens after the whole
chain resolves.

## Routers and mounting

```ts
import { router } from 'espresso-mvc';

const api = router();
api.get('/', listUsers).post('/', createUser);

app.mount('/api/users', api);
// or: app.use(api)
```

Routes, middleware (re-scoped to the prefix) and static directories of the
sub-app come along automatically.

## Error handling

```ts
app.onError((error, ctx) => ctx.json({ message: 'oops' }, 500));
```

Without a custom handler, thrown errors produce a JSON 500 response.

## Views & templating

```
project/
├── src/
│   ├── views/
│   │   ├── index.espresso
│   │   └── partials/header.espresso
│   ├── assets/          # served by app.assets()
│   └── public/          # served by app.public()
```

```ts
const app = new Espresso(); // viewsDir defaults to src/views

app.get('/', ({ view }) => view('index', { title: 'Home' }));
app.assets(); // serve src/assets under /assets
app.public(); // serve src/public under /
```

Template syntax:

```
{{ title }}                      escaped interpolation (dot-paths work)
{{{ html }}}                     raw interpolation
{{ #if user }} ... {{ else }} ... {{ /if }}
{{ #each items }} {{ name }} {{ @index }} {{ /each }}
{{ #items }} ... {{ /items }}    generic section — iterates arrays,
                                 enters object scope otherwise
{{ ^empty }} renders when falsy/empty {{ /empty }}
{{ this }}                       current scope inside a section
{{ partial 'header' }}           include from views/partials
{{ partial 'user' currentUser }} include with an overridden context
```

Lookups walk parent scopes, so variables from outer blocks stay visible inside
sections. Templates are compiled once and cached; files are re-read only when
their mtime changes. `.html` files work too.

You can also use the engine directly:

```ts
import { Templating } from 'espresso-mvc';

const t = new Templating({ viewsDir: 'src/views' });
const html = await t.render('<h1>{{ title }}</h1>', { title: 'Hello' });
```

## Serving static files

```ts
app.static('/cdn', './storage'); // any directory under any prefix
app.static('/img', './images');  // multiple dirs chain naturally:
                                 // if one misses, the next is tried
```

Resolved paths are confined to their root directory (path traversal returns
403), missing files return `null` so later statics or routes can take over,
and MIME types for common extensions are built in.

## Logger

```ts
import { logger } from 'espresso-mvc';

app.use(logger());
// [14:03:22] GET     /api/users → 200 ✓ OK          2 ms   120 B
// [14:03:25] DELETE  /api/users/1 → 204 ✓ No Content 1 ms    —
// [14:03:55] POST    /boom → 500 ✗ Internal Server Error 12 ms

app.use(logger({
  timestamp: 'time' | 'iso' | 'none',   // default 'time'
  showQuery: boolean,                   // default true
  showSize: boolean,                    // default true
  colors: boolean,                      // default: TTY && !NO_COLOR
  onLog: (entry) => metrics.push(entry), // sink hook for tests/dashboards
}));
```

Errors thrown by handlers are logged with status 500 and re-thrown to your
error handler.

## Configuration

Everything has a sensible default:

```ts
const app = new Espresso({
  viewsDir: 'src/views',            // templates for ctx.view()
  partialsDir: 'src/views/partials',// template partials
  assetsDir: 'src/assets',          // served by .assets()
  publicDir: 'src/public',          // served by .public()
});
```

`.listen()` accepts `(port?, callback?)` or `(port, hostname, callback?)`;
the port defaults to `3000`.

## Testing without a server

`app.handle(request)` is the entire request pipeline as a pure function — no
socket required:

```ts
const res = await app.handle(new Request('http://localhost/users/42'));
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { id: '42' });
```

This also makes the framework portable to any runtime that provides
`Request`/`Response`.

## TypeScript-first

Everything is typed: handlers receive fully-typed contexts, `Handler<Path>`
infers params from route literals via `ParamsFromPath`, and all public APIs
ship declaration files.

## Development

```sh
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
npm test           # builds, then node --test
```

## License

MIT

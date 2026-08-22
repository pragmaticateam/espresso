# espresso-mvc

**espresso** is a lightweight TypeScript framework for building REST APIs and
MVC applications on top of web-standard `Request`/`Response` objects.

- Zero runtime dependencies (MongoDB support is optional)
- Fully typed routes — params are inferred from path templates
- Middleware with `next()`, global or scoped to a path prefix
- Composable sub-apps via `.mount()` / `router()`
- Built-in templating engine (`.espresso` templates) with partials, sections and caching
- Static file serving with path-traversal protection
- Beautiful zero-config request logger
- Optional MongoDB module: schema validation, typed models, timestamps, pagination

Requires Node.js >= 20.

## Install

```sh
npm install espresso-mvc
```

Optional MongoDB support:

```sh
npm install espresso-mvc mongodb
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

Handlers can return plain objects (sent as JSON), strings, `Response`
objects, or nothing at all — whatever you return is normalized for you.

## The Context object

Every handler receives a `ctx`:

| Member | Description |
| --- | --- |
| `ctx.params` | Route params, typed from the path (`/users/:id` → `{ id: string }`) |
| `ctx.query` | `URLSearchParams` |
| `ctx.headers` | Request `Headers` |
| `ctx.cookies` | Parsed request cookies |
| `ctx.body` | Lazily parsed body (JSON, form-urlencoded, multipart, or raw text) |
| `ctx.set` | Mutable response state: `{ status, headers, cookies }` |
| `ctx.json(data, status?)` | JSON response |
| `ctx.text(data, status?)` | Plain-text response |
| `ctx.html(data, status?)` | HTML response |
| `ctx.redirect(location, status?)` | Redirect (default `302`) |
| `ctx.view(name, data?)` | Render a template from the views directory |

Cookies set via `ctx.set.cookies[key] = value` are appended automatically.

## Routing

Typed methods for every HTTP verb, plus `all()`:

```ts
app.get('/users/:id/posts/:postId', ({ params }) => params.id); // { id, postId }
app.post('/users', handler);
app.all('/health', handler);
```

Catch-all segments: `/files/*` → `params['*']`.

### Routers and mounting

```ts
import { router } from 'espresso-mvc';

const api = router();
api.get('/', listUsers).post('/', createUser);

app.use(logger()).mount('/api/users', api);
```

`.use(app)` mounts without a prefix. Middlewares and static dirs of the
sub-app come along automatically.

### Middleware

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

### Error handling

```ts
app.onError((error, ctx) => ctx.json({ message: 'oops' }, 500));
```

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
{{ title }}                     escaped interpolation (dot-paths work)
{{{ html }}}                    raw interpolation
{{ #if user }} ... {{ else }} ... {{ /if }}
{{ #each items }} {{ name }} {{ @index }} {{ /each }}
{{ ^empty }} renders when falsy/empty {{ /empty }}
{{ partial 'header' }}
{{ partial 'user' currentUser }}
```

Templates are compiled once and cached; files are re-read only when their
mtime changes. `.html` files work too.

You can also use the engine directly:

```ts
import { Templating } from 'espresso-mvc';

const t = new Templating({ viewsDir: 'src/views' });
const html = await t.render('<h1>{{ title }}</h1>', { title: 'Hello' });
```

## Logger

```ts
import { logger } from 'espresso-mvc';

app.use(logger());                       // [14:03:22] GET /users 200 ✓ OK 2 ms 120 B
app.use(logger({
  timestamp: 'iso' | 'time' | 'none',
  showQuery: boolean,
  showSize: boolean,
  colors: boolean,
  onLog: (entry) => metrics.push(entry), // sink hook for tests/dashboards
}));
```

Errors thrown by handlers are logged with status 500 and re-thrown to your
error handler.

## MongoDB (optional)

Import from the `espresso-mvc/mongo` subpath so `mongodb` is only loaded when
you actually use it:

```ts
import {
  connectMongo, disconnectMongo, isConnected,
  model,
} from 'espresso-mvc/mongo';

const User = model('user', {
  email: { type: 'string', required: true, unique: true },
  age: { type: 'number', min: 0 },
  tags: { type: 'array', default: [] },
  active: { type: 'boolean', default: true },
});

await connectMongo({ uri: process.env.MONGODB_URI!, dbName: 'app' });
await User.buildIndexes();

const user = await User.create({ email: 'a@b.c' });       // validated + timestamps
const found = await User.findById(id);
const page = await User.paginate({}, { page: 1, limit: 20 });

await disconnectMongo();
```

Model API: `create`, `createMany`, `find`, `findOne`, `findById`, `exists`,
`updateById`, `updateOne`, `deleteById`, `deleteOne`, `count`, `paginate`,
`buildIndexes`. Documents get automatic `createdAt`/`updatedAt`; invalid
writes throw `MongoModelError` with per-field errors.

Schema field options: `{ type, required?, unique?, default?, enum?, min?,
max?, minLength?, maxLength?, match?, items?, hidden? }` where `type` is one
of `'string' | 'number' | 'boolean' | 'date' | 'objectid' | 'object' | 'array'`.

## Serving static files safely

`serveStaticFile()` confines resolved paths inside the root directory and
returns `null` for missing files, so multiple static dirs can be chained:

```ts
import { serveStaticFile } from 'espresso-mvc';

app.static('/cdn', './storage');
```

MIME types for common extensions are built in.

## TypeScript-first

Everything is typed: handlers receive fully-typed contexts, `Handler<Path>`
infers params from route literals, and all public APIs ship declaration
files.

## License

MIT

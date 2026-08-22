import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Espresso, logger as createLogger, router, Templating } from '../dist/index.js';
import type { LogEntry } from '../dist/index.js';

function build() {
  const app = new Espresso();
  app
    .use(createLogger({ timestamp: 'none', colors: false }))
    .get('/', () => ({ hello: 'world' }))
    .get('/users/:id', ({ params, query }) => ({ id: params.id, admin: query.get('admin') }))
    .all('/echo', async (ctx) => ({ method: ctx.method, body: await ctx.body }));
  return app;
}

test('typed params and query', async () => {
  const res = await build().handle(new Request('http://localhost/users/42?admin=true'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: '42', admin: 'true' });
});

test('json body is parsed', async () => {
  const res = await build().handle(
    new Request('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alice' }),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { method: 'POST', body: { name: 'Alice' } });
});

test('mounted sub-app routes work', async () => {
  const api = router();
  api.get('/:id', ({ params }) => ({ userId: params.id }));
  const app = new Espresso();
  app.mount('/api/users', api);

  const res = await app.handle(new Request('http://localhost/api/users/7'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { userId: '7' });
});

test('404 for unknown routes', async () => {
  const res = await build().handle(new Request('http://localhost/nope'));
  assert.equal(res.status, 404);
});

test('middleware can short-circuit', async () => {
  const app = new Espresso();
  app.use((ctx) => ctx.json({ blocked: true }, 401));
  app.get('/', () => ({ ok: true }));
  const res = await app.handle(new Request('http://localhost/'));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { blocked: true });
});

test('onError handles thrown errors', async () => {
  const app = new Espresso();
  app.onError((error, ctx) => ctx.json({ message: (error as Error).message }, 500));
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  const res = await app.handle(new Request('http://localhost/boom'));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { message: 'kaboom' });
});

test('cookies and status via ctx.set', async () => {
  const app = new Espresso();
  app.get('/', (ctx) => {
    ctx.set.status = 201;
    ctx.set.cookies['token'] = 'abc';
    return { ok: true };
  });
  const res = await app.handle(new Request('http://localhost/'));
  assert.equal(res.status, 201);
  assert.match(res.headers.get('set-cookie') ?? '', /token=abc/);
});

test('logger emits entries for ok and error responses', async () => {
  const entries: LogEntry[] = [];
  const app = new Espresso();
  app.use(createLogger({ timestamp: 'none', colors: false, onLog: (e) => entries.push(e) }));
  app
    .get('/ok', () => ({ ok: true }))
    .get('/boom', () => {
      throw new Error('kaboom');
    });

  const ok = await app.handle(new Request('http://localhost/ok'));
  assert.equal(ok.status, 200);
  const boom = await app.handle(new Request('http://localhost/boom'));
  assert.equal(boom.status, 500);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, 200);
  assert.ok(entries[0].sizeBytes! > 0);
  assert.equal(entries[1].status, 500);
  assert.match((entries[1].error as Error).message, /kaboom/);
});

test('Templating renders interpolation and sections from strings', async () => {
  const t = new Templating({ viewsDir: '.' });
  const html = await t.render('{{ title }} {{ #each items }}{{ this }}{{ /each }}', {
    title: '<Hello>',
    items: ['a', 'b'],
  });
  assert.equal(html, '&lt;Hello&gt; ab');
});

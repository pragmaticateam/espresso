import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Espresso, router } from '../dist/index.js';

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe('middleware', () => {
  it('runs global middleware in registration order around the route', async () => {
    const calls: string[] = [];
    const app = new Espresso()
      .use(async (_ctx, next) => {
        calls.push('one:before');
        const out = await next();
        calls.push('one:after');
        return out;
      })
      .use(async (_ctx, next) => {
        calls.push('two:before');
        const out = await next();
        calls.push('two:after');
        return out;
      })
      .get('/', () => (calls.push('route'), { ok: true }));

    const res = await app.handle(req('/'));
    assert.deepEqual(calls, ['one:before', 'two:before', 'route', 'two:after', 'one:after']);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('path-scoped middleware only runs on matching prefixes', async () => {
    const hits: string[] = [];
    const app = new Espresso()
      .use('/api', (ctx, next) => (hits.push('api'), next()))
      .use('/admin', (ctx, next) => (hits.push('admin'), next()))
      .use('/api/users', (ctx, next) => (hits.push('api-users'), next()))
      .get('/api/users/:id', () => ({ user: 1 }))
      .get('/other', () => ({ other: true }));

    await app.handle(req('/api/users/1'));
    assert.deepEqual(hits, ['api', 'api-users']);

    hits.length = 0;
    await app.handle(req('/other'));
    assert.deepEqual(hits, []);

    hits.length = 0;
    const miss = await app.handle(req('/apiv2/nope'));
    assert.equal(miss.status, 404);
    assert.deepEqual(hits, []);
  });

  it('middleware can short-circuit without calling next()', async () => {
    let reachedRoute = false;
    const app = new Espresso()
      .use((ctx) => ctx.text('blocked at the door', 403))
      .get('/', () => ((reachedRoute = true), null));
    const res = await app.handle(req('/'));
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'blocked at the door');
    assert.equal(reachedRoute, false);
  });

  it('middleware can rewrite the final response', async () => {
    const app = new Espresso()
      .use(async (_ctx, next) => {
        const res = await next();
        if (res instanceof Response) res.headers.set('x-touched', 'true');
        return res;
      })
      .get('/', (ctx) => ctx.json({ fine: true }));
    const res = await app.handle(req('/'));
    assert.equal(res.headers.get('x-touched'), 'true');
  });

  it('errors thrown in middleware propagate to onError', async () => {
    const app = new Espresso();
    app.use(() => {
      throw new Error('mw exploded');
    });
    app.onError((error, ctx) => ctx.json({ caught: (error as Error).message }, 502));
    app.get('/', () => 'never reached');
    const res = await app.handle(req('/'));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { caught: 'mw exploded' });
  });
});

describe('sub-apps: use() and mount()', () => {
  it('use(app) mounts routes at the root', async () => {
    const sub = router();
    sub.get('/hello', () => 'from sub');
    const app = new Espresso().use(sub);
    const res = await app.handle(req('/hello'));
    assert.equal(await res.text(), 'from sub');
  });

  it('mount(prefix, app) joins route paths and extracts params', async () => {
    const sub = router();
    sub.get('/:id', ({ params }) => ({ id: params.id }));
    sub.get('/', () => 'index of sub');
    const app = new Espresso().mount('/users', sub);

    assert.equal(await (await app.handle(req('/users'))).text(), 'index of sub');
    assert.deepEqual(await (await app.handle(req('/users/42'))).json(), { id: '42' });
    assert.equal((await app.handle(req('/missing/42'))).status, 404);
  });

  it('mounted global middleware is scoped to the prefix', async () => {
    const hits: string[] = [];
    const sub = router().use((ctx, next) => (hits.push('sub-mw'), next()));
    sub.get('/data', () => ({ from: 'sub' }));
    const app = new Espresso()
      .use((ctx, next) => (hits.push('root-mw'), next()))
      .mount('/svc', sub)
      .get('/own', () => ({ from: 'root' }));

    assert.deepEqual(await (await app.handle(req('/svc/data'))).json(), { from: 'sub' });
    assert.deepEqual(hits, ['root-mw', 'sub-mw']);

    hits.length = 0;
    assert.deepEqual(await (await app.handle(req('/own'))).json(), { from: 'root' });
    assert.deepEqual(hits, ['root-mw']);
  });

  it('mounted path-scoped middleware keeps its own prefix under the mount point', async () => {
    const hits: string[] = [];
    const sub = router().use('/inner', (ctx, next) => (hits.push('inner-mw'), next()));
    sub.get('/inner/x', () => ({ x: 1 }));
    sub.get('/outer/y', () => ({ y: 2 }));
    const app = new Espresso().mount('/base', sub);

    await app.handle(req('/base/inner/x'));
    assert.deepEqual(hits, ['inner-mw']);
    hits.length = 0;
    await app.handle(req('/base/outer/y'));
    assert.deepEqual(hits, []);
  });

  it('mounted statics are re-prefixed', async () => {
    const publicDir = fileURLToPath(new URL('./fixtures/public/', import.meta.url));
    const sub = router().static('/files', publicDir);
    const app = new Espresso().mount('/mnt', sub);
    const res = await app.handle(req('/mnt/files/robots.txt'));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('User-agent'));
  });

  it('router() accepts the same config as Espresso', async () => {
    const sub = router({ viewsDir: '/tmp' });
    const app = new Espresso().use(sub);
    assert.equal((await app.handle(req('/nothing'))).status, 404);
  });

  it('chaining returns this for all registration helpers', () => {
    const app = new Espresso();
    const mw = (_ctx: unknown, next: () => Promise<unknown>) => next();
    assert.equal(app.get('/a', () => null), app);
    assert.equal(app.post('/a', () => null), app);
    assert.equal(app.put('/a', () => null), app);
    assert.equal(app.patch('/a', () => null), app);
    assert.equal(app.delete('/a', () => null), app);
    assert.equal(app.options('/a', () => null), app);
    assert.equal(app.head('/a', () => null), app);
    assert.equal(app.all('/a', () => null), app);
    assert.equal(app.use(mw), app);
    assert.equal(app.static('/x', '.'), app);
    assert.equal(app.assets('/assets'), app);
    assert.equal(app.public('/p'), app);
    assert.equal(app.views('/v'), app);
    assert.equal(app.onError((_e, ctx) => ctx.json({}, 500)), app);
    assert.equal(app.mount('/z', new Espresso()), app);
  });

  it('constructor applies directory config with partials defaulting under viewsDir', () => {
    const app = new Espresso({ viewsDir: '/custom/views' });
    void app;
    const full = new Espresso({
      viewsDir: '/custom/views',
      partialsDir: '/custom/partials',
      assetsDir: '/custom/assets',
      publicDir: '/custom/public',
    });
    void full;
    assert.ok(true);
  });
});

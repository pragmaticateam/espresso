import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Espresso, Context, Templating } from '../dist/index.js';
import { viewsDir } from './helpers.ts';

const app = () => new Espresso({ viewsDir });

function request(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

describe('Context body parsing', () => {
  it('returns undefined when there is no body (GET)', async () => {
    const a = app();
    a.get('/', async (ctx) => ({ body: (await ctx.body) ?? null }));
    const res = await a.handle(request('/'));
    assert.deepEqual(await res.json(), { body: null });
  });

  it('parses JSON bodies', async () => {
    const a = app();
    a.post('/', async (ctx) => ({ body: await ctx.body }));
    const res = await a.handle(
      request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"n":1,"deep":{"ok":true}}',
      }),
    );
    assert.deepEqual(await res.json(), { body: { n: 1, deep: { ok: true } } });
  });

  it('parses urlencoded bodies into an object', async () => {
    const a = app();
    a.post('/', async (ctx) => ({ body: await ctx.body }));
    const res = await a.handle(
      request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=Alice+One&age=30',
      }),
    );
    assert.deepEqual(await res.json(), { body: { name: 'Alice One', age: '30' } });
  });

  it('parses multipart form data', async () => {
    const a = app();
    a.post('/', async (ctx) => {
      const body = (await ctx.body) as FormData;
      const file = body.get('file') as File;
      return {
        name: body.get('name'),
        fileName: file.name,
        fileText: await file.text(),
      };
    });
    const form = new FormData();
    form.set('name', 'upload');
    form.set('file', new File(['file-content'], 'notes.txt', { type: 'text/plain' }));
    const res = await a.handle(request('/', { method: 'POST', body: form }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'upload', fileName: 'notes.txt', fileText: 'file-content' });
  });

  it('falls back to raw text for unknown content types', async () => {
    const a = app();
    a.post('/', async (ctx) => ({ body: await ctx.body }));
    const res = await a.handle(
      request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: '<root/>',
      }),
    );
    assert.deepEqual(await res.json(), { body: '<root/>' });
  });

  it('treats an empty unknown body as undefined', async () => {
    const a = app();
    a.post('/', async (ctx) => ({ body: (await ctx.body) ?? null }));
    const res = await a.handle(
      request('/', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: '',
      }),
    );
    assert.deepEqual(await res.json(), { body: null });
  });

  it('caches the parsed body promise', async () => {
    const ctx = new Context(
      request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
      {},
      viewsDir,
    );
    const first = ctx.body;
    assert.equal(ctx.body, first);
    assert.equal(ctx.body, first);
    assert.deepEqual(await first, { a: 1 });
  });
});

describe('Context cookies parsing', () => {
  function cookieCtx(header: string): Context {
    return new Context(new Request('http://localhost/', { headers: { cookie: header } }), {}, '.');
  }

  it('parses simple and spaced pairs', () => {
    assert.deepEqual(cookieCtx('a=1;b=2 ; c = three').cookies, { a: '1', b: '2', c: 'three' });
  });

  it('decodes encoded values', () => {
    assert.deepEqual(cookieCtx('msg=hello%20world').cookies, { msg: 'hello world' });
  });

  it('keeps raw values that are not valid percent-encoding', () => {
    assert.deepEqual(cookieCtx('bad=%zz').cookies, { bad: '%zz' });
  });

  it('skips fragments without = or empty keys', () => {
    assert.deepEqual(cookieCtx('novalue;;=x;k=v').cookies, { k: 'v' });
  });

  it('handles missing cookie headers', () => {
    const ctx = new Context(new Request('http://localhost/'), {}, '.');
    assert.deepEqual(ctx.cookies, {});
  });
});

describe('Context request properties', () => {
  it('exposes method, path, query and headers upper-cased method', async () => {
    const a = app();
    let seen: unknown;
    a.get('/items/:id', (ctx) => {
      seen = {
        method: ctx.method,
        path: ctx.path,
        id: ctx.params.id,
        q: ctx.query.get('sort'),
        ua: ctx.headers.get('user-agent'),
      };
      return null;
    });
    await a.handle(request('/items/9?sort=desc', { headers: { 'user-agent': 'vitest' } }));
    assert.deepEqual(seen, {
      method: 'GET',
      path: '/items/9',
      id: '9',
      q: 'desc',
      ua: 'vitest',
    });
  });

  it('uppercases lowercase methods', async () => {
    const a = app();
    let m = '';
    a.get('/', (ctx) => {
      m = ctx.method;
      return null;
    });
    await new Promise<void>((resolve) => {
      const res = a.handle(
        new Request('http://localhost/', { method: 'get' } as RequestInit),
      ) as unknown as Promise<Response>;
      void res.then(resolve);
    });
    assert.equal(m, 'GET');
  });
});

describe('Context response helpers', () => {
  it('json sets the JSON content type and honors status args', async () => {
    const ctx = new Context(request('/'), {}, '.');
    const ok = ctx.json({ hello: 'world' });
    assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-length'), String(Buffer.byteLength('{"hello":"world"}')));

    const created = ctx.json([1, 2], 201);
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), [1, 2]);
  });

  it('json uses ctx.set.status by default', async () => {
    const ctx = new Context(request('/'), {}, '.');
    ctx.set.status = 202;
    assert.equal(ctx.json({}).status, 202);
  });

  it('text sets the plain text content type', async () => {
    const ctx = new Context(request('/'), {}, '.');
    const res = ctx.text('plain and simple', 418);
    assert.equal(res.status, 418);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await res.text(), 'plain and simple');

    assert.equal(ctx.text('defaults').status, 200);
  });

  it('html sets the html content type', async () => {
    const ctx = new Context(request('/'), {}, '.');
    const res = ctx.html('<b>hi</b>');
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), '<b>hi</b>');

    assert.equal(ctx.html('<i>teapot</i>', 418).status, 418);
  });

  it('respond merges set.headers into the response', async () => {
    const ctx = new Context(request('/'), {}, '.');
    ctx.set.headers['x-custom'] = 'yes';
    const res = ctx.json({});
    assert.equal(res.headers.get('x-custom'), 'yes');
  });

  it('redirect sends a location header and empty body', async () => {
    const ctx = new Context(request('/'), {}, '.');
    const res = ctx.redirect('/login');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('content-length'), null);
  });

  it('redirect supports custom status codes', async () => {
    const ctx = new Context(request('/'), {}, '.');
    assert.equal(ctx.redirect('/elsewhere', 307).status, 307);
  });

  it('respond appends set cookies to helper responses', async () => {
    const ctx = new Context(request('/'), {}, '.');
    ctx.set.cookies['sid'] = 'abc def';
    const res = ctx.json({});
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0], `sid=${encodeURIComponent('abc def')}; Path=/`);
  });
});

describe('Context.view rendering', () => {
  it('renders a template from the configured views dir as HTML', async () => {
    const a = app();
    a.get('/', (ctx) =>
      ctx.view('home', {
        title: 'Home',
        siteName: 'MySite',
        user: { name: 'Ada', admin: false },
        items: ['one', 'two'],
        visitor: { greeting: 'Hi', name: 'Ada' },
        lang: 'en',
        rawHtml: '<hr/>',
      }),
    );
    const res = await a.handle(request('/'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('<header>Home | MySite</header>'), html);
    assert.ok(html.includes('<p>Hello, Ada!</p>'), html);
    assert.ok(html.includes('<li data-i="0">one & Home</li>'), html);
    assert.ok(html.includes('<b>Hi, Ada (en)</b>'), html);
    assert.ok(html.includes('<hr/>'), html);
    assert.ok(!html.includes('{{'), html);
  });

  it('renders without any data object', async () => {
    const a = app();
    a.get('/', (ctx) => ctx.view('dup'));
    const res = await a.handle(request('/'));
    assert.equal((await res.text()).trim(), 'dup-espresso');
  });

  it('supports rendering without data', async () => {
    const engine = new Templating({ viewsDir });
    const ctx = new Context(request('/'), {}, viewsDir);
    assert.equal(ctx.getTemplating(), ctx.getTemplating());
    assert.notEqual(ctx.getTemplating(), engine);
    const res = await ctx.html(await engine.loadView('plain', { page: '1' }));
    assert.ok((await res.text()).includes('plain 1'));
  });
});

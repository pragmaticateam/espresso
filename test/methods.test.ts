import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Espresso } from '../dist/index.js';

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe('HTTP verbs', () => {
  it('GET returns JSON objects', async () => {
    const app = new Espresso().get('/ping', () => ({ pong: true }));
    const res = await app.handle(req('/ping'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pong: true });
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });

  it('POST parses and echoes bodies', async () => {
    const app = new Espresso().post('/things', async (ctx) => ({
      created: await ctx.body,
      status: ctx.set.status,
    }));
    const res = await app.handle(
      req('/things', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"mug"}',
      }),
    );
    assert.deepEqual(await res.json(), { created: { name: 'mug' }, status: 200 });
  });

  it('PUT updates with typed params', async () => {
    const app = new Espresso().put('/things/:id', ({ params }) => ({ updated: params.id }));
    const res = await app.handle(
      req('/things/12', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assert.deepEqual(await res.json(), { updated: '12' });
  });

  it('PATCH partially updates', async () => {
    const app = new Espresso().patch('/things/:id', ({ params }) => ({ patched: params.id }));
    const res = await app.handle(
      req('/things/7', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{"price":9}',
      }),
    );
    assert.deepEqual(await res.json(), { patched: '7' });
  });

  it('DELETE removes and can return undefined', async () => {
    const app = new Espresso().delete('/things/:id', () => {
      void 0;
    });
    const res = await app.handle(req('/things/3', { method: 'DELETE' }));
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
    assert.equal(await res.text(), '');
  });

  it('OPTIONS and HEAD register like other verbs', async () => {
    const app = new Espresso()
      .options('/info', () => 'options-ok')
      .head('/info', () => null);
    const opt = await app.handle(req('/info', { method: 'OPTIONS' }));
    assert.equal(await opt.text(), 'options-ok');
    assert.match(opt.headers.get('content-type') ?? '', /text\/plain/);
    const head = await app.handle(req('/info', { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
  });

  it('all() matches every method', async () => {
    const app = new Espresso().all('/echo-method', (ctx) => ({ method: ctx.method }));
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await app.handle(req('/echo-method', { method }));
      assert.deepEqual(await res.json(), { method });
    }
  });
});

describe('routing behavior through handle()', () => {
  it('returns the canonical 404 for unknown paths', async () => {
    const res = await new Espresso().handle(req('/nowhere'));
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '{"error":"Not Found"}');
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength('{"error":"Not Found"}')));
  });

  it('404s when only the method differs', async () => {
    const app = new Espresso().get('/only-get', () => 'nope');
    const post = await app.handle(req('/only-get', { method: 'POST' }));
    assert.equal(post.status, 404);
  });

  it('matches routes registered with a trailing slash', async () => {
    const app = new Espresso().get('/trailing/', () => 'trimmed');
    const res = await app.handle(req('/trailing'));
    assert.equal(await res.text(), 'trimmed');
  });

  it('ignores query strings when matching', async () => {
    const app = new Espresso().get('/search', ({ query }) => ({ q: query.get('q') }));
    const res = await app.handle(req('/search?q=espresso&size=2'));
    assert.deepEqual(await res.json(), { q: 'espresso' });
  });

  it('decodes percent-encoded params', async () => {
    const app = new Espresso().get('/name/:value', ({ params }) => ({ value: params.value }));
    const res = await app.handle(req('/name/hello%20world%2F'));
    assert.deepEqual(await res.json(), { value: 'hello world/' });
  });

  it('serves wildcard tails', async () => {
    const app = new Espresso().get('/docs/*', ({ params }) => ({ rest: params['*'] }));
    const res = await app.handle(req('/docs/a/b/c.md'));
    assert.deepEqual(await res.json(), { rest: 'a/b/c.md' });
  });

  it('500s through the default handler when params contain bad escapes', async () => {
    const app = new Espresso().get('/x/:v', ({ params }) => ({ v: params.v }));
    const res = await app.handle(req('/x/%zz'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'URI malformed' });
  });

  it('default error handler reports Error messages and falls back otherwise', async () => {
    const errApp = new Espresso().get('/err', (): never => {
      throw new Error('explicit failure');
    });
    const res = await errApp.handle(req('/err'));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'explicit failure' });

    const strApp = new Espresso().get('/str', (): never => {
      throw 'a string failure';
    });
    const res2 = await strApp.handle(req('/str'));
    assert.equal(res2.status, 500);
    assert.deepEqual(await res2.json(), { error: 'Internal Server Error' });
  });

  it('first matching route wins', async () => {
    const app = new Espresso()
      .get('/dup', () => 'first')
      .get('/dup', () => 'second');
    const res = await app.handle(req('/dup'));
    assert.equal(await res.text(), 'first');
  });
});

describe('return-value normalization', () => {
  const cases: Array<[string, unknown, (res: Response) => Promise<void>]> = [
    [
      'Response passes through untouched',
      new Response('raw', { status: 203, headers: { 'x-kept': 'yes' } }),
      async (res) => {
        assert.equal(res.status, 203);
        assert.equal(res.headers.get('x-kept'), 'yes');
        assert.equal(await res.text(), 'raw');
      },
    ],
    [
      'undefined becomes an empty response honoring set.status',
      undefined,
      async (res) => {
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '');
      },
    ],
    [
      'null becomes an empty response',
      null,
      async (res) => {
        assert.equal(await res.text(), '');
      },
    ],
    [
      'strings become text/plain',
      'just text',
      async (res) => {
        assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
        assert.equal(await res.text(), 'just text');
      },
    ],
    [
      'Uint8Array is passed through as bytes',
      new TextEncoder().encode('binary-bytes'),
      async (res) => {
        assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new TextEncoder().encode('binary-bytes'));
      },
    ],
    [
      'ArrayBuffer is passed through as bytes',
      new TextEncoder().encode('buffered').buffer,
      async (res) => {
        assert.equal(new TextDecoder().decode(await res.arrayBuffer()), 'buffered');
      },
    ],
    [
      'typed array views are passed through as bytes',
      new Int8Array([104, 105]),
      async (res) => {
        assert.equal(new TextDecoder().decode(await res.arrayBuffer()), 'hi');
      },
    ],
    [
      'objects become JSON',
      { a: 1, nested: { b: [true] } },
      async (res) => {
        assert.deepEqual(await res.json(), { a: 1, nested: { b: [true] } });
      },
    ],
    [
      'arrays become JSON',
      [1, 'two'],
      async (res) => {
        assert.deepEqual(await res.json(), [1, 'two']);
      },
    ],
  ];

  for (const [name, returned, check] of cases) {
    it(name, async () => {
      const app = new Espresso().get('/x', () => returned);
      const res = await app.handle(req('/x'));
      await check(res);
    });
  }

  it('set.status and set.headers apply to string responses', async () => {
    const app = new Espresso().get('/x', (ctx) => {
      ctx.set.status = 201;
      ctx.set.headers['x-created'] = '1';
      return 'made';
    });
    const res = await app.handle(req('/x'));
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-created'), '1');
    assert.equal(await res.text(), 'made');
  });

  it('cookies are appended to string and object responses', async () => {
    const stringApp = new Espresso().get('/s', (ctx) => {
      ctx.set.cookies['flavor'] = 'mocha';
      return 'cookie!';
    });
    const objApp = new Espresso().get('/o', (ctx) => {
      ctx.set.cookies['flavor'] = 'latte';
      return {};
    });
    assert.match((await stringApp.handle(req('/s'))).headers.getSetCookie()[0], /^flavor=mocha/);
    assert.match((await objApp.handle(req('/o'))).headers.getSetCookie()[0], /^flavor=latte/);
  });

  it('async handlers are awaited', async () => {
    const app = new Espresso().get('/slow', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { waited: true };
    });
    assert.deepEqual(await (await app.handle(req('/slow'))).json(), { waited: true });
  });
});

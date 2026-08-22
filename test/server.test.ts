import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Espresso } from '../dist/index.js';
import { publicDir, startServer, viewsDir } from './helpers.ts';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = httpRequest(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function buildApp(): Espresso {
  return new Espresso({ viewsDir })
    .get('/hello', () => ({ hello: 'wire' }))
    .post('/echo', async (ctx) => ({ body: await ctx.body }))
    .put('/items/:id', ({ params }) => ({ put: params.id }))
    .patch('/items/:id', ({ params }) => ({ patch: params.id }))
    .delete('/items/:id', ({ params }) => ({ deleted: params.id }))
    .options('/items/:id', () => 'opt')
    .head('/hello', () => 'ignored-body')
    .get('/no-content', (ctx) => {
      ctx.set.status = 204;
      return undefined;
    })
    .get('/cookies', (ctx) => {
      ctx.set.cookies['a'] = 'one';
      ctx.set.cookies['b'] = 'two';
      return { done: true };
    })
    .get('/redirect', (ctx) => ctx.redirect('/hello', 301))
    .get('/view-page', (ctx) => ctx.view('plain', { page: 'wired' }))
    .static('/files', publicDir)
    .get('/big', () => 'y'.repeat(400_000))
    .get('/boom', (): never => {
      throw new Error('socket failure');
    });
}

describe('app.listen launches a real HTTP server', () => {
  it('serves every verb, statuses, cookies, redirects, views and statics over the wire', async () => {
    const instance = buildApp();
    assert.equal(instance.serverInstance, null);
    const { base, close } = await startServer(instance);
    try {
      assert.notEqual(instance.serverInstance, null);

      // GET returns JSON
      const hello = await raw(base, '/hello');
      assert.equal(hello.status, 200);
      assert.match(String(hello.headers['content-type']), /application\/json/);
      assert.deepEqual(JSON.parse(hello.body), { hello: 'wire' });

      // POST streams the request body through Readable.toWeb
      const echoed = await raw(base, '/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ over: 'the wire' }),
      });
      assert.equal(echoed.status, 200);
      assert.deepEqual(JSON.parse(echoed.body).body, { over: 'the wire' });

      // PUT / PATCH / DELETE / OPTIONS with params
      const put = await raw(base, '/items/9', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.deepEqual(JSON.parse(put.body), { put: '9' });

      const patch = await raw(base, '/items/9', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.deepEqual(JSON.parse(patch.body), { patch: '9' });

      assert.deepEqual(
        JSON.parse((await raw(base, '/items/9', { method: 'DELETE' })).body),
        { deleted: '9' },
      );
      assert.equal((await raw(base, '/items/9', { method: 'OPTIONS' })).body, 'opt');

      // HEAD sends headers only
      const head = await raw(base, '/hello', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body, '');

      // 204 with a null body
      const noContent = await raw(base, '/no-content');
      assert.equal(noContent.status, 204);
      assert.equal(noContent.body, '');

      // Multiple set-cookie headers survive the hop
      const cookies = await raw(base, '/cookies');
      const cookieHeaders = cookies.headers['set-cookie'];
      assert.ok(Array.isArray(cookieHeaders));
      assert.deepEqual(
        cookieHeaders.map((c) => c.split(';')[0]).sort(),
        ['a=one', 'b=two'],
      );

      // Redirect carries location
      const redirect = await raw(base, '/redirect');
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.location, '/hello');

      // Views render over the wire
      const view = await raw(base, '/view-page');
      assert.match(view.body, /plain wired/);
      assert.match(String(view.headers['content-type']), /text\/html/);

      // Static files serve over the wire
      const file = await raw(base, '/files/robots.txt');
      assert.equal(file.status, 200);
      assert.match(file.body, /User-agent/);

      // Large bodies stream through in chunks
      const big = await raw(base, '/big');
      assert.equal(big.body.length, 400_000);

      // Errors map to 500 responses
      const boom = await raw(base, '/boom');
      assert.equal(boom.status, 500);
      assert.deepEqual(JSON.parse(boom.body), { error: 'socket failure' });

      // Unknown paths 404
      assert.equal((await raw(base, '/missing')).status, 404);

      // Query strings are preserved through URL construction
      assert.equal((await raw(base, '/hello?extra=1')).status, 200);
    } finally {
      await close();
      assert.equal(instance.serverInstance!.listening, false);
    }
  });

  it('exposes the address of the running server', async () => {
    const instance = buildApp();
    const { base, close } = await startServer(instance);
    try {
      const address = instance.serverInstance!.address() as { port: number };
      const res = await raw(`http://127.0.0.1:${address.port}`, '/hello');
      assert.equal(res.status, 200);
      assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await close();
    }
  });

  it('listen() falls back to the default port and hostname', async () => {
    const instance = buildApp();
    await new Promise<void>((resolve) => {
      instance.listen(resolve);
    });
    try {
      assert.equal((instance.serverInstance!.address() as { port: number }).port, 3000);
      const res = await raw('http://127.0.0.1:3000', '/hello');
      assert.equal(res.status, 200);
    } finally {
      instance.serverInstance!.close();
      await new Promise<void>((r) => instance.serverInstance!.once('close', () => r()));
    }
  });
});

interface FakeRes extends ServerResponse {
  headers: Record<string, unknown>;
  ended: boolean;
  text: string;
}

function makeFakeRes(): FakeRes {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    ended: false,
    text: '',
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    appendHeader(key: string, value: string) {
      const k = key.toLowerCase();
      const existing = this.headers[k];
      if (Array.isArray(existing)) existing.push(value);
      else this.headers[k] = [value];
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
    },
    write(chunk?: Buffer | string) {
      if (chunk !== undefined && chunk !== null) this.text += chunk.toString();
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined && chunk !== null) this.text += chunk.toString();
      this.ended = true;
    },
  };
  return res as unknown as FakeRes;
}

const callConnection = (
  instance: Espresso,
  req: Partial<IncomingMessage> | null,
  res: ServerResponse,
): Promise<void> =>
  (
    instance as unknown as {
      handleConnection(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).handleConnection(req as IncomingMessage, res);

describe('handleConnection failure handling', () => {
  it('returns 500 when converting the incoming message fails', async () => {
    const instance = buildApp();
    const res = makeFakeRes();
    await callConnection(instance, null, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(res.ended);
    assert.match(res.text, /"error":/);
  });

  it('falls back to localhost and / when url or host are missing', async () => {
    const instance = buildApp();
    const res = makeFakeRes();
    await callConnection(instance, { url: undefined, method: 'HEAD', headers: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(res.ended);
    assert.equal(res.text, '');
  });

  it('writes full streamed bodies for non-HEAD requests', async () => {
    const instance = buildApp();
    const res = makeFakeRes();
    await callConnection(
      instance,
      { url: '/hello', method: 'GET', headers: { host: 'example.org:5' } },
      res,
    );
    // Piping is asynchronous; wait for the stream to flush.
    for (let i = 0; i < 100 && !res.ended; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(res.statusCode, 200);
    assert.equal(res.text, JSON.stringify({ hello: 'wire' }));
    assert.ok(res.ended);
  });

  it('propagates set-cookie through appendHeader without duplicating plain headers', async () => {
    const instance = buildApp();
    const res = makeFakeRes();
    await callConnection(
      instance,
      { url: '/cookies', method: 'GET', headers: { host: 'example.org' } },
      res,
    );
    assert.equal(res.statusCode, 200);
    const cookies = res.headers['set-cookie'];
    assert.ok(Array.isArray(cookies));
    assert.equal(cookies.length, 2);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  });

  it('ends immediately for null-body responses', async () => {
    const instance = buildApp();
    const res = makeFakeRes();
    await callConnection(
      instance,
      { url: '/no-content', method: 'GET', headers: { host: 'example.org' } },
      res,
    );
    assert.equal(res.statusCode, 204);
    assert.equal(res.text, '');
    assert.ok(res.ended);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Espresso, csrf } from '../dist/index.js';

const req = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const withCookie = (path: string, cookie: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('cookie', cookie);
  return new Request(`http://localhost${path}`, { ...init, headers });
};

const getCookie = (res: Response, name: string): string | undefined => {
  for (const h of res.headers.getSetCookie()) {
    const match = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
};

const hasCookie = (res: Response, name: string): boolean =>
  getCookie(res, name) !== undefined;

describe('csrf – auto-generation', () => {
  it('sets a CSRF cookie on GET when none exists', async () => {
    const app = new Espresso().use(csrf()).get('/', () => 'ok');
    const res = await app.handle(req('/'));
    assert.ok(hasCookie(res, '_csrf'), 'should set _csrf cookie');
    const token = getCookie(res, '_csrf');
    assert.ok(token!.length > 0);
    assert.equal(await res.text(), 'ok');
  });

  it('does not set a new cookie when one already exists', async () => {
    const app = new Espresso().use(csrf()).get('/', () => 'ok');
    const res = await app.handle(withCookie('/', '_csrf=existingtoken'));
    const cookies = res.headers.getSetCookie();
    assert.ok(!cookies.some((c) => c.startsWith('_csrf=')), 'should not set new cookie');
    assert.equal(await res.text(), 'ok');
  });

  it('sets SameSite=Strict and HttpOnly=false on the cookie', async () => {
    const app = new Espresso().use(csrf()).get('/', () => 'ok');
    const res = await app.handle(req('/'));
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('_csrf='));
    assert.ok(raw);
    assert.ok(raw.includes('SameSite=Strict'));
    assert.ok(raw.includes('HttpOnly=false'));
    assert.ok(raw.includes('Path=/'));
  });
});

describe('csrf – validation on state-changing methods', () => {
  const setup = () =>
    new Espresso()
      .use(csrf())
      .post('/', (ctx) => ctx.json({ ok: true }))
      .put('/', (ctx) => ctx.json({ ok: true }))
      .patch('/', (ctx) => ctx.json({ ok: true }))
      .delete('/', (ctx) => ctx.json({ ok: true }));

  it('allows POST with matching token in header', async () => {
    const token = 'abc123';
    const app = setup();
    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'POST', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(res.status, 200);
  });

  it('rejects POST without token header', async () => {
    const app = setup();
    const res = await app.handle(
      withCookie('/', '_csrf=abc', { method: 'POST' }),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'CSRF token missing or invalid' });
  });

  it('rejects POST with mismatched token', async () => {
    const app = setup();
    const res = await app.handle(
      withCookie('/', '_csrf=abc', { method: 'POST', headers: { 'x-csrf-token': 'wrong' } }),
    );
    assert.equal(res.status, 403);
  });

  it('rejects POST with no cookie token', async () => {
    const app = setup();
    const res = await app.handle(
      req('/', { method: 'POST', headers: { 'x-csrf-token': 'something' } }),
    );
    assert.equal(res.status, 403);
  });

  it('allows PUT with matching token', async () => {
    const token = 'tok';
    const app = setup();
    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'PUT', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(res.status, 200);
  });

  it('allows PATCH with matching token', async () => {
    const token = 'tok';
    const app = setup();
    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'PATCH', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(res.status, 200);
  });

  it('allows DELETE with matching token', async () => {
    const token = 'tok';
    const app = setup();
    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'DELETE', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(res.status, 200);
  });
});

describe('csrf – safe methods pass through', () => {
  it('GET does not require a token', async () => {
    const app = new Espresso().use(csrf()).get('/', () => 'ok');
    const res = await app.handle(req('/'));
    assert.equal(res.status, 200);
  });

  it('HEAD does not require a token', async () => {
    const app = new Espresso()
      .use(csrf())
      .get('/', () => 'ok')
      .head('/', () => 'ok');
    const res = await app.handle(withCookie('/', '_csrf=tok', { method: 'HEAD' }));
    assert.equal(res.status, 200);
  });

  it('OPTIONS does not require a token', async () => {
    const app = new Espresso()
      .use(csrf())
      .get('/', () => 'ok')
      .options('/', () => 'ok');
    const res = await app.handle(withCookie('/', '_csrf=tok', { method: 'OPTIONS' }));
    assert.equal(res.status, 200);
  });
});

describe('csrf – custom header name', () => {
  it('validates against a custom header', async () => {
    const token = 'custom-tok';
    const app = new Espresso()
      .use(csrf({ headerName: 'X-XSRF-Token' }))
      .post('/', () => 'ok');

    const match = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'POST', headers: { 'x-xsrf-token': token } }),
    );
    assert.equal(match.status, 200);

    const miss = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'POST', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(miss.status, 403);
  });
});

describe('csrf – custom cookie name', () => {
  it('reads from and sets a custom cookie name', async () => {
    const token = 'mytoken';
    const app = new Espresso()
      .use(csrf({ cookieName: 'XSRF-TOKEN' }))
      .post('/', () => 'ok');

    const res = await app.handle(
      withCookie('/', `XSRF-TOKEN=${token}`, { method: 'POST', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(res.status, 200);
  });

  it('auto-generates with custom cookie name', async () => {
    const app = new Espresso()
      .use(csrf({ cookieName: 'XSRF-TOKEN' }))
      .get('/', () => 'ok');

    const res = await app.handle(req('/'));
    assert.ok(hasCookie(res, 'XSRF-TOKEN'));
  });
});

describe('csrf – custom methods', () => {
  it('only validates configured methods', async () => {
    const app = new Espresso()
      .use(csrf({ methods: 'POST' }))
      .post('/', () => 'ok')
      .put('/', () => 'ok');

    const postRes = await app.handle(
      withCookie('/', '_csrf=tok', { method: 'POST' }),
    );
    assert.equal(postRes.status, 403);

    const putRes = await app.handle(
      withCookie('/', '_csrf=tok', { method: 'PUT' }),
    );
    assert.equal(putRes.status, 200);
  });
});

describe('csrf – validateAllMethods', () => {
  it('validates safe methods when validateAllMethods is true', async () => {
    const app = new Espresso()
      .use(csrf({ validateAllMethods: true }))
      .get('/', () => 'ok');

    const res = await app.handle(
      withCookie('/', '_csrf=tok', { method: 'GET', headers: { 'x-csrf-token': 'wrong' } }),
    );
    assert.equal(res.status, 403);
  });

  it('allows safe methods with correct token when validateAllMethods is true', async () => {
    const token = 'right';
    const app = new Espresso()
      .use(csrf({ validateAllMethods: true }))
      .get('/', () => 'ok');

    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'GET', headers: { 'x-csrf-token': token } }),
    );
    assert.equal(res.status, 200);
  });
});

describe('csrf – custom generateToken', () => {
  it('uses the custom generator', async () => {
    const fixed = 'fixed-token-value';
    const app = new Espresso()
      .use(csrf({ generateToken: () => fixed }))
      .get('/', () => 'ok');

    const res = await app.handle(req('/'));
    assert.equal(getCookie(res, '_csrf'), fixed);
  });
});

describe('csrf – custom getToken', () => {
  it('extracts token via custom getter', async () => {
    const token = 'from-auth';
    const app = new Espresso()
      .use(csrf({
        getToken: (ctx) => ctx.headers.get('authorization')?.replace('Bearer ', '') ?? null,
      }))
      .post('/', () => 'ok');

    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
    );
    assert.equal(res.status, 200);
  });
});

describe('csrf – custom validateToken', () => {
  it('uses custom validator', async () => {
    const app = new Espresso()
      .use(csrf({ validateToken: (cookie, submitted) => cookie === submitted.toUpperCase() }))
      .post('/', () => 'ok');

    const match = await app.handle(
      withCookie('/', '_csrf=ABC', { method: 'POST', headers: { 'x-csrf-token': 'abc' } }),
    );
    assert.equal(match.status, 200);

    const miss = await app.handle(
      withCookie('/', '_csrf=ABC', { method: 'POST', headers: { 'x-csrf-token': 'xyz' } }),
    );
    assert.equal(miss.status, 403);
  });
});

describe('csrf – custom cookie options', () => {
  it('respects custom SameSite and Path', async () => {
    const app = new Espresso()
      .use(csrf({ cookieSameSite: 'Lax', cookiePath: '/api' }))
      .get('/', () => 'ok');

    const res = await app.handle(req('/'));
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('_csrf='));
    assert.ok(raw);
    assert.ok(raw.includes('SameSite=Lax'));
    assert.ok(raw.includes('Path=/api'));
  });
});

describe('csrf – 404 responses still get cookie', () => {
  it('sets CSRF cookie even on 404', async () => {
    const app = new Espresso().use(csrf()).get('/exists', () => 'ok');
    const res = await app.handle(req('/nope'));
    assert.equal(res.status, 404);
    assert.ok(hasCookie(res, '_csrf'));
  });
});

describe('csrf – 500 error handler responses', () => {
  it('sets CSRF cookie on error responses', async () => {
    const app = new Espresso()
      .use(csrf({ generateToken: () => 'err-tok' }))
      .get('/', () => {
        throw new Error('boom');
      });
    app.onError(() => new Response('error', { status: 500 }));
    const res = await app.handle(req('/'));
    assert.equal(res.status, 500);
  });
});

describe('csrf – integration with handler return values', () => {
  it('sets cookie when handler returns an object', async () => {
    const app = new Espresso().use(csrf()).get('/', () => ({ data: 1 }));
    const res = await app.handle(req('/'));
    assert.ok(hasCookie(res, '_csrf'));
    assert.deepEqual(await res.json(), { data: 1 });
  });

  it('sets cookie when handler returns a string', async () => {
    const app = new Espresso().use(csrf()).get('/', () => 'hello');
    const res = await app.handle(req('/'));
    assert.ok(hasCookie(res, '_csrf'));
    assert.equal(await res.text(), 'hello');
  });

  it('sets cookie when handler returns a Response', async () => {
    const app = new Espresso().use(csrf()).get('/', () => new Response('raw'));
    const res = await app.handle(req('/'));
    assert.ok(hasCookie(res, '_csrf'));
    assert.equal(await res.text(), 'raw');
  });
});

describe('csrf – combined with cors', () => {
  it('works alongside the cors middleware', async () => {
    const { cors } = await import('../dist/index.js');
    const token = 'both';
    const app = new Espresso()
      .use(cors({ origin: '*' }))
      .use(csrf())
      .post('/', () => 'ok');

    const res = await app.handle(
      withCookie('/', `_csrf=${token}`, {
        method: 'POST',
        headers: {
          'x-csrf-token': token,
          origin: 'https://example.com',
        },
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Espresso, cors } from '../dist/index.js';

const req = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const preflight = (path: string, origin?: string, method?: string) =>
  req(path, {
    method: 'OPTIONS',
    headers: {
      'access-control-request-method': method ?? 'POST',
      ...(origin ? { origin } : {}),
    },
  });

const withOrigin = (path: string, origin: string, method = 'GET') =>
  req(path, { method, headers: { origin } });

describe('cors – defaults', () => {
  it('sets Access-Control-Allow-Origin: * on GET responses', async () => {
    const app = new Espresso()
      .use(cors())
      .get('/', () => ({ ok: true }));

    const res = await app.handle(withOrigin('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('responds to preflight OPTIONS with 204 and all default headers', async () => {
    const app = new Espresso()
      .use(cors())
      .post('/', () => null);

    const res = await app.handle(preflight('/', 'https://example.com', 'POST'));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET,HEAD,PUT,PATCH,POST,DELETE');
    assert.equal(res.headers.get('access-control-allow-headers'), '*');
    assert.equal(res.headers.get('access-control-max-age'), '86400');
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  it('sets CORS headers on 404 responses too', async () => {
    const app = new Espresso().use(cors()).get('/exists', () => null);

    const res = await app.handle(withOrigin('/nope', 'https://example.com'));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

describe('cors – single origin', () => {
  it('reflects the configured origin when it matches', async () => {
    const app = new Espresso()
      .use(cors({ origin: 'https://example.com' }))
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
  });

  it('omits the CORS origin header when the request origin does not match', async () => {
    const app = new Espresso()
      .use(cors({ origin: 'https://example.com' }))
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://evil.com'));
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('preflight reflects the configured origin', async () => {
    const app = new Espresso()
      .use(cors({ origin: 'https://example.com' }))
      .post('/', () => null);

    const res = await app.handle(preflight('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
  });
});

describe('cors – origin list', () => {
  it('reflects the matching origin from the list', async () => {
    const app = new Espresso()
      .use(cors({ origin: ['https://a.com', 'https://b.com'] }))
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://b.com'));
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://b.com');
  });

  it('omits the header when the origin is not in the list', async () => {
    const app = new Espresso()
      .use(cors({ origin: ['https://a.com', 'https://b.com'] }))
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://c.com'));
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('cors – origin function', () => {
  it('uses the return value of the origin function', async () => {
    const app = new Espresso()
      .use(cors({
        origin: (o) => o.endsWith('.example.com') ? o : null,
      }))
      .get('/', () => 'ok');

    const match = await app.handle(withOrigin('/', 'https://sub.example.com'));
    assert.equal(match.headers.get('access-control-allow-origin'), 'https://sub.example.com');

    const miss = await app.handle(withOrigin('/', 'https://evil.com'));
    assert.equal(miss.headers.get('access-control-allow-origin'), null);
  });
});

describe('cors – preflight status', () => {
  it('responds with 200 when preflightStatus is 200', async () => {
    const app = new Espresso()
      .use(cors({ preflightStatus: 200 }))
      .post('/', () => null);

    const res = await app.handle(preflight('/', 'https://example.com'));
    assert.equal(res.status, 200);
  });
});

describe('cors – credentials', () => {
  it('includes Allow-Credentials: true when credentials is set', async () => {
    const app = new Espresso()
      .use(cors({ credentials: true, origin: 'https://example.com' }))
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  it('does not send credentials header by default', async () => {
    const app = new Espresso()
      .use(cors())
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });
});

describe('cors – custom methods and headers', () => {
  it('respects custom methods', async () => {
    const app = new Espresso()
      .use(cors({ methods: 'GET,POST' }))
      .post('/', () => null);

    const res = await app.handle(preflight('/', 'https://example.com', 'POST'));
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET,POST');
  });

  it('respects custom allowedHeaders', async () => {
    const app = new Espresso()
      .use(cors({ allowedHeaders: 'X-Custom,X-Other' }))
      .post('/', () => null);

    const res = await app.handle(preflight('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-allow-headers'), 'X-Custom,X-Other');
  });

  it('sets exposedHeaders on non-preflight responses', async () => {
    const app = new Espresso()
      .use(cors({ exposedHeaders: 'X-Total-Count,X-Page' }))
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-expose-headers'), 'X-Total-Count,X-Page');
  });

  it('respects custom maxAge', async () => {
    const app = new Espresso()
      .use(cors({ maxAge: 3600 }))
      .post('/', () => null);

    const res = await app.handle(preflight('/', 'https://example.com'));
    assert.equal(res.headers.get('access-control-max-age'), '3600');
  });
});

describe('cors – no origin header', () => {
  it('sets * when there is no Origin header (same-origin request)', async () => {
    const app = new Espresso()
      .use(cors())
      .get('/', () => 'ok');

    const res = await app.handle(req('/'));
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('does not set CORS headers when origin function returns null and no origin header', async () => {
    const app = new Espresso()
      .use(cors({ origin: () => null }))
      .get('/', () => 'ok');

    const res = await app.handle(req('/'));
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

describe('cors – integration with app.use()', () => {
  it('works as global middleware with the full pipeline', async () => {
    const app = new Espresso()
      .use(cors({ origin: 'https://trusted.com' }))
      .get('/api/data', () => ({ data: 42 }))
      .post('/api/data', () => null);

    const res = await app.handle(withOrigin('/api/data', 'https://trusted.com'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://trusted.com');
    assert.deepEqual(await res.json(), { data: 42 });
  });

  it('works with path-scoped CORS', async () => {
    const app = new Espresso()
      .use('/api', cors({ origin: 'https://api.example.com' }))
      .get('/api/data', () => 'api')
      .get('/other', () => 'other');

    const apiRes = await app.handle(withOrigin('/api/data', 'https://api.example.com'));
    assert.equal(apiRes.headers.get('access-control-allow-origin'), 'https://api.example.com');

    const otherRes = await app.handle(withOrigin('/other', 'https://api.example.com'));
    assert.equal(otherRes.headers.get('access-control-allow-origin'), null);
  });

  it('combined with logger', async () => {
    const { logger } = await import('../dist/index.js');
    const app = new Espresso()
      .use(logger({ colors: false, timestamp: 'none' }))
      .use(cors())
      .get('/', () => 'ok');

    const res = await app.handle(withOrigin('/', 'https://example.com'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

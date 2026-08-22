import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INDEX_FILE, mimeFor, serveStaticFile } from '../dist/core/static.js';
import { Espresso } from '../dist/index.js';
import { fixtureDir } from './helpers.ts';

const req = (path: string) => new Request(`http://localhost${path}`);
const publicDir = `${fixtureDir}/public`;
const assetsDir = `${fixtureDir}/assets`;

describe('mimeFor', () => {
  it('maps known extensions', () => {
    const expected: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.txt': 'text/plain; charset=utf-8',
      '.xml': 'application/xml; charset=utf-8',
      '.wasm': 'application/wasm',
      '.map': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
    };
    for (const [ext, mime] of Object.entries(expected)) {
      assert.equal(mimeFor(`file${ext}`), mime, ext);
    }
  });

  it('is case-insensitive and falls back to octet-stream', () => {
    assert.equal(mimeFor('IMAGE.PNG'), 'image/png');
    assert.equal(mimeFor('archive.tar.gz.unknownext'), 'application/octet-stream');
    assert.equal(mimeFor('noextension'), 'application/octet-stream');
  });
});

describe('INDEX_FILE constant', () => {
  it('is index.html', () => {
    assert.equal(INDEX_FILE, 'index.html');
  });
});

describe('serveStaticFile', () => {
  it('serves files with content type and length headers', async () => {
    const res = await serveStaticFile(publicDir, '/robots.txt')!;
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.startsWith('User-agent'));
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(body)));
  });

  it('serves the index file for the prefix root', async () => {
    const res = (await serveStaticFile(publicDir, '/'))!;
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok((await res.text()).includes('<title>index</title>'));
  });

  it('returns null for missing files so routing can continue', async () => {
    assert.equal(await serveStaticFile(publicDir, '/does-not-exist.txt'), null);
  });

  it('rejects path traversal outside the root with 403', async () => {
    const res = (await serveStaticFile(publicDir, '/../secrets.txt'))!;
    assert.equal(res.status, 403);
    assert.equal(await res.text(), 'Forbidden');
  });
});

describe('static serving through the app', () => {
  it('.static(prefix, dir) serves files under the prefix', async () => {
    const app = new Espresso().static('/static', publicDir);
    const res = await app.handle(req('/static/robots.txt'));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('Disallow'));
  });

  it('.assets() serves the configured assetsDir under /assets by default', async () => {
    const app = new Espresso({ assetsDir }).assets();
    const custom = new Espresso({ assetsDir }).assets('/styles');
    const def = await app.handle(req('/assets/style.css'));
    assert.equal(def.status, 200);
    assert.match(def.headers.get('content-type') ?? '', /text\/css/);
    assert.equal((await custom.handle(req('/styles/style.css'))).status, 200);
  });

  it('.public() serves publicDir at / and falls back to its index.html', async () => {
    const app = new Espresso({ publicDir }).public();
    const file = await app.handle(req('/robots.txt'));
    assert.equal(file.status, 200);
    const root = await app.handle(req('/'));
    assert.equal(root.status, 200);
    assert.ok((await root.text()).includes('<title>index</title>'));
  });

  it('.views() serves raw view sources as static HTML', async () => {
    const app = new Espresso({ viewsDir: `${fixtureDir}/views` }).views('/raw');
    const res = await app.handle(req('/raw/home.espresso'));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('{{ #if user }}'));
  });

  it('missing static files inside a matched prefix fall through to 404', async () => {
    const app = new Espresso().static('/files', publicDir).get('/fallback', () => 'route');
    assert.equal((await app.handle(req('/files/nope.bin'))).status, 404);
    assert.equal(await (await app.handle(req('/fallback'))).text(), 'route');
  });

  it('routes take precedence over static prefixes', async () => {
    const app = new Espresso({ publicDir })
      .public()
      .get('/robots.txt', () => ({ dynamic: true }));
    const res = await app.handle(req('/robots.txt'));
    assert.deepEqual(await res.json(), { dynamic: true });
  });

  it('prefixes must match on segment boundaries', async () => {
    const app = new Espresso().static('/img', assetsDir);
    assert.equal((await app.handle(req('/images/style.css'))).status, 404);
  });
});

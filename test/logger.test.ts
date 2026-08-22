import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { logger as createLogger, type LogEntry } from '../dist/index.js';
import { captureConsole, sleep } from './helpers.ts';

interface FakeCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  set: { status: number };
}

const run = (
  options: Parameters<typeof createLogger>[0],
  ctx: Partial<FakeCtx>,
  handler: unknown,
): Promise<unknown> =>
  createLogger(options)(
    {
      method: 'GET',
      path: '/x',
      query: new URLSearchParams(),
      set: { status: 200 },
      ...ctx,
    } as FakeCtx,
    async () =>
      typeof handler === 'function' ? (handler as () => unknown)() : handler,
  );

const respond = (body: string | BodyInit | null, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  if (typeof body === 'string' && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)));
  }
  return new Response(body, { ...init, headers });
};

describe('logger sink entries', () => {
  it('records method, path, query, status, size and timing', async () => {
    const entries: LogEntry[] = [];
    const res = (await run(
      { onLog: (e) => entries.push(e), colors: false, timestamp: 'none' },
      { query: new URLSearchParams('a=1&b=2') },
      respond('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    )) as Response;

    assert.equal(res.status, 200);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/x?a=1&b=2');
    assert.equal(entry.status, 200);
    assert.equal(entry.sizeBytes, 11);
    assert.ok(entry.durationMs >= 0);
    assert.ok(entry.timestamp instanceof Date);
    assert.equal(entry.error, undefined);
  });

  it('omits the query when showQuery is false', async () => {
    const entries: LogEntry[] = [];
    await run(
      { onLog: (e) => entries.push(e), showQuery: false },
      { query: new URLSearchParams('secret=1') },
      respond('ok'),
    );
    assert.equal(entries[0].path, '/x');
  });

  it('uses ctx.set.status and sizes raw values returned from handlers', async () => {
    const entries: LogEntry[] = [];
    await run({ onLog: (e) => entries.push(e) }, {}, { plain: true });
    assert.equal(entries[0].status, 200);
    assert.equal(entries[0].sizeBytes, Buffer.byteLength(JSON.stringify({ plain: true })));

    entries.length = 0;
    await run({ onLog: (e) => entries.push(e) }, {}, 'raw-string-body');
    assert.equal(entries[0].sizeBytes, Buffer.byteLength('raw-string-body'));

    entries.length = 0;
    await run({ onLog: (e) => entries.push(e) }, {}, null);
    assert.equal(entries[0].sizeBytes, undefined);

    entries.length = 0;
    await run({ onLog: (e) => entries.push(e) }, {}, 42);
    assert.equal(entries[0].sizeBytes, undefined);

    entries.length = 0;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await run({ onLog: (e) => entries.push(e) }, {}, circular);
    assert.equal(entries[0].sizeBytes, undefined);
  });

  it('treats missing or invalid content-length as unknown size', async () => {
    const entries: LogEntry[] = [];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunked'));
        controller.close();
      },
    });
    await run({ onLog: (e) => entries.push(e) }, {}, respond(stream));
    assert.equal(entries[0].sizeBytes, undefined);

    entries.length = 0;
    await run({ onLog: (e) => entries.push(e) }, {}, respond('x', { headers: { 'content-length': 'not-a-number' } }));
    assert.equal(entries[0].sizeBytes, undefined);

    entries.length = 0;
    await run({ onLog: (e) => entries.push(e) }, {}, respond('y', { headers: { 'content-length': '3' } }));
    assert.equal(entries[0].sizeBytes, 3);
  });

  it('captures thrown errors and rethrows them', async () => {
    const entries: LogEntry[] = [];
    await assert.rejects(
      () =>
        run(
          { onLog: (e) => entries.push(e) },
          {},
          (() => {
            throw new Error('handler died');
          }) as () => unknown,
        ),
      /handler died/,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 500);
    assert.equal((entries[0].error as Error).message, 'handler died');
    assert.ok(entries[0].durationMs >= 0);
  });
});

describe('logger output formatting', () => {
  it('writes successful requests to console.log and failures to console.error', async () => {
    const captured = captureConsole();
    try {
      await run({ colors: false, timestamp: 'none' }, {}, respond('ok'));
      await assert.rejects(() =>
        run(
          { colors: false, timestamp: 'none' },
          {},
          (() => {
            throw new Error('nope');
          }) as () => unknown,
        ),
      );
      await assert.rejects(() =>
        run({ colors: false }, {}, (() => {
          throw new Error('again');
        }) as () => unknown),
      );
      assert.equal(captured.logs.length, 1);
      assert.match(captured.logs[0], /200 ✓ OK/);
      assert.equal(captured.errors.length, 2);
      assert.match(captured.errors[0], /✗ Internal Server Error/);
      assert.ok(captured.errors[0].includes('nope'));
      assert.match(captured.errors[1], /✗ Internal Server Error/);
      assert.ok(captured.errors[1].includes('again'));
    } finally {
      captured.restore();
    }
  });

  it('formats timestamps as local time, iso, or omits them', async () => {
    const captured = captureConsole();
    try {
      await run({ colors: false }, {}, respond('ok'));
      assert.match(captured.logs.at(-1)!, /\[\d{2}:\d{2}:\d{2}\]/);

      await run({ colors: false, timestamp: 'iso' }, {}, respond('ok'));
      assert.match(captured.logs.at(-1)!, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      await run({ colors: false, timestamp: 'none' }, {}, respond('ok'));
      assert.doesNotMatch(captured.logs.at(-1)!, /\[/);
    } finally {
      captured.restore();
    }
  });

  it('hides the size column when showSize is false and shows an em dash when unknown', async () => {
    const captured = captureConsole();
    try {
      await run({ colors: false, showSize: false, timestamp: 'none' }, {}, respond('ok'));
      assert.doesNotMatch(captured.logs.at(-1)!, /B\b|KB|MB/);

      await run(
        { colors: false, timestamp: 'none' },
        {},
        respond(new ReadableStream({ start(c) { c.close(); } })),
      );
      assert.match(captured.logs.at(-1)!, /\u2014/);
    } finally {
      captured.restore();
    }
  });

  it('prints sizes in bytes, kilobytes and megabytes', async () => {
    const captured = captureConsole();
    try {
      await run({ colors: false, timestamp: 'none' }, {}, respond('x'.repeat(100)));
      assert.match(captured.logs.at(-1)!, /100 B/);

      await run({ colors: false, timestamp: 'none' }, {}, respond('x'.repeat(2048)));
      assert.match(captured.logs.at(-1)!, /2\.0 KB/);

      await run({ colors: false, timestamp: 'none' }, {}, respond('x'.repeat(1024 * 1024 * 1.5)));
      assert.match(captured.logs.at(-1)!, /1\.5 MB/);
    } finally {
      captured.restore();
    }
  });

  it('labels known statuses and falls back to a bare symbol for others', async () => {
    const captured = captureConsole();
    try {
      const statuses: Array<[number, string | null]> = [
        [201, ''], [202, ''], [204, null], [301, ''], [302, ''], [304, null],
        [400, ''], [401, ''], [403, ''], [409, ''], [422, ''], [429, ''],
        [502, ''], [503, ''],
      ];
      for (const [status, body] of statuses) {
        await run({ colors: false, timestamp: 'none' }, {}, respond(body, { status }));
        const line = captured.logs.at(-1)!;
        assert.ok(line.length > 0, String(status));
      }
      await run({ colors: false, timestamp: 'none' }, {}, respond('', { status: 418 }));
      assert.match(captured.logs.at(-1)!, /418 ! /);
      assert.doesNotMatch(captured.logs.at(-1)!, /I'm a teapot/);
    } finally {
      captured.restore();
    }
  });

  it('colors output when enabled and maps every method to its code', async () => {
    const captured = captureConsole();
    try {
      const methodCodes: Array<[string, string]> = [
        ['GET', '\x1b[32m'],
        ['POST', '\x1b[36m'],
        ['PUT', '\x1b[33m'],
        ['PATCH', '\x1b[35m'],
        ['DELETE', '\x1b[31m'],
        ['OPTIONS', '\x1b[34m'],
        ['HEAD', '\x1b[2m'],
        ['WHATEVER', '\x1b[37m'],
      ];
      for (const [method, code] of methodCodes) {
        captured.logs.length = 0;
        await run(
          { colors: true, timestamp: 'none', showSize: false },
          { method, path: `/${method.toLowerCase()}` },
          respond('{}'),
        );
        assert.ok(captured.logs[0].includes(code));
        assert.ok(captured.logs[0].includes(method));
      }
    } finally {
      captured.restore();
    }
  });

  it('colors statuses and durations by severity', async () => {
    const captured = captureConsole();
    try {
      await run({ colors: true, timestamp: 'none', showSize: false }, {}, respond('{}'));
      assert.match(captured.logs.at(-1)!, /\x1b\[32m200 ✓ OK\x1b\[0m/);

      await run({ colors: true, timestamp: 'none', showSize: false }, {}, respond('{}', { status: 302 }));
      assert.match(captured.logs.at(-1)!, /\x1b\[36m302 ↗ Found\x1b\[0m/);

      await run({ colors: true, timestamp: 'none', showSize: false }, {}, respond('{}', { status: 404 }));
      assert.match(captured.logs.at(-1)!, /\x1b\[33m404 ! Not Found\x1b\[0m/);

      await run(
        { colors: true, timestamp: 'none', showSize: false },
        {},
        async () => {
          await sleep(210);
          return respond('{}');
        },
      );
      assert.match(captured.logs.at(-1)!, /\x1b\[31m\d+ ms\x1b\[0m/);
    } finally {
      captured.restore();
    }
  });

  it('uses amber for mid-range durations and seconds above one second', async () => {
    const captured = captureConsole();
    try {
      await run(
        { colors: true, timestamp: 'none', showSize: false },
        {},
        async () => {
          await sleep(55);
          return respond('{}');
        },
      );
      assert.match(captured.logs.at(-1)!, /\x1b\[33m\d+ ms\x1b\[0m/);

      await run(
        { colors: true, timestamp: 'iso', showSize: false },
        {},
        async () => {
          await sleep(1010);
          return respond('{}');
        },
      );
      assert.match(captured.logs.at(-1)!, /\d+\.\d{2} s/);
    } finally {
      captured.restore();
    }
  });

  it('reports sub-10ms durations with one decimal', async () => {
    const captured = captureConsole();
    try {
      await run({ colors: false, timestamp: 'none', showSize: false }, {}, respond('{}'));
      assert.match(captured.logs.at(-1)!, /\d+\.\d ms/);
    } finally {
      captured.restore();
    }
  });

  it('includes non-Error rejection values verbatim', async () => {
    const captured = captureConsole();
    try {
      await assert.rejects(() =>
        run(
          { colors: true, timestamp: 'none' },
          {},
          (() => {
            throw 12345;
          }) as () => unknown,
        ),
      );
      assert.match(captured.errors.at(-1)!, /12345/);

      await assert.rejects(() =>
        run(
          { colors: true, timestamp: 'none' },
          {},
          (() => {
            throw { code: 'E_CUSTOM' };
          }) as () => unknown,
        ),
      );
      assert.match(captured.errors.at(-1)!, /\[object Object\]/);
    } finally {
      captured.restore();
    }
  });
});

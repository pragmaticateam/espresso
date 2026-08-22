import assert from 'node:assert/strict';
import { rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ESPRESSO_EXT,
  Templating,
  TemplatingError,
  compile,
} from '../dist/index.js';
import { viewsDir } from './helpers.ts';

const t = (partialsDir?: string) =>
  new Templating(partialsDir ? { viewsDir, partialsDir } : { viewsDir });

const partialsDir = join(viewsDir, 'partials');

describe('Templating basics', () => {
  it('exposes the .espresso extension constant', () => {
    assert.equal(ESPRESSO_EXT, '.espresso');
    assert.equal(new TemplatingError('x').name, 'TemplatingError');
    assert.ok(new TemplatingError('x') instanceof Error);
  });

  it('renders strings with escaping and raw output', async () => {
    const engine = t();
    const escaped = await engine.render('{{ text }}', { text: `&<>"'` });
    assert.equal(escaped, '&amp;&lt;&gt;&quot;&#39;');

    const raw = await engine.render('{{{ text }}}', { text: '<b>bold</b>' });
    assert.equal(raw, '<b>bold</b>');
  });

  it('stringifies numbers and objects', async () => {
    const engine = t();
    assert.equal(await engine.render('{{ n }}/{{{ o }}}', { n: 5, o: { a: 1 } }), '5/[object Object]');
  });

  it('skips nullish and undefined values', async () => {
    const engine = t();
    assert.equal(await engine.render('[{{ gone }}][{{ nothing }}]', { gone: null }), '[][]');
  });

  it('resolves this, . and @index lookups', async () => {
    const engine = t();
    assert.equal(
      await engine.render('{{ #each list }}{{ @index }}:{{ this }};{{ /each }}', { list: ['a'] }),
      '0:a;',
    );
    assert.equal(await engine.render('{{ . }}', 'dot-value'), 'dot-value');
    assert.equal(await engine.render('{{ this }}', 'this-value'), 'this-value');
  });

  it('walks dot paths and falls back to outer frames', async () => {
    const engine = t();
    assert.equal(
      await engine.render('{{ user.name.first }}', { user: { name: { first: 'Ada' } } }),
      'Ada',
    );
    assert.equal(
      await engine.render('{{ #each rows }}{{ label }}/{{ title }}{{ /each }}', {
        title: 'Outer',
        rows: [{ label: 'r1' }],
      }),
      'r1/Outer',
    );
    assert.equal(
      await engine.render('{{ deep.a.b }}', { deep: { a: null }, other: 'x' }),
      '',
    );
  });

  describe('#if sections', () => {
    const engine = t();
    const cases: Array<[string, unknown, string]> = [
      ['{{ #if flag }}yes{{ else }}no{{ /if }}', { flag: true }, 'yes'],
      ['{{ #if flag }}yes{{ else }}no{{ /if }}', { flag: false }, 'no'],
      ['{{ #if flag }}yes{{ else }}no{{ /if }}', {}, 'no'],
      ['{{ #if flag }}yes{{ else }}no{{ /if }}', { flag: '' }, 'no'],
      ['{{ #if flag }}yes{{ else }}no{{ /if }}', { flag: [] }, 'no'],
      ['{{ #if user.admin }}admin{{ else }}user{{ /if }}', { user: { admin: true } }, 'admin'],
      ['{{ #if user.admin }}admin{{ else }}user{{ /if }}', { user: { admin: null } }, 'user'],
      ['{{ #if user.admin }}admin{{ else }}user{{ /if }}', { user: {} }, 'user'],
    ];
    for (const [tpl, data, expected] of cases) {
      it(`renders ${JSON.stringify(tpl)} with ${JSON.stringify(data)}`, async () => {
        assert.equal(await engine.render(tpl, data), expected);
      });
    }
    it('falls back to the section name when no argument is given', async () => {
      assert.equal(await engine.render('{{ #if }}on{{ /if }}', { if: true }), 'on');
    });
  });

  describe('#each sections', () => {
    const engine = t();
    it('iterates arrays with implicit item scope', async () => {
      assert.equal(
        await engine.render('{{ #each items }}<{{ name }}>{{ /each }}', {
          items: [{ name: 'a' }, { name: 'b' }],
        }),
        '<a><b>',
      );
    });

    it('uses the else branch for non-arrays and empty arrays', async () => {
      const tpl = '{{ #each items }}item{{ else }}empty{{ /each }}';
      assert.equal(await engine.render(tpl, { items: 'not-an-array' }), 'empty');
      assert.equal(await engine.render(tpl, { items: [] }), 'empty');
      assert.equal(await engine.render(tpl, {}), 'empty');
    });

    it('renders nested each blocks', async () => {
      const html = await engine.render(
        '{{ #each groups }}G{{ #each members }}-{{ . }}{{ /each }}{{ /each }}',
        { groups: [{ members: ['x', 'y'] }] },
      );
      assert.equal(html, 'G-x-y');
    });
  });

  describe('generic and inverted sections', () => {
    const engine = t();
    it('iterates arrays in generic sections', async () => {
      assert.equal(
        await engine.render('{{ #tags }}[{{ . }}]{{ /tags }}', { tags: ['x', 'y'] }),
        '[x][y]',
      );
    });

    it('pushes object values as child frames once', async () => {
      assert.equal(
        await engine.render('{{ #profile }}{{ first }} {{ last }}{{ /profile }}', {
          profile: { first: 'Ada', last: 'Lovelace' },
        }),
        'Ada Lovelace',
      );
    });

    it('treats truthy scalars as single-item sections', async () => {
      assert.equal(await engine.render('{{ #flag }}once{{ /flag }}', { flag: 'yes' }), 'once');
    });

    it('uses the else branch when falsy or empty', async () => {
      const tpl = '{{ #rows }}r{{ else }}none{{ /rows }}';
      assert.equal(await engine.render(tpl, { rows: [] }), 'none');
      assert.equal(await engine.render(tpl, { rows: false }), 'none');
    });

    it('inverted sections render only for falsy values', async () => {
      const tpl = '{{ ^loading }}done{{ /loading }}';
      assert.equal(await engine.render(tpl, { loading: false }), 'done');
      assert.equal(await engine.render(tpl, { loading: [] }), 'done');
      assert.equal(await engine.render(tpl, { loading: null }), 'done');
      assert.equal(await engine.render(tpl, { loading: true }), '');
    });
  });
});

describe('Templating file rendering', () => {
  it('renderFile resolves extension-less names preferring .espresso over .html', async () => {
    const engine = t();
    assert.ok((await engine.renderFile('dup')).includes('dup-espresso'));
    assert.ok((await engine.renderFile('plain.html', { page: 'p' })).includes('plain p'));
  });

  it('renderFile accepts explicit extensions', async () => {
    const engine = t();
    assert.ok((await engine.renderFile('home.espresso')).includes('<h1>'));
  });

  it('loadView is an alias of renderFile', async () => {
    assert.equal(await t().loadView('dup'), await t().renderFile('dup'));
  });

  it('throws TemplatingError for missing templates', async () => {
    await assert.rejects(
      () => t().renderFile('missing-file'),
      (error: unknown) =>
        error instanceof TemplatingError &&
        /Template not found: missing-file/.test(error.message) &&
        /\.espresso\/\.html/.test(error.message),
    );
    await assert.rejects(
      () => t().renderFile('missing-file.html'),
      (error: unknown) =>
        error instanceof TemplatingError && /looked in /.test(error.message),
    );
  });

  it('caches compiled templates and revalidates via mtime', async () => {
    const probePath = join(viewsDir, 'cache-probe.espresso');
    const engine = t();
    await writeFile(probePath, 'version-one');
    try {
      assert.equal(await engine.renderFile('cache-probe'), 'version-one');
      // Cached hit path: same mtime.
      assert.equal(await engine.renderFile('cache-probe'), 'version-one');

      // Bump mtime explicitly so the cache invalidates.
      const future = new Date(Date.now() + 5000);
      await writeFile(probePath, 'version-two');
      await utimes(probePath, future, future);
      assert.equal(await engine.renderFile('cache-probe'), 'version-two');

      const info = await stat(probePath);
      assert.ok(info.mtimeMs > 0);
    } finally {
      await rm(probePath, { force: true });
    }
  });

  it('drops cached entries whose file disappeared', async () => {
    const ghostPath = join(viewsDir, 'ghost-view.espresso');
    const engine = t();
    await writeFile(ghostPath, 'boo');
    assert.equal(await engine.renderFile('ghost-view'), 'boo');
    await rm(ghostPath);
    await assert.rejects(() => engine.renderFile('ghost-view'));
  });
});

describe('Templating partials', () => {
  it('renderPartial renders from the partials dir with parent-frame fallback', async () => {
    const out = await t().renderPartial(
      'greet',
      { greeting: 'Yo', name: 'Sam' },
      [{ value: { lang: 'de' } }],
    );
    assert.equal(out.trim(), '<b>Yo, Sam (de)</b>');
  });

  it('partial tags without a data path inherit the current frames', async () => {
    const out = await t().render("before{{ #ctx }}{{ partial 'loop' }}{{ /ctx }}after", {
      ctx: { anything: true },
    });
    assert.ok(out.startsWith('before'));
    assert.ok(out.includes('L'));
    assert.ok(out.endsWith('after'));
  });

  it('partial tags with a data path override the context, missing paths keep it', async () => {
    const withData = await t().render("{{ partial 'greet' visitor }}", {
      visitor: { greeting: 'Hey', name: 'Kim' },
      lang: 'fr',
    });
    assert.equal(withData.trim(), '<b>Hey, Kim (fr)</b>');

    const noValue = await t().render("{{ partial 'greet' absent }}", {
      greeting: 'Hi',
      name: 'Alex',
      lang: 'es',
    });
    assert.equal(noValue.trim(), '<b>Hi, Alex (es)</b>');
  });

  it('detects circular partial references', async () => {
    await assert.rejects(
      () => t().renderPartial('circular'),
      (error: unknown) =>
        error instanceof TemplatingError && /Circular partial reference: circular/.test(error.message),
    );
  });

  it('custom partials directories are honored', async () => {
    const customViews = join(viewsDir, '..');
    const engine = new Templating({ viewsDir: customViews, partialsDir });
    assert.ok((await engine.renderPartial('greet', { greeting: 'A', name: 'B', lang: 'en' })).length > 0);
  });
});

describe('compile integration with the engine', () => {
  it('compiles sources used by render()', () => {
    const nodes = compile('x{{ a }}y');
    assert.deepEqual(nodes.map((n) => n.type), ['text', 'value', 'text']);
  });
});

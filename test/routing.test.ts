import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  joinPath,
  matchRoute,
  normalizePath,
  pathnameMatches,
  splitPath,
} from '../dist/core/routing.js';
import { compile } from '../dist/core/libs/templating/parser.js';

describe('normalizePath', () => {
  it('adds a leading slash', () => {
    assert.equal(normalizePath('users'), '/users');
    assert.equal(normalizePath('/users'), '/users');
  });

  it('strips one trailing slash', () => {
    assert.equal(normalizePath('/users/'), '/users');
    assert.equal(normalizePath('a/b/'), '/a/b');
  });

  it('keeps the root slash', () => {
    assert.equal(normalizePath('/'), '/');
    assert.equal(normalizePath(''), '/');
    assert.equal(normalizePath('//'), '/');
  });
});

describe('splitPath', () => {
  it('splits into non-empty segments', () => {
    assert.deepEqual(splitPath('/a/b/c'), ['a', 'b', 'c']);
    assert.deepEqual(splitPath('/'), []);
    assert.deepEqual(splitPath(''), []);
    assert.deepEqual(splitPath('x//y/'), ['x', 'y']);
  });
});

describe('joinPath', () => {
  it('joins prefix and path', () => {
    assert.equal(joinPath('/api', '/users'), '/api/users');
    assert.equal(joinPath('/api/', 'users'), '/api/users');
    assert.equal(joinPath('', '/users'), '/users');
    assert.equal(joinPath('/', '/users'), '/users');
    assert.equal(joinPath('/api', '/'), '/api');
  });
});

describe('pathnameMatches', () => {
  it('root matches everything', () => {
    assert.equal(pathnameMatches('/', '/anything/else'), true);
  });

  it('exact and segment-boundary prefixes match', () => {
    assert.equal(pathnameMatches('/api', '/api'), true);
    assert.equal(pathnameMatches('/api', '/api/users'), true);
  });

  it('partial segments do not match', () => {
    assert.equal(pathnameMatches('/api', '/apiv2'), false);
    assert.equal(pathnameMatches('/api', '/api2/users'), false);
    assert.equal(pathnameMatches('/api', '/apa'), false);
  });
});

describe('matchRoute', () => {
  it('matches literal segments', () => {
    assert.deepEqual(matchRoute(['users', 'list'], ['users', 'list']), {});
  });

  it('extracts decoded params', () => {
    assert.deepEqual(matchRoute(['users', ':id'], ['users', 'john%20doe']), { id: 'john doe' });
  });

  it('captures the tail with *', () => {
    assert.deepEqual(matchRoute(['files', '*'], ['files', 'a', 'b', 'c.txt']), {
      '*': 'a/b/c.txt',
    });
    assert.deepEqual(matchRoute(['files', '*'], ['files']), { '*': '' });
  });

  it('returns null on length or literal mismatch', () => {
    assert.equal(matchRoute(['users'], ['users', '1']), null);
    assert.equal(matchRoute(['users', ':id'], ['users']), null);
    assert.equal(matchRoute(['users'], ['posts']), null);
    assert.equal(matchRoute([], ['users']), null);
  });

  it('mixed params and literals', () => {
    assert.deepEqual(
      matchRoute(['users', ':id', 'posts', ':postId'], ['users', '7', 'posts', '9']),
      { id: '7', postId: '9' },
    );
  });
});

describe('compile (parser)', () => {
  it('parses plain text', () => {
    assert.deepEqual(compile('hello world'), [{ type: 'text', value: 'hello world' }]);
  });

  it('parses escaped and raw interpolation', () => {
    const nodes = compile('a{{ x }}b{{{ y }}}c');
    assert.deepEqual(nodes, [
      { type: 'text', value: 'a' },
      { type: 'value', path: 'x', raw: false },
      { type: 'text', value: 'b' },
      { type: 'value', path: 'y', raw: true },
      { type: 'text', value: 'c' },
    ]);
  });

  it('trims tag whitespace including newlines', () => {
    const nodes = compile('{{\n  name \n}}');
    assert.deepEqual(nodes, [{ type: 'value', path: 'name', raw: false }]);
  });

  it('parses #if with arg, else branch and nesting', () => {
    const nodes = compile("{{#if user.admin}}A{{ else }}B{{ /if }}");
    assert.equal(nodes.length, 1);
    const section = nodes[0] as Extract<(typeof nodes)[number], { type: 'section' }>;
    assert.equal(section.type, 'section');
    assert.equal(section.kind, 'if');
    assert.equal(section.name, 'if');
    assert.equal(section.arg, 'user.admin');
    assert.equal((section.children[0] as { value?: string }).value, 'A');
    assert.equal((section.elseChildren[0] as { value?: string }).value, 'B');
  });

  it('parses #each with an argument', () => {
    const [node] = compile('{{ #each items as t }}x{{ /each }}') as [
      { kind: string; name: string; arg?: string },
    ];
    assert.equal(node.kind, 'each');
    assert.equal(node.arg, 'items as t');
  });

  it('classifies generic sections and inverted sections', () => {
    const generic = compile('{{ #rows }}r{{ /rows }}')[0] as { kind: string; name: string };
    assert.equal(generic.kind, 'section');
    assert.equal(generic.name, 'rows');

    const inverted = compile('{{ ^hidden }}h{{ /hidden }}')[0] as { type: string };
    assert.equal(inverted.type, 'inverted');
  });

  it('parses partial tags with optional data path', () => {
    const [plain] = compile("{{ partial 'card' }}") as [
      { type: string; name: string; dataPath?: string },
    ];
    assert.deepEqual(plain, { type: 'partial', name: 'card', dataPath: undefined });

    const [withData] = compile("{{ partial 'card' item.rows }}") as [
      { type: string; name: string; dataPath?: string },
    ];
    assert.deepEqual(withData, { type: 'partial', name: 'card', dataPath: 'item.rows' });

    const [doubleQuoted] = compile('{{ partial "card" }}') as [{ name: string }];
    assert.equal(doubleQuoted.name, 'card');
  });

  it('throws for invalid partial tags', () => {
    assert.throws(() => compile('{{ partial card }}'), /Invalid partial tag/);
    assert.throws(() => compile("{{ partial 'card }}"), /Invalid partial tag/);
    assert.throws(() => compile("{{ partial 'card' extra stuff }}"), /Invalid partial tag/);
  });

  it('throws for unexpected top-level close tags', () => {
    assert.throws(() => compile('hello {{ /if }}'), /Unexpected/);
  });

  it('throws when close tag does not match open tag', () => {
    assert.throws(() => compile('{{ #each items }}{{ /if }}'), /Expected .+ but found/);
    assert.throws(() => compile('{{ ^flag }}{{ /other }}'), /Expected .+ but found/);
  });

  it('throws for stray else at the top level', () => {
    assert.throws(() => compile('a {{ else }} b'), /outside of a section/);
    assert.doesNotThrow(() => compile('{{ #if a }}x{{ else }}y{{ /if }}'));
  });

  it('throws for unclosed sections', () => {
    assert.throws(() => compile('{{ #each items }}item'), /Unclosed section/);
    assert.throws(() => compile('{{ ^flag }}x'), /Unclosed section/);
  });

  it('parses nested sections inside else blocks', () => {
    const src = '{{ #if a }}{{ #each list }}{{ . }}{{ /each }}{{ else }}{{ ^b }}no{{ /b }}{{ /if }}';
    const [outer] = compile(src) as [{ children: unknown[]; elseChildren: unknown[] }];
    assert.equal(outer.children.length, 1);
    assert.equal(outer.elseChildren.length, 1);
  });

  it('handles empty templates and adjacent tags', () => {
    assert.deepEqual(compile(''), []);
    assert.deepEqual(compile('{{a}}{{b}}'), [
      { type: 'value', path: 'a', raw: false },
      { type: 'value', path: 'b', raw: false },
    ]);
  });
});

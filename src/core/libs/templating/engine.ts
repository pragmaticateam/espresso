import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile, type Node } from './parser.js';

export interface TemplatingConfig {
  /** Root directory containing view templates. */
  viewsDir: string;
  /** Directory partials are resolved from. Defaults to `viewsDir/partials`. */
  partialsDir?: string;
}

export const ESPRESSO_EXT = '.espresso';

const HTML_EXT = '.html';

const PARTIAL_EXTENSIONS = [ESPRESSO_EXT, HTML_EXT] as const;

/** Thrown when a view or partial cannot be located or parsed. */
export class TemplatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplatingError';
  }
}

interface Compiled {
  mtimeMs: number;
  nodes: Node[];
}

interface Frame {
  value: unknown;
  index?: number;
}

/**
 * A small, cached templating engine for `.espresso` (and `.html`) templates.
 *
 * Compiled templates are cached per file and re-read only when the file's
 * mtime changes, so rendering reuses the parsed AST on hot paths.
 */
export class Templating {
  private readonly viewsDir: string;
  private readonly partialsDir: string;
  private readonly cache = new Map<string, Compiled>();
  private readonly partialCache = new Map<string, Compiled>();

  constructor(config: TemplatingConfig) {
    this.viewsDir = resolve(config.viewsDir);
    this.partialsDir = resolve(config.partialsDir ?? join(config.viewsDir, 'partials'));
  }

  /**
   * Render a view from the views directory. `name` may include or omit an
   * extension; `.espresso` is preferred over `.html`.
   */
  async renderFile(name: string, data: Record<string, unknown> = {}): Promise<string> {
    const compiled = await this.load(this.viewsDir, name, this.cache);
    return this.renderNodes(compiled.nodes, [{ value: data }], []);
  }

  /** Render an in-memory template source string (no partials unless registered). */
  async render(source: string, data: Record<string, unknown> = {}): Promise<string> {
    return this.renderNodes(compile(source), [{ value: data }], []);
  }

  /** Render a named partial with the given data (falling back to parent scope). */
  async renderPartial(
    name: string,
    data: Record<string, unknown> = {},
    frames: Frame[] = [],
  ): Promise<string> {
    const compiled = await this.load(this.partialsDir, name, this.partialCache);
    return this.renderNodes(compiled.nodes, [...frames, { value: data }], [name]);
  }

  /** Direct access to a view's rendered output. */
  async loadView(name: string, data: Record<string, unknown> = {}): Promise<string> {
    return this.renderFile(name, data);
  }

  private async load(
    dir: string,
    name: string,
    cache: Map<string, Compiled>,
  ): Promise<Compiled> {
    const path = await this.resolve(dir, name);
    const cached = cache.get(path);
    if (cached) {
      try {
        const info = await stat(path);
        if (info.mtimeMs === cached.mtimeMs) return cached;
      } catch {
        cache.delete(path);
      }
    }
    const source = await readFile(path, 'utf8');
    const info = await stat(path);
    const compiled = { mtimeMs: info.mtimeMs, nodes: compile(source) };
    cache.set(path, compiled);
    return compiled;
  }

  private async resolve(dir: string, name: string): Promise<string> {
    const hasExtension = name.endsWith(ESPRESSO_EXT) || name.endsWith(HTML_EXT);
    if (hasExtension) {
      const path = resolve(dir, name);
      if (await exists(path)) return path;
      throw new TemplatingError(`Template not found: ${name} (looked in ${dir})`);
    }
    for (const ext of PARTIAL_EXTENSIONS) {
      const path = resolve(dir, `${name}${ext}`);
      if (await exists(path)) return path;
    }
    throw new TemplatingError(
      `Template not found: ${name} (looked for .espresso/.html in ${dir})`,
    );
  }

  private async renderNodes(
    nodes: Node[],
    frames: Frame[],
    partialChain: string[],
  ): Promise<string> {
    let out = '';
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out += node.value;
          break;
        case 'value': {
          const value = lookup(frames, node.path);
          if (value === undefined || value === null) break;
          out += node.raw ? String(value) : escapeHtml(value);
          break;
        }
        case 'section':
          out += await this.renderSection(node, frames, partialChain);
          break;
        case 'inverted': {
          const value = lookup(frames, node.name);
          if (isFalsy(value)) {
            out += await this.renderNodes(node.children, frames, partialChain);
          }
          break;
        }
        case 'partial': {
          if (partialChain.includes(node.name)) {
            throw new TemplatingError(`Circular partial reference: ${node.name}`);
          }
          const compiled = await this.load(this.partialsDir, node.name, this.partialCache);
          let childFrames = frames;
          if (node.dataPath !== undefined) {
            const value = lookup(frames, node.dataPath);
            if (value !== undefined) {
              childFrames = [...frames, { value }];
            }
          }
          out += await this.renderNodes(
            compiled.nodes,
            childFrames,
            [...partialChain, node.name],
          );
          break;
        }
      }
    }
    return out;
  }

  private async renderSection(
    node: Extract<Node, { type: 'section' }>,
    frames: Frame[],
    partialChain: string[],
  ): Promise<string> {
    if (node.kind === 'if') {
      const value = lookup(frames, node.arg ?? node.name);
      const branch = isFalsy(value) ? node.elseChildren : node.children;
      return this.renderNodes(branch, frames, partialChain);
    }
    if (node.kind === 'each') {
      const value = lookup(frames, node.arg ?? node.name);
      if (!Array.isArray(value)) {
        return this.renderNodes(node.elseChildren, frames, partialChain);
      }
      if (value.length === 0) {
        return this.renderNodes(node.elseChildren, frames, partialChain);
      }
      let out = '';
      for (let i = 0; i < value.length; i++) {
        out += await this.renderNodes(
          node.children,
          [...frames, { value: value[i], index: i }],
          partialChain,
        );
      }
      return out;
    }
    const value = lookup(frames, node.name);
    if (Array.isArray(value)) {
      if (value.length === 0) return this.renderNodes(node.elseChildren, frames, partialChain);
      let out = '';
      for (let i = 0; i < value.length; i++) {
        out += await this.renderNodes(
          node.children,
          [...frames, { value: value[i], index: i }],
          partialChain,
        );
      }
      return out;
    }
    if (!isFalsy(value)) {
      return this.renderNodes(
        node.children,
        [...frames, { value }],
        partialChain,
      );
    }
    return this.renderNodes(node.elseChildren, frames, partialChain);
  }
}

function isFalsy(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function lookup(frames: Frame[], path: string): unknown {
  if (path === 'this' || path === '.') return frames[frames.length - 1].value;
  if (path === '@index') return frames[frames.length - 1].index;
  const parts = path.split('.');
  for (let i = frames.length - 1; i >= 0; i--) {
    let value = frames[i].value;
    let found = true;
    for (const part of parts) {
      if (value === null || value === undefined) {
        found = false;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (found && value !== undefined) return value;
  }
  return undefined;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

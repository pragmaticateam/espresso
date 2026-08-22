/**
 * Tokenizer + recursive-descent parser for the `.espresso` template syntax.
 *
 * Syntax:
 *   {{ key }}            escaped interpolation (dot-paths supported)
 *   {{{ key }}}          raw interpolation
 *   {{ #if cond }} ... {{ else }} ... {{ /if }}
 *   {{ #each list }} ... {{ /each }}
 *   {{ #name }} ... {{ /name }}      generic section (iterates arrays)
 *   {{ ^name }} ... {{ /name }}      inverted section (renders when falsy/empty)
 *   {{ partial 'name' }}             include a partial from views/partials
 *   {{ partial 'name' data.path }}   include with an overridden context
 */

export type Node =
  | { type: 'text'; value: string }
  | { type: 'value'; path: string; raw: boolean }
  | {
      type: 'section';
      kind: 'each' | 'if' | 'section';
      name: string;
      arg?: string;
      children: Node[];
      elseChildren: Node[];
    }
  | { type: 'inverted'; name: string; children: Node[] }
  | { type: 'partial'; name: string; dataPath?: string };

type RawToken =
  | { type: 'text'; value: string }
  | { type: 'tag'; content: string; raw: boolean };

type ParsedTag =
  | { kind: 'value'; path: string }
  | { kind: 'open'; name: string; arg?: string }
  | { kind: 'inverted'; name: string }
  | { kind: 'close'; name: string }
  | { kind: 'else' }
  | { kind: 'partial'; name: string; dataPath?: string };

const TAG_RE = /\{\{\{([\s\S]*?)\}\}\}|\{\{([\s\S]*?)\}\}/g;

function tokenize(source: string): RawToken[] {
  const out: RawToken[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(source))) {
    if (match.index > last) out.push({ type: 'text', value: source.slice(last, match.index) });
    out.push({ type: 'tag', content: (match[1] ?? match[2]).trim(), raw: match[1] !== undefined });
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push({ type: 'text', value: source.slice(last) });
  return out;
}

function parseTag(content: string): ParsedTag {
  const first = content[0];
  if (first === '#') {
    const body = content.slice(1).trim();
    const [name, ...rest] = body.split(/\s+/);
    return { kind: 'open', name, arg: rest.length > 0 ? rest.join(' ') : undefined };
  }
  if (first === '^') {
    return { kind: 'inverted', name: content.slice(1).trim() };
  }
  if (first === '/') {
    return { kind: 'close', name: content.slice(1).trim() };
  }
  if (content === 'else') return { kind: 'else' };
  if (content.startsWith('partial')) {
    const body = content.slice('partial'.length).trim();
    const match = body.match(/^(['"])(.*?)\1(?:\s+([\w.$]+))?$/);
    if (!match) throw new Error(`Invalid partial tag: {{ ${content} }}`);
    return { kind: 'partial', name: match[2], dataPath: match[3] };
  }
  return { kind: 'value', path: content };
}

interface Block {
  nodes: Node[];
  elseNodes: Node[];
  next: number;
}

function parseBlock(
  tokens: RawToken[],
  start: number,
  closeName?: string,
  top = false,
): Block {
  const nodes: Node[] = [];
  let elseNodes: Node[] | null = null;
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'text') {
      nodes.push({ type: 'text', value: token.value });
      i++;
      continue;
    }
    const tag = parseTag(token.content);
    if (tag.kind === 'close') {
      if (top) throw new Error(`Unexpected {{ /${tag.name} }}`);
      if (closeName && tag.name !== closeName) {
        throw new Error(`Expected {{ /${closeName} }} but found {{ /${tag.name} }}`);
      }
      return { nodes, elseNodes: elseNodes ?? [], next: i + 1 };
    }
    if (tag.kind === 'else') {
      if (top) throw new Error('Unexpected {{ else }} outside of a section');
      // Unreachable today: the frame returns immediately after handling an
      // else, so a second `{{ else }}` lands in a fresh child frame.
      /* node:coverage ignore next */
      if (elseNodes !== null) throw new Error('Duplicate {{ else }} in section');
      const rest = parseBlock(tokens, i + 1, closeName);
      return { nodes, elseNodes: rest.nodes, next: rest.next };
    }
    if (tag.kind === 'open') {
      const inner = parseBlock(tokens, i + 1, tag.name);
      const kind = tag.name === 'each' ? 'each' : tag.name === 'if' ? 'if' : 'section';
      nodes.push({
        type: 'section',
        kind,
        name: tag.name,
        arg: tag.arg,
        children: inner.nodes,
        elseChildren: inner.elseNodes,
      });
      i = inner.next;
      continue;
    }
    if (tag.kind === 'inverted') {
      const inner = parseBlock(tokens, i + 1, tag.name);
      nodes.push({ type: 'inverted', name: tag.name, children: inner.nodes });
      i = inner.next;
      continue;
    }
    if (tag.kind === 'value') {
      nodes.push({ type: 'value', path: tag.path, raw: token.raw });
    } else if (tag.kind === 'partial') {
      nodes.push({ type: 'partial', name: tag.name, dataPath: tag.dataPath });
    }
    i++;
  }
  if (closeName !== undefined) {
    throw new Error(`Unclosed section {{ #${closeName} }}`);
  }
  return { nodes, elseNodes: elseNodes ?? [], next: i };
}

/** Parse a template source string into an AST. Throws on malformed syntax. */
export function compile(source: string): Node[] {
  return parseBlock(tokenize(source), 0, undefined, true).nodes;
}

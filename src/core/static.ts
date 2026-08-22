import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
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

export function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export const INDEX_FILE = 'index.html';

/**
 * Serves a single static file from `root`.
 * The resolved path is confined to `root` (protects against path traversal).
 * Returns `null` when the file does not exist or is not readable.
 */
export async function serveStaticFile(root: string, pathname: string): Promise<Response | null> {
  const rootResolved = resolve(root);
  const relative = pathname.replace(/^\/+/, '');
  const file = resolve(rootResolved, relative || INDEX_FILE);
  if (!file.startsWith(rootResolved + sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const buffer = await readFile(file);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': mimeFor(file),
        'content-length': String(buffer.byteLength),
      },
    });
  } catch {
    return null;
  }
}
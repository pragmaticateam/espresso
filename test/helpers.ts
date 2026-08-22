import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Espresso } from '../dist/index.js';
import { once } from 'node:events';

export const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const viewsDir = join(fixtureDir, 'views');
export const publicDir = join(fixtureDir, 'public');
export const assetsDir = join(fixtureDir, 'assets');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startServer(app: Espresso): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => {
    app.listen(0, '127.0.0.1', resolve);
  });
  const port = (app as unknown as { serverInstance: { address(): { port: number } } }).serverInstance!.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: async () => {
      const server = (app as unknown as { serverInstance: import('node:http').Server }).serverInstance!;
      server.close();
      await once(server, 'close');
    },
  };
}

export interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

export function captureConsole(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

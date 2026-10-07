import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Page } from '@playwright/test';
import { expect, inject, type ExpectStatic, type OnTestFinishedHandler } from 'vitest';

export const read = (cwd: string, file: string): string => fs.readFileSync(path.join(cwd, file), 'utf8');

export const write = (cwd: string, file: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
};

/**
 * Runs one of the project's scripts, `build` or `check` (svelte-kit sync and
 * svelte-check), failing with its output. It never blocks: the cases run
 * concurrently, and each one's browser waits on the event loop.
 */
export const script = async (cwd: string, name: 'build' | 'check'): Promise<void> => {
  try {
    await promisify(execFile)('pnpm', ['run', name], { cwd, encoding: 'utf8' });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    expect.fail(`pnpm run ${name} failed in ${cwd}\n${stdout ?? ''}\n${stderr ?? ''}`);
  }
};

/** Every file under `dir` but those under `skip`, with its content. */
export const tree = (dir: string, skip: string[] = []): Record<string, string> => Object.fromEntries(
  fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .filter((file) => !skip.some((prefix) => file.split(path.sep).includes(prefix)))
    .map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]),
);

/** A fresh copy of `variant`'s template at `cwd`. */
export const fromTemplate = (cwd: string, variant: 'kit-ts' | 'kit-js'): string => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.cpSync(path.join(inject('templatesDir'), variant), cwd, { recursive: true });
  return cwd;
};

export const edit = (cwd: string, file: string, change: (content: string) => string): void => {
  const target = path.join(cwd, file);
  write(cwd, file, change(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''));
};

/**
 * Serves the built app with `vite preview` until the case finishes, and fails
 * the case on an error the page throws or logs. Vite runs as the only
 * process, so stopping it stops the server: `sv`'s `prepareServer` runs it
 * through pnpm, stops that after a minute and leaves Vite running.
 */
export const serve = async (
  cwd: string,
  page: Page,
  ctx: { expect: ExpectStatic; onTestFinished: (handler: OnTestFinishedHandler) => void },
): Promise<string> => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const vite = spawn(process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'), 'preview'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((resolve) => vite.once('exit', () => resolve()));
  ctx.onTestFinished(async () => {
    vite.kill();
    await exited;
  });
  ctx.onTestFinished(() => ctx.expect(errors, 'errors in the page').toEqual([]));

  let output = '';
  return await new Promise<string>((resolve, reject) => {
    vite.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      // eslint-disable-next-line no-control-regex
      const url = /http:\/\/[^\s/]+:\d+\/\S*/.exec(output.replace(/\x1b\[[0-9;]*m/g, ''))?.[0];
      if (url) resolve(url);
    });
    vite.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    void exited.then(() => reject(new Error(`vite preview exited in ${cwd}\n${output}`)));
  });
};

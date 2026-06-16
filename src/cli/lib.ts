/**
 * W4.6 CLI helpers shared by the demiurge-* recovery/backup/handover commands.
 *
 * These commands are thin TypeScript entry points behind shell shims in
 * scripts/. Keeping argument parsing and prompting here avoids duplicating the
 * readline raw-mode dance across four files and keeps each entry point small.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../security/recovery/manifest.js';

export type CliArgs = Record<string, string | boolean>;

/**
 * Minimal flag parser: `--key value`, `--key=value`, and bare `--flag`
 * (boolean true). Positional arguments are ignored; these commands are
 * flag-driven. Matches the convention in src/cli/index.ts.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = {};
  let i = 0;
  while (i < args.length) {
    const token = args[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        out[token.slice(2, eq)] = token.slice(eq + 1);
        i++;
      } else {
        const key = token.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[key] = next;
          i += 2;
        } else {
          out[key] = true;
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return out;
}

// Prompting has two modes. On a real terminal we use readline interactively
// (with echo suppressed for passphrases). When stdin is piped (scripted
// installs, tests) readline races against an already-ended stream and drops
// buffered lines, so instead we read all of stdin once and serve each prompt
// from a line queue. Both paths read exactly one line per prompt.
let _pipedLines: string[] | null = null;

function nextPipedLine(): string {
  if (_pipedLines === null) {
    let raw: string;
    try {
      raw = readFileSync(0, 'utf8');
    } catch {
      raw = '';
    }
    _pipedLines = raw.split('\n');
    if (_pipedLines.length > 0 && _pipedLines[_pipedLines.length - 1] === '') _pipedLines.pop();
  }
  return _pipedLines.shift() ?? '';
}

function askTTY(question: string, mute: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    let muted = false;
    const realWrite = stdout.write.bind(stdout);
    (rl as unknown as { output: NodeJS.WritableStream }).output = {
      write: (chunk: string) => {
        if (!muted) realWrite(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    realWrite(question);
    muted = mute;
    rl.question('', (answer) => {
      rl.close();
      if (mute) realWrite('\n');
      resolve(answer);
    });
  });
}

/** Read a single line of input with the prompt echoed. */
export function prompt(question: string): Promise<string> {
  if (stdin.isTTY === true) return askTTY(question, false).then((a) => a.trim());
  stdout.write(question);
  const line = nextPipedLine();
  stdout.write('\n');
  return Promise.resolve(line.trim());
}

/**
 * Read a passphrase without echoing it. On a TTY the typed characters are
 * suppressed; when stdin is piped the line is read from the queue so the
 * command stays automatable. Either way exactly one line is consumed.
 */
export function promptPassphrase(question: string): Promise<string> {
  if (stdin.isTTY === true) return askTTY(question, true);
  stdout.write(question);
  const line = nextPipedLine();
  stdout.write('\n');
  return Promise.resolve(line);
}

/** Render a markdown block of `name.key: <sha256>` for each key in keyDir. */
export function getKeyFingerprints(keyDir: string): string {
  const lines: string[] = [];
  for (const name of ['db', 'vault', 'audit'] as const) {
    const path = join(keyDir, `${name}.key`);
    if (existsSync(path)) {
      lines.push(`- \`${name}.key\`: \`${sha256(readFileSync(path))}\``);
    } else {
      lines.push(`- \`${name}.key\`: (not present on this host)`);
    }
  }
  return lines.join('\n');
}

/**
 * True when this module's importing file is the process entry point. CLI files
 * guard their main() with this so they can be imported by tests without
 * executing.
 */
export function isEntryPoint(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

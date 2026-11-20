// Token Radar's entrypoint: the sealed snapshot goes in, the board and the dashboard come out.
//
// Run from the repo root:
//
//   npx tsx main.ts --input input/snapshot.json --output out
//
// The command is deterministic: the same snapshot and the same code always write the same
// board.json, data.js and dossier.json, byte for byte. It does not read the network, it does
// not fetch anything, and it does not write outside the output directory. The dossier is built
// from the finished output directory, so the page the judge sees is the page the dossier holds.
//
// This file does not score anything itself. Scoring lives in `lib/model.ts`, where the radar-2
// model is named and documented; this file only parses, checks, copies, and reports.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, boardIssue, parseSnapshot, dataScript } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's caps, from the gate's own reference: the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** `--name <value>` out of the arguments, or the fallback when the call has none. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

const inputGiven = arg('input', '/input');
const inputPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(inputPath)) {
  process.stderr.write(`token radar: no snapshot at ${inputPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const outPath = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${problem}\n`);
  process.exit(1);
}

mkdirSync(outPath, { recursive: true });
writeFileSync(join(outPath, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outPath, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot, and return the names copied. */
function copyFiles(fromDir: string, toDir: string): string[] {
  if (!existsSync(fromDir)) return [];
  mkdirSync(toDir, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(fromDir)) {
    if (name.startsWith('.')) continue;
    const source = join(fromDir, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(toDir, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(rootDir, 'dashboard'), join(outPath, 'dashboard'));
const shots = copyFiles(join(rootDir, 'screenshots'), join(outPath, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME_RE.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this output directory and compares bytes.
writeFileSync(join(outPath, 'dossier.json'), buildDossier(outPath, { text_max_bytes: DOSSIER_TEXT_CAP, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar (radar-2): ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outPath, 'board.json')}, ${join(outPath, 'data.js')}, ${join(outPath, 'dashboard')} (3 files), ${join(outPath, 'screenshots')} (${shots.length} images) and ${join(outPath, 'dossier.json')}\n`,
);

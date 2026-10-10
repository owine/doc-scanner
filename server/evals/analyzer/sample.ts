// Builds the analyzer eval's input set from documents already filed in the
// user's Proton Drive: their human-chosen name and folder are the labels.
//
//   PROTON_EMAIL=... PROTON_PASSWORD=... [PROTON_TOTP=123456] \
//     pnpm --filter @doc-scanner/server run eval:analyzer:sample [--n 40] [--seed 1] \
//       [--exclude /Some/Archive ...] [--since 2024-01-01] [--reuse-tree | --dry-run]
//
// Logs in once, snapshots the folder tree, samples documents stratified across
// folders, and downloads them. Everything lands under the flow directory,
// which lives in the gitignored .claude/: these are personal documents and
// must never be committed. The model runs afterwards read only this snapshot,
// so they need no Proton login and every variant sees the same folder tree.

import '../../src/polyfills/typed-array-base64.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FLOW } from './cases.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { openDb } from '../../src/db.js';
import { DriveClient } from '../../src/drive/client.js';
import { isUnderAny, type TreeFile, type TreeFolder } from '../../src/drive/folder-tree.js';
import { EXTENSION_BY_TYPE, loadTree, type EvalCase, type SampleConfig } from './cases.js';

const MAX_BYTES = 25 * 1024 * 1024;

const { values: args } = parseArgs({
  options: {
    n: { type: 'string', default: '40' },
    seed: { type: 'string', default: '1' },
    flow: { type: 'string', default: DEFAULT_FLOW },
    // "Never file here" folders (an archive, closed projects): not sampled,
    // and hidden from the model. Repeat the flag for each folder path.
    exclude: { type: 'string', multiple: true, default: [] },
    // Recent documents reflect current folders and naming conventions.
    since: { type: 'string', default: '2024-01-01' },
    'per-folder': { type: 'string', default: '3' },
    // Skip the walk and sample from the last tree.json snapshot.
    'reuse-tree': { type: 'boolean', default: false },
    // Preview the picks in review.md from the saved tree; no login, no downloads.
    'dry-run': { type: 'boolean', default: false },
  },
});

// Small seeded PRNG (mulberry32) so a re-sample with the same seed picks the
// same documents, as long as the Drive contents haven't changed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function eligible(file: TreeFile): boolean {
  return !!file.mediaType && file.mediaType in EXTENSION_BY_TYPE && (file.size ?? 0) <= MAX_BYTES;
}

/**
 * A random draw of recent documents from active folders, at most
 * `perFolder` from any one folder. Roughly proportional to where documents
 * actually go, without one bulky folder dominating. Files loose at the top
 * level are skipped: "unfiled" is not a filing decision.
 */
function sample(tree: TreeFolder[], cfg: SampleConfig, n: number, rand: () => number): { folder: TreeFolder; file: TreeFile }[] {
  const since = new Date(cfg.since).getTime();
  const pool = tree
    .filter((f) => f.path !== '/' && !isUnderAny(f.path, cfg.excludePaths))
    .flatMap((folder) =>
      folder.files.filter((file) => eligible(file) && file.modified.getTime() >= since).map((file) => ({ folder, file })),
    );
  const perFolder = new Map<string, number>();
  const picked: { folder: TreeFolder; file: TreeFile }[] = [];
  for (const pick of shuffle(pool, rand)) {
    const count = perFolder.get(pick.folder.linkId) ?? 0;
    if (count >= cfg.perFolder) continue;
    perFolder.set(pick.folder.linkId, count + 1);
    picked.push(pick);
    if (picked.length === n) break;
  }
  console.error(`sampled ${picked.length} of ${pool.length} eligible documents`);
  return picked;
}

// Names a person probably never chose: camera/scanner defaults, or long runs
// of digits typical of a bank's download filename. Grading the model against
// one of these would penalise it for not reproducing noise.
const MACHINE_NAME = /^(img|dsc|pxl|scan|document|screenshot|file|download)[ _-]?\d|\d{8,}|^[\w-]+_[\w-]+_[\w-]+$/i;

function reviewSheet(cases: EvalCase[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const rows = cases.map(
    (c) =>
      `| ${c.id} | ${cell(c.expectedFolderPath)} | ${cell(c.expectedName)} | ${c.mimeType} | ${c.siblingCount} | ${
        MACHINE_NAME.test(c.expectedName) ? 'machine-named?' : ''
      } |`,
  );
  return [
    '# Analyzer eval inputs',
    '',
    'Each row is a document already filed in Drive; its folder and name are the expected answer.',
    'Flagged rows look machine-named. Drop any case whose name or folder you would not stand behind',
    'as "the right answer" by deleting it from cases.json.',
    '',
    '| id | folder | your name | type | siblings | flag |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const n = Number(args.n);
  const flow = resolve(args.flow!);
  const docsDir = join(flow, 'inputs', 'docs');
  const treePath = join(flow, 'inputs', 'tree.json');
  mkdirSync(docsDir, { recursive: true });
  const cfg: SampleConfig = {
    excludePaths: args.exclude!,
    since: args.since!,
    perFolder: Number(args['per-folder']),
    seed: Number(args.seed),
  };
  const reuse = (args['reuse-tree'] || args['dry-run']) && existsSync(treePath);
  if (args['dry-run'] && !reuse) throw new Error('--dry-run needs an existing tree.json from an earlier run');

  // Logging in is needed only to walk the tree or download documents.
  const conn: { session?: Awaited<ReturnType<typeof openDrive>> } = {};
  const connect = async () => (conn.session ??= await openDrive());
  try {
    const tree = reuse ? loadTree(flow) : await walk((await connect()).drive, treePath);
    const picks = sample(tree, cfg, n, rng(cfg.seed));
    const cases: EvalCase[] = picks.map(({ folder, file }, i) => ({
      id: `doc${String(i + 1).padStart(3, '0')}`,
      fileUid: file.uid,
      mimeType: file.mediaType!,
      // Named by Drive file ID, so a resample can never pair a stale
      // download with a different case's label.
      docPath: join('inputs', 'docs', `${createHash('sha256').update(file.uid).digest('hex').slice(0, 16)}${EXTENSION_BY_TYPE[file.mediaType!]}`),
      expectedName: file.name,
      expectedFolderLinkId: folder.linkId,
      expectedFolderPath: folder.path,
      siblingCount: folder.files.length - 1,
    }));
    writeFileSync(join(flow, 'inputs', 'review.md'), reviewSheet(cases));
    if (args['dry-run']) {
      console.error(`dry run: ${cases.length} cases previewed in ${join(flow, 'inputs', 'review.md')}; nothing downloaded`);
      return;
    }
    for (const [i, c] of cases.entries()) {
      const docPath = join(flow, c.docPath);
      if (existsSync(docPath)) continue;
      console.error(`downloading ${i + 1}/${cases.length}`);
      writeFileSync(docPath, await (await connect()).drive.downloadFile(c.fileUid));
    }
    writeFileSync(join(flow, 'inputs', 'config.json'), JSON.stringify(cfg, null, 2));
    writeFileSync(join(flow, 'inputs', 'cases.json'), JSON.stringify(cases, null, 2));
    console.error(`wrote ${cases.length} cases to ${join(flow, 'inputs')}; review them in inputs/review.md`);
  } finally {
    conn.session?.close();
  }
}

async function openDrive(): Promise<{ drive: DriveClient; close: () => void }> {
  const email = process.env.PROTON_EMAIL;
  const password = process.env.PROTON_PASSWORD;
  if (!email || !password) throw new Error('Set PROTON_EMAIL and PROTON_PASSWORD (and PROTON_TOTP if 2FA is on).');
  const auth = new ProtonAuth(new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0'));
  const login = await auth.login(email, password, process.env.PROTON_TOTP);
  // The SDK's caches need a database; a throwaway one keeps this run from
  // touching the app's real state.
  const scratch = mkdtempSync(join(tmpdir(), 'analyzer-eval-'));
  const db = openDb(join(scratch, 'drive.db'));
  const drive = new DriveClient({
    db,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    appVersion: 'external-drive-docscanner@0.1.0',
    user: login.decryptedKeys,
    session: login.session,
    protonAuth: auth,
  });
  return {
    drive,
    close: () => {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
      login.mailboxSecret.dispose();
    },
  };
}

async function walk(drive: DriveClient, treePath: string): Promise<TreeFolder[]> {
  console.error('walking the folder tree...');
  let lastReport = 0;
  const tree = await drive.walkFolderTree({
    concurrency: 8,
    onProgress: ({ folders, files, pending }) => {
      if (Date.now() - lastReport < 2000) return;
      lastReport = Date.now();
      console.error(`  ${folders} folders, ${files} files so far, ${pending} folders queued`);
    },
  });
  const fileCount = tree.reduce((sum, f) => sum + f.files.length, 0);
  console.error(`${tree.length} folders, ${fileCount} files`);
  writeFileSync(treePath, JSON.stringify(tree, null, 2));
  return tree;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

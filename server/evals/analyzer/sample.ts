// Builds the analyzer eval's input set from documents already filed in the
// user's Proton Drive: their human-chosen name and folder are the labels.
//
//   PROTON_EMAIL=... PROTON_PASSWORD=... [PROTON_TOTP=123456] \
//     pnpm --filter @doc-scanner/server run eval:analyzer:sample [--n 40] [--seed 1]
//
// Logs in once, snapshots the folder tree, samples documents stratified across
// folders, and downloads them. Everything lands under the flow directory,
// which lives in the gitignored .claude/: these are personal documents and
// must never be committed. The model runs afterwards read only this snapshot,
// so they need no Proton login and every variant sees the same folder tree.

import '../../src/polyfills/typed-array-base64.js';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FLOW } from './cases.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { openDb } from '../../src/db.js';
import { DriveClient } from '../../src/drive/client.js';
import type { TreeFile, TreeFolder } from '../../src/drive/folder-tree.js';
import { EXTENSION_BY_TYPE, type EvalCase } from './cases.js';

const MAX_BYTES = 25 * 1024 * 1024;

const { values: args } = parseArgs({
  options: {
    n: { type: 'string', default: '40' },
    seed: { type: 'string', default: '1' },
    flow: { type: 'string', default: DEFAULT_FLOW },
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
 * Round-robin over folders in random order, one random document per folder
 * per pass, until n are picked. Spreads the set across the whole tree rather
 * than letting one big folder (a statements archive, say) dominate it. Files
 * left loose at the top level are skipped: "unfiled" is not a filing decision.
 */
function stratifiedSample(tree: TreeFolder[], n: number, rand: () => number): { folder: TreeFolder; file: TreeFile }[] {
  const pools = shuffle(
    tree.filter((f) => f.path !== '/').map((folder) => ({ folder, files: shuffle(folder.files.filter(eligible), rand) })),
    rand,
  ).filter((p) => p.files.length > 0);
  const picked: { folder: TreeFolder; file: TreeFile }[] = [];
  while (picked.length < n && pools.some((p) => p.files.length > 0)) {
    for (const pool of pools) {
      const file = pool.files.pop();
      if (file) picked.push({ folder: pool.folder, file });
      if (picked.length === n) break;
    }
  }
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
  const email = process.env.PROTON_EMAIL;
  const password = process.env.PROTON_PASSWORD;
  if (!email || !password) throw new Error('Set PROTON_EMAIL and PROTON_PASSWORD (and PROTON_TOTP if 2FA is on).');
  const n = Number(args.n);
  const flow = resolve(args.flow!);
  const docsDir = join(flow, 'inputs', 'docs');
  mkdirSync(docsDir, { recursive: true });

  const api = new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0');
  const auth = new ProtonAuth(api);
  const login = await auth.login(email, password, process.env.PROTON_TOTP);

  // The SDK's caches need a database; a throwaway one keeps this run from
  // touching the app's real state.
  const scratch = mkdtempSync(join(tmpdir(), 'analyzer-eval-'));
  const db = openDb(join(scratch, 'drive.db'));
  try {
    const drive = new DriveClient({
      db,
      encryptionKey: Buffer.alloc(32, 7).toString('base64'),
      appVersion: 'external-drive-docscanner@0.1.0',
      user: login.decryptedKeys,
      session: login.session,
      protonAuth: auth,
    });

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
    writeFileSync(join(flow, 'inputs', 'tree.json'), JSON.stringify(tree, null, 2));

    const picks = stratifiedSample(tree, n, rng(Number(args.seed)));
    const cases: EvalCase[] = [];
    for (const [i, { folder, file }] of picks.entries()) {
      const id = `doc${String(i + 1).padStart(3, '0')}`;
      const docPath = join(docsDir, `${id}${EXTENSION_BY_TYPE[file.mediaType!]}`);
      if (!existsSync(docPath)) {
        console.error(`downloading ${i + 1}/${picks.length}`);
        writeFileSync(docPath, await drive.downloadFile(file.uid));
      }
      cases.push({
        id,
        fileUid: file.uid,
        mimeType: file.mediaType!,
        docPath: join('inputs', 'docs', `${id}${EXTENSION_BY_TYPE[file.mediaType!]}`),
        expectedName: file.name,
        expectedFolderLinkId: folder.linkId,
        expectedFolderPath: folder.path,
        siblingCount: folder.files.length - 1,
      });
    }
    writeFileSync(join(flow, 'inputs', 'cases.json'), JSON.stringify(cases, null, 2));
    writeFileSync(join(flow, 'inputs', 'review.md'), reviewSheet(cases));
    console.error(`wrote ${cases.length} cases to ${join(flow, 'inputs')}; review them in inputs/review.md`);
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
    login.mailboxSecret.dispose();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

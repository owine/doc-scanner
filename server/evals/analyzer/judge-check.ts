// Sanity check for the name judge, run before trusting its grades:
//
//   pnpm --filter @doc-scanner/server run eval:analyzer:judge-check [--n 5]
//
// For the first n cases it asks the judge about three proposals: the user's
// own name (must pass), and must reject an empty name, a confidently wrong
// one, a generic one, and the user's own name with its year changed. Any other
// result means the rubric is miscalibrated.

import { parseArgs } from 'node:util';
import { toFolderContexts } from '../../src/drive/folder-tree.js';
import { DEFAULT_FLOW, loadCases, loadSampleConfig, loadTree, stripExtension } from './cases.js';
import { judgeName } from './harness.js';

const { values: args } = parseArgs({
  options: { flow: { type: 'string', default: DEFAULT_FLOW }, n: { type: 'string', default: '5' } },
});

const flow = args.flow!;
const tree = loadTree(flow);
const { excludePaths } = loadSampleConfig(flow);
let failures = 0;

for (const c of loadCases(flow).slice(0, Number(args.n))) {
  const folders = toFolderContexts(tree, { excludeFileUids: new Set([c.fileUid]), excludePaths });
  const probes = [
    { label: 'own name', proposed: stripExtension(c.expectedName), want: true },
    { label: 'empty', proposed: '', want: false },
    { label: 'wrong', proposed: 'Starbucks receipt 1999-01-01', want: false },
    // Near-misses, which a too-lenient rubric would wave through.
    { label: 'generic', proposed: 'Scan', want: false },
  ];
  const own = stripExtension(c.expectedName);
  const shifted = own.replace(/20(\d\d)/, (_, yy: string) => `20${String((Number(yy) + 95) % 100).padStart(2, '0')}`);
  if (shifted !== own) probes.push({ label: 'year-5', proposed: shifted, want: false });
  for (const p of probes) {
    const verdict = await judgeName(c, p.proposed, folders);
    const ok = verdict.acceptable === p.want;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id} ${p.label.padEnd(8)} -> ${verdict.acceptable ? 'acceptable' : 'rejected'}: ${verdict.reason}`);
  }
}
console.log(failures === 0 ? 'judge passed every probe' : `${failures} probe(s) failed`);
process.exit(failures === 0 ? 0 : 1);

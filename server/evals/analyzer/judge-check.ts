// Sanity check for the name judge, run before trusting its grades:
//
//   pnpm --filter @doc-scanner/server run eval:analyzer:judge-check [--n 5]
//
// For the first n cases it asks the judge about three proposals: the user's
// own name (must pass), an empty name and a confidently wrong one (must both
// fail). Any other result means the rubric is miscalibrated.

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
  ];
  for (const p of probes) {
    const verdict = await judgeName(c, p.proposed, folders);
    const ok = verdict.acceptable === p.want;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id} ${p.label.padEnd(8)} -> ${verdict.acceptable ? 'acceptable' : 'rejected'}: ${verdict.reason}`);
  }
}
console.log(failures === 0 ? 'judge passed every probe' : `${failures} probe(s) failed`);
process.exit(failures === 0 ? 0 : 1);

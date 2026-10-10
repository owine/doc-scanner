// Headline numbers for the analyzer eval, per contender:
//
//   node --import tsx server/evals/analyzer/summarize.ts [--flow .claude/hillclimb/analyzer]
//
// Recomputed from the raw rows in each variant's results.jsonl (never from an
// aggregate), with cost priced from each row's served model and usage.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FLOW } from './cases.js';
import { VARIANTS } from './harness.js';

// $ per million tokens, first-party API. Cache writes bill at 1.25x input,
// cache reads at 0.1x.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-fable-5-1': { in: 10, out: 50 },
};

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface Row {
  prompt_id: string;
  status: string;
  model: string;
  usage: Usage;
  judge_model?: string;
  judge_usage?: Usage;
  latency_s: number;
  confidence: number | null;
  grade: Record<string, number>;
}

function cost(model: string | undefined, u: Usage | undefined): number {
  if (!model || !u) return 0;
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}; add it to PRICES`);
  const input =
    u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
  return (input * p.in + u.output_tokens * p.out) / 1e6;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
/** 95% half-width for a proportion, normal approximation. */
const ci = (p: number, n: number) => 1.96 * Math.sqrt((p * (1 - p)) / Math.max(1, n));

const { values: args } = parseArgs({ options: { flow: { type: 'string', default: DEFAULT_FLOW } } });

const THRESHOLDS = [0.7, 0.8, 0.85, 0.9, 0.95];
const lines: string[] = [];

for (const [id, v] of Object.entries(VARIANTS)) {
  const rows = readJsonl<Row>(join(args.flow!, id, 'results.jsonl'));
  if (rows.length === 0) continue;
  const errors = readJsonl<{ model?: string; usage?: Usage; judge_model?: string; judge_usage?: Usage }>(
    join(args.flow!, id, 'errors.jsonl'),
  );
  const scored = rows.filter((r) => r.status === 'ok');
  const n = scored.length;
  // Folder-only cases leave the name metrics unset; average over the rows that have them.
  const g = (k: string) => scored.map((r) => r.grade[k]).filter((v): v is number => typeof v === 'number');
  const fullOk = mean(g('full_ok'));

  // Every billed call counts, including attempts that failed.
  const appCost = [...rows, ...errors].reduce((s, r) => s + cost(r.model, r.usage), 0);
  const judgeCost = [...rows, ...errors].reduce((s, r) => s + cost(r.judge_model, r.judge_usage), 0);

  lines.push(`## ${id}: ${v.label}`);
  lines.push(
    `scored ${n} of ${rows.length} rows (${rows.length - n} truncated), ${errors.length} failed attempts`,
    `full accept   ${pct(fullOk)} ±${pct(ci(fullOk, n))}   folder ${pct(mean(g('folder_exact')))}   name ${pct(mean(g('name_ok')))}   name-sim ${mean(g('name_sim')).toFixed(2)}`,
    `new folders proposed ${pct(mean(g('new_folder')))}   refusals ${pct(mean(g('refused')))}`,
    `cost  $${(appCost / Math.max(1, rows.length)).toFixed(5)}/doc (judge $${judgeCost.toFixed(4)} total, not per-doc)   latency median ${median(scored.map((r) => r.latency_s)).toFixed(1)}s`,
    '',
    '  threshold   coverage   precision   misfiled (of all docs)',
  );
  for (const t of THRESHOLDS) {
    const confident = scored.filter((r) => r.confidence !== null && r.confidence >= t);
    const right = confident.filter((r) => r.grade.full_ok === 1).length;
    lines.push(
      `  ${t.toFixed(2)}        ${pct(confident.length / n).padStart(4)}       ${
        confident.length ? pct(right / confident.length).padStart(4) : '  - '
      }        ${pct((confident.length - right) / n)}`,
    );
  }
  lines.push('');
}

console.log(lines.length ? lines.join('\n') : `no results under ${args.flow}`);

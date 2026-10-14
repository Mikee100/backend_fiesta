// Golden-set eval runner for Fiesta AI.
//
// Usage:
//   npx ts-node scripts/run-evals.ts                # offline: hermetic, free, CI-safe
//   npx ts-node scripts/run-evals.ts --live         # real providers + RAG + verifier
//   npx ts-node scripts/run-evals.ts --filter policy
//   npx ts-node scripts/run-evals.ts --json <path>  # custom report location
//   npx ts-node scripts/run-evals.ts --list
//
// Exit code is 1 when any evaluated case fails, so the offline mode can gate CI.
// See docs/OBSERVABILITY_AND_EVALS.md for the case format and workflow.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Args = { live: boolean; filter?: string; json?: string; list: boolean; help: boolean };

const USAGE = `
Fiesta AI golden-set evals

  --live           Run against real providers, RAG and the output verifier.
                   Requires GROQ_API_KEY (and optionally Gemini keys) plus a
                   reachable DATABASE_URL. Costs tokens; logging and escalations
                   are suppressed so eval traffic stays out of production data.
  --filter <text>  Only run cases whose id or category contains <text>.
  --json <path>    Write the JSON report to <path> instead of evals/results/.
  --list           List cases without running them.
  --help           Show this message.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { live: false, list: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--live') args.live = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--filter') args.filter = argv[++index];
    else if (arg === '--json') args.json = argv[++index];
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // Loaded here (not at the top) so createOfflineAgent() can pin DATABASE_URL
  // before the Prisma-backed agent module graph is evaluated.
  const harness = require('../src/evals/harness');
  const cases = harness.loadGoldenSet();

  if (args.list) {
    for (const kase of cases) {
      console.log(`${kase.id.padEnd(32)} ${kase.category.padEnd(16)} ${kase.modes ? kase.modes.join('+') : 'offline+live'}${kase.skip ? '  [skip]' : ''}`);
    }
    console.log(`\n${cases.length} cases`);
    return;
  }

  const mode: 'offline' | 'live' = args.live ? 'live' : 'offline';
  if (mode === 'live' && !process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is required for --live runs (offline mode needs no keys).');
  }
  if (mode === 'live') {
    console.log('LIVE mode: real model calls, RAG retrieval and verifier runs. Token costs apply.\n');
  } else {
    console.log('OFFLINE mode: stubbed LLM + unreachable database. Measures routing and deterministic replies.\n');
  }

  const startedAt = Date.now();
  const { results, summary } = await harness.runGoldenSet(cases, { mode, filter: args.filter });

  for (const result of results) {
    const mark = result.skipped ? '~' : result.pass ? '+' : 'x';
    const strategy = result.strategy ? ` [${result.strategy}]` : '';
    const timing = `${result.latencyMs}ms`;
    console.log(`${mark} ${result.id.padEnd(32)}${strategy} ${timing}`);
    if (result.skipped && result.skipReason) console.log(`    skipped: ${result.skipReason}`);
    for (const failure of result.failures) {
      console.log(`    ${failure.check}: ${failure.detail}`);
    }
    if (result.error) console.log(`    threw: ${result.error}`);
    if (!result.pass && !result.skipped && result.reply) {
      const preview = result.reply.replace(/\s+/g, ' ').slice(0, 220);
      console.log(`    reply: ${preview}`);
    }
  }

  console.log(`\n${summary.mode} summary`);
  console.log(`  total ${summary.total}  passed ${summary.passed}  failed ${summary.failed}  skipped ${summary.skipped}  pass rate ${summary.passRatePct}%  avg ${summary.avgLatencyMs}ms`);
  for (const row of summary.byCategory) {
    console.log(`  ${row.category.padEnd(18)} ${row.passed}/${row.total}`);
  }

  const reportPath = args.json
    ? path.resolve(args.json)
    : path.join(__dirname, '..', 'evals', 'results', `${summary.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary,
    results,
  }, null, 2));
  console.log(`\nreport: ${reportPath}`);

  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});

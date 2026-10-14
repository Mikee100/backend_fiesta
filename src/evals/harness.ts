// Golden-set evaluation harness for Fiesta AI.
//
// Two modes:
//  - offline (default): the real routing/deterministic layers run with a stubbed
//    LLM (marker reply) and an unreachable database, so runs are hermetic, free
//    and CI-safe. Measures "which layer answers, and does the canned answer hold".
//  - live (scripts/run-evals.ts --live): real providers, RAG and output verifier.
//    Logging/escalation side effects are suppressed so eval traffic never
//    pollutes AiJobMetric, ConversationLearning or admin alerts.
//
// The agent module is loaded lazily via require() so createOfflineAgent() can pin
// DATABASE_URL before the Prisma-backed module graph is evaluated.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** What the stubbed LLM returns in offline mode; replies containing it reached the model layer. */
export const OFFLINE_LLM_MARKER = 'EVAL_OFFLINE_LLM_MARKER_OK';

export const OFFLINE_DATABASE_URL = 'postgresql://eval:eval@127.0.0.1:1/eval?connect_timeout=1';

export type EvalMessage = { role: 'user' | 'assistant'; content: string };

export type EvalExpectation = {
  /** Exact AiJobMetric.strategyUsed recorded for the turn. */
  strategy?: string;
  /** Any of these strategies is acceptable. */
  strategies?: string[];
  /** Strategy must not be one of these. */
  notStrategies?: string[];
  /** Case-insensitive substrings the reply must contain. */
  contains?: string[];
  /** Case-insensitive substrings the reply must not contain. */
  notContains?: string[];
  /** Regex sources (matched case-insensitively) the reply must match. */
  matches?: string[];
  /** Regex sources the reply must not match. */
  forbidMatches?: string[];
  /** Whether the model layer must (true) / must not (false) be reached. */
  reachesLlm?: boolean;
  /** The turn must have raised an escalation of this type (captured, not persisted). */
  escalatedAs?: string;
  /** Reply must equal this string after trimming. */
  equals?: string;
};

export type GoldenCase = {
  id: string;
  category: string;
  message: string;
  platform?: string;
  history?: EvalMessage[];
  /** Pre-turn hook; 'tripCircuitBreaker' forces the breaker open (reset automatically after the case). */
  setup?: 'tripCircuitBreaker';
  /** Restrict a case to one mode; by default cases run in both. */
  modes?: ('offline' | 'live')[];
  skip?: boolean;
  skipReason?: string;
  expect: EvalExpectation;
};

export type CaseCheck = { check: string; detail: string };

export type CaseResult = {
  id: string;
  category: string;
  mode: 'offline' | 'live';
  pass: boolean;
  skipped: boolean;
  skipReason?: string;
  failures: CaseCheck[];
  reply: string;
  strategy?: string;
  reachedLlm: boolean;
  escalations: string[];
  latencyMs: number;
  error?: string;
};

export type EvalSummary = {
  mode: 'offline' | 'live';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRatePct: number;
  avgLatencyMs: number;
  byCategory: { category: string; total: number; passed: number }[];
};

const EXPECT_KEYS = new Set([
  'strategy', 'strategies', 'notStrategies', 'contains', 'notContains',
  'matches', 'forbidMatches', 'reachesLlm', 'escalatedAs', 'equals',
]);

export const DEFAULT_GOLDEN_SET_PATH = path.join(__dirname, '..', '..', 'evals', 'golden-conversations.json');

export function loadGoldenSet(filePath: string = DEFAULT_GOLDEN_SET_PATH): GoldenCase[] {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`Golden set must be a JSON array: ${filePath}`);
  const errors = validateGoldenSet(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid golden set (${filePath}):\n - ${errors.join('\n - ')}`);
  }
  return parsed as GoldenCase[];
}

/** Returns human-readable problems; empty array = valid. */
export function validateGoldenSet(cases: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(cases)) return ['golden set is not an array'];
  const seen = new Set<string>();
  cases.forEach((entry: any, index: number) => {
    const label = entry?.id ? `case "${entry.id}"` : `case at index ${index}`;
    if (!entry || typeof entry !== 'object') { errors.push(`${label} is not an object`); return; }
    if (!entry.id || typeof entry.id !== 'string') errors.push(`${label} is missing a string id`);
    else if (seen.has(entry.id)) errors.push(`duplicate case id "${entry.id}"`);
    else seen.add(entry.id);
    if (!entry.category || typeof entry.category !== 'string') errors.push(`${label} is missing a category`);
    if (!entry.message || typeof entry.message !== 'string') errors.push(`${label} is missing a message`);
    if (!entry.expect || typeof entry.expect !== 'object') { errors.push(`${label} is missing expect`); return; }
    const keys = Object.keys(entry.expect);
    if (keys.length === 0) errors.push(`${label} has an empty expect block`);
    for (const key of keys) if (!EXPECT_KEYS.has(key)) errors.push(`${label} has unknown expectation "${key}"`);
    if (entry.setup && entry.setup !== 'tripCircuitBreaker') errors.push(`${label} has unknown setup "${entry.setup}"`);
    if (entry.modes && (!Array.isArray(entry.modes) || entry.modes.some((m: unknown) => m !== 'offline' && m !== 'live'))) {
      errors.push(`${label} has an invalid modes array`);
    }
    if (entry.skip && !entry.skipReason) errors.push(`${label} is skipped without a skipReason`);
  });
  return errors;
}

/** Runs every expectation in a case against the observed outcome. */
export function evaluateExpectation(
  expect: EvalExpectation,
  observed: { reply: string; strategy?: string; reachedLlm: boolean; escalations: string[] },
): CaseCheck[] {
  const failures: CaseCheck[] = [];
  const reply = observed.reply || '';

  if (expect.strategy !== undefined && observed.strategy !== expect.strategy) {
    failures.push({ check: 'strategy', detail: `expected "${expect.strategy}", got "${observed.strategy ?? '(none)'}"` });
  }
  if (expect.strategies && (!observed.strategy || !expect.strategies.includes(observed.strategy))) {
    failures.push({ check: 'strategies', detail: `expected one of [${expect.strategies.join(', ')}], got "${observed.strategy ?? '(none)'}"` });
  }
  if (expect.notStrategies && observed.strategy && expect.notStrategies.includes(observed.strategy)) {
    failures.push({ check: 'notStrategies', detail: `strategy must not be "${observed.strategy}"` });
  }
  for (const needle of expect.contains || []) {
    if (!reply.toLowerCase().includes(needle.toLowerCase())) {
      failures.push({ check: 'contains', detail: `reply is missing "${needle}"` });
    }
  }
  for (const needle of expect.notContains || []) {
    if (reply.toLowerCase().includes(needle.toLowerCase())) {
      failures.push({ check: 'notContains', detail: `reply must not contain "${needle}"` });
    }
  }
  for (const pattern of expect.matches || []) {
    if (!new RegExp(pattern, 'i').test(reply)) {
      failures.push({ check: 'matches', detail: `reply does not match /${pattern}/i` });
    }
  }
  for (const pattern of expect.forbidMatches || []) {
    if (new RegExp(pattern, 'i').test(reply)) {
      failures.push({ check: 'forbidMatches', detail: `reply must not match /${pattern}/i` });
    }
  }
  if (expect.reachesLlm !== undefined && observed.reachedLlm !== expect.reachesLlm) {
    failures.push({ check: 'reachesLlm', detail: `expected ${expect.reachesLlm}, got ${observed.reachedLlm}` });
  }
  if (expect.escalatedAs !== undefined && !observed.escalations.includes(expect.escalatedAs)) {
    failures.push({ check: 'escalatedAs', detail: `expected escalation "${expect.escalatedAs}", got [${observed.escalations.join(', ')}]` });
  }
  if (expect.equals !== undefined && reply.trim() !== expect.equals.trim()) {
    failures.push({ check: 'equals', detail: `expected exact reply ${JSON.stringify(expect.equals)}, got ${JSON.stringify(reply)}` });
  }
  return failures;
}

const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

export type EvalAgentHandle = {
  agent: any;
  metrics: any[];
  escalations: string[];
  state: { llmCalls: number };
};

/**
 * Builds an AgentService for offline runs: routing and deterministic replies are
 * real, while the LLM, DB-backed logging, emoji decoration and escalations are
 * stubbed. DATABASE_URL is pinned to an unreachable address before the agent
 * module loads so no query can reach a real database.
 */
export function createOfflineAgent(): EvalAgentHandle {
  process.env.DATABASE_URL = OFFLINE_DATABASE_URL;
  const { AgentService } = require('../services/agent/agent.service');
  const { buildBusinessIntroductionReply } = require('../services/agent/replies');
  const handle: EvalAgentHandle = { agent: null, metrics: [], escalations: [], state: { llmCalls: 0 } };
  const agent = new AgentService() as any;
  Object.assign(agent, {
    checkTokenBudget: async () => true,
    decorateTemplateEmoji: async (_customer: string, _platform: string, reply: string) => reply,
    getBookingProgressReply: async () => null,
    // Healthy-DB, fresh-customer state: no draft to resume, so getGreetingReply
    // lands on the same general welcome it returns when the lookups find nothing.
    getGreetingReply: async () => buildBusinessIntroductionReply(),
    // Models a healthy database with no draft state: the real method reads
    // BookingDraft, which cannot resolve against the pinned unreachable DB and
    // would otherwise report slot_persistence_failed for every booking-ish turn.
    rememberBookingSlots: async () => null,
    trackSentiment: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    escalate: async (_customer: string, type: string) => { handle.escalations.push(type); },
    runAgent: async () => {
      handle.state.llmCalls += 1;
      return { content: OFFLINE_LLM_MARKER, tokensUsed: 0 };
    },
    logAiJobMetric: async (data: any) => { handle.metrics.push(data); },
    logConversationLearning: async () => {},
  });
  handle.agent = agent;
  return handle;
}

/**
 * Builds an AgentService for live runs: providers, RAG, tools and the output
 * verifier are real; only observability/escalation side effects are suppressed
 * so eval traffic does not pollute production metrics or admin alerts.
 */
export function createLiveAgent(): EvalAgentHandle {
  const { AgentService } = require('../services/agent/agent.service');
  const handle: EvalAgentHandle = { agent: null, metrics: [], escalations: [], state: { llmCalls: 0 } };
  const agent = new AgentService() as any;
  Object.assign(agent, {
    logAiJobMetric: async (data: any) => { handle.metrics.push(data); },
    logConversationLearning: async () => {},
    escalate: async (_customer: string, type: string) => { handle.escalations.push(type); },
    trackSentiment: async () => {},
    touchCustomerMemory: async () => {},
  });
  handle.agent = agent;
  return handle;
}

async function withBreaker(action: 'trip' | 'reset'): Promise<void> {
  const { circuitBreaker } = require('../services/agent/resilience.service');
  if (action === 'trip') {
    circuitBreaker.recordFailure();
    circuitBreaker.recordFailure();
    circuitBreaker.recordFailure();
  } else {
    circuitBreaker.recordSuccess();
  }
}

export async function runCase(
  handle: EvalAgentHandle,
  kase: GoldenCase,
  mode: 'offline' | 'live',
): Promise<CaseResult> {
  const result: CaseResult = {
    id: kase.id,
    category: kase.category,
    mode,
    pass: false,
    skipped: false,
    failures: [],
    reply: '',
    reachedLlm: false,
    escalations: [],
    latencyMs: 0,
  };

  if (kase.skip) {
    result.skipped = true;
    result.skipReason = kase.skipReason || 'skipped';
    return result;
  }

  const metricsBefore = handle.metrics.length;
  const escalationsBefore = handle.escalations.length;
  const llmBefore = handle.state.llmCalls;
  const platform = kase.platform || 'whatsapp';
  const customerId = `eval-${kase.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);

  if (kase.setup === 'tripCircuitBreaker') await withBreaker('trip');
  const startedAt = Date.now();
  try {
    result.reply = await handle.agent.handleMessage(customerId, kase.message, kase.history || [], platform);
  } catch (error: any) {
    result.error = error?.message || String(error);
    result.failures.push({ check: 'threw', detail: result.error });
  } finally {
    result.latencyMs = Date.now() - startedAt;
    if (kase.setup === 'tripCircuitBreaker') await withBreaker('reset');
  }

  await settle();
  const newMetrics = handle.metrics.slice(metricsBefore);
  result.escalations = handle.escalations.slice(escalationsBefore);
  const metric = newMetrics[newMetrics.length - 1];
  result.strategy = metric?.strategyUsed;
  const llmCalls = handle.state.llmCalls - llmBefore;
  result.reachedLlm = mode === 'offline'
    ? llmCalls > 0
    : (result.strategy === 'runAgent' || llmCalls > 0);

  if (!result.error) {
    result.failures.push(...evaluateExpectation(kase.expect, {
      reply: result.reply,
      strategy: result.strategy,
      reachedLlm: result.reachedLlm,
      escalations: result.escalations,
    }));
  }
  result.pass = result.failures.length === 0 && !result.error;
  return result;
}

export async function runGoldenSet(
  cases: GoldenCase[],
  options: { mode: 'offline' | 'live'; filter?: string },
): Promise<{ results: CaseResult[]; summary: EvalSummary }> {
  const handle = options.mode === 'offline' ? createOfflineAgent() : createLiveAgent();
  const applicable = cases.filter((kase) => {
    if (options.filter) {
      const needle = options.filter.toLowerCase();
      if (!kase.id.toLowerCase().includes(needle) && !kase.category.toLowerCase().includes(needle)) return false;
    }
    return true;
  });

  const results: CaseResult[] = [];
  for (const kase of applicable) {
    if (kase.modes && !kase.modes.includes(options.mode)) {
      results.push({
        id: kase.id, category: kase.category, mode: options.mode, pass: true, skipped: true,
        skipReason: `not applicable to ${options.mode} mode`, failures: [], reply: '',
        reachedLlm: false, escalations: [], latencyMs: 0,
      });
      continue;
    }
    results.push(await runCase(handle, kase, options.mode));
  }

  return { results, summary: summarize(options.mode, results) };
}

export function summarize(mode: 'offline' | 'live', results: CaseResult[]): EvalSummary {
  const evaluated = results.filter((r) => !r.skipped);
  const passed = evaluated.filter((r) => r.pass).length;
  const categoryMap = new Map<string, { total: number; passed: number }>();
  for (const r of evaluated) {
    const entry = categoryMap.get(r.category) || { total: 0, passed: 0 };
    entry.total += 1;
    if (r.pass) entry.passed += 1;
    categoryMap.set(r.category, entry);
  }
  const latencies = evaluated.map((r) => r.latencyMs);
  return {
    mode,
    total: evaluated.length,
    passed,
    failed: evaluated.length - passed,
    skipped: results.length - evaluated.length,
    passRatePct: evaluated.length > 0 ? Math.round((passed / evaluated.length) * 10000) / 100 : 0,
    avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    byCategory: Array.from(categoryMap.entries())
      .map(([category, data]) => ({ category, ...data }))
      .sort((a, b) => a.category.localeCompare(b.category)),
  };
}



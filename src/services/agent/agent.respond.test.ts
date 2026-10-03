// Phase 2: respond() logs each turn in the background without blocking or crashing the reply.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentService } from './agent.service';

const PAYMENT_PROPOSAL = {
  role: 'assistant' as const,
  content: "Great, I can hold THE ICON for 2026-10-10 at 15:00. The deposit is KSH 2000. If that works for you, just reply yes and I'll send the M-Pesa prompt.",
};

const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

function createAgent(overrides: Record<string, unknown> = {}) {
  const metrics: any[] = [];
  const learnings: any[] = [];
  const agent = new AgentService() as any;
  Object.assign(agent, {
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    escalate: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    runAgent: async () => ({ content: 'LLM reply', tokensUsed: 0 }),
    logAiJobMetric: async (data: any) => { metrics.push(data); },
    logConversationLearning: async (data: any) => { learnings.push(data); },
    ...overrides,
  });
  return { agent, metrics, learnings };
}

test('the reply is returned without waiting for logging to finish', async () => {
  const { agent } = createAgent({
    logAiJobMetric: () => new Promise(() => {}),
    logConversationLearning: () => new Promise(() => {}),
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('reply was blocked by logging')), 1000));
  const reply = await Promise.race([agent.handleMessage('customer-1', 'thanks', [], 'whatsapp'), timeout]);
  assert.match(reply as string, /You are welcome/);
});

test('logging failures (sync throw or rejection) never reach the caller or become unhandled rejections', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (message: string) => { logged.push(String(message)); };

  const { agent } = createAgent({
    logAiJobMetric: () => { throw new Error('metric table locked'); },
    logConversationLearning: async () => { throw new Error('learning insert failed'); },
  });

  try {
    const reply = await agent.handleMessage('customer-1', 'thanks', [], 'whatsapp');
    assert.match(reply, /You are welcome/);
    await settle();
    assert.deepEqual(unhandled, []);
    assert.ok(logged.some((line) => /Failed to log AI job metric/.test(line)));
    assert.ok(logged.some((line) => /Failed to log conversation learning/.test(line)));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    console.error = originalError;
  }
});

test('a successful deterministic reply records the same metric and learning fields as before', async () => {
  const { agent, metrics, learnings } = createAgent();
  const reply = await agent.handleMessage('customer-1', 'thanks', [], 'whatsapp');
  await settle();

  assert.equal(metrics.length, 1);
  assert.deepEqual(Object.keys(metrics[0]).sort(), ['customerId', 'latencyMs', 'platform', 'success']);
  assert.equal(metrics[0].success, true);
  assert.equal(typeof metrics[0].latencyMs, 'number');
  assert.deepEqual(
    { ...learnings[0], latencyMs: 0 },
    { customerId: 'customer-1', userMessage: 'thanks', aiResponse: reply, platform: 'whatsapp', latencyMs: 0, wasSuccessful: true, isFallback: false }
  );
});

test('a failed quick confirmation records a fallback with the failure reason', async () => {
  const { agent, metrics, learnings } = createAgent({
    tryImmediateConfirmation: async () => { throw new Error('db down'); },
  });
  await agent.handleMessage('customer-1', 'yes', [PAYMENT_PROPOSAL], 'whatsapp');
  await settle();

  assert.equal(metrics[0].success, false);
  assert.equal(metrics[0].isFallback, true);
  assert.equal(metrics[0].failureReason, 'db down');
  assert.equal(learnings[0].wasSuccessful, false);
  assert.equal(learnings[0].isFallback, true);
});

test('an LLM reply with a failure type is logged as a fallback', async () => {
  const { agent, metrics, learnings } = createAgent({
    runAgent: async () => ({ content: 'Sorry, I lost the thread there.', tokensUsed: 0, failureType: 'empty_model_response' }),
  });
  const reply = await agent.handleMessage('customer-1', 'Hi', [], 'whatsapp');
  await settle();

  assert.equal(reply, 'Sorry, I lost the thread there.');
  assert.equal(metrics[0].failureReason, 'empty_model_response');
  assert.equal(metrics[0].isFallback, true);
  assert.equal(learnings[0].isFallback, true);
});

test('a provider failure is logged as a fallback with the failure reason', async () => {
  const { agent, metrics } = createAgent({
    runAgent: async () => { throw Object.assign(new Error('tokens per day (TPD) limit reached'), { status: 429, code: 'rate_limit_exceeded' }); },
  });
  await agent.handleMessage('customer-1', 'Hi', [], 'whatsapp');
  await settle();

  assert.equal(metrics[0].success, false);
  assert.equal(metrics[0].isFallback, true);
  assert.ok(metrics[0].failureReason);
});

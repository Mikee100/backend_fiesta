import OpenAI from 'openai';
import prisma from '../../../config/prisma';
import { classifyProviderRateLimit } from '../resilience.service';

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0,
});
const groq2 = process.env.GROQ_2 ? new OpenAI({
  apiKey: process.env.GROQ_2,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0,
}) : null;

export const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'llama-3.1-8b-instant';
const GROQ_2_CHAT_MODEL = process.env.GROQ_2_CHAT_MODEL || CHAT_MODEL;
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
const gemini = process.env.GEMINI_API_KEY ? new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  maxRetries: 0,
}) : null;
const geminiBackup2 = process.env.GEMINI_BACKUP2 ? new OpenAI({
  apiKey: process.env.GEMINI_BACKUP2,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  maxRetries: 0,
}) : null;
export type ChatProvider = 'groq' | 'groq2' | 'gemini' | 'gemini2';
const providerCooldownUntil = new WeakMap<Pick<OpenAI, 'chat'>, number>();

/** AI_PRIMARY_PROVIDER=gemini puts Gemini first and keeps Groq as the fallback; the default is Groq first. */
export function primaryProvider(env: NodeJS.ProcessEnv = process.env): ChatProvider {
  // Tests pin the order explicitly so a local .env cannot change their expectations.
  if (env.NODE_TEST_CONTEXT) return 'groq';
  return String(env.AI_PRIMARY_PROVIDER || '').trim().toLowerCase() === 'gemini' ? 'gemini' : 'groq';
}

function providerOrderFor(primary: ChatProvider): ChatProvider[] {
  return primary === 'gemini' ? ['gemini', 'gemini2', 'groq', 'groq2'] : ['groq', 'groq2', 'gemini', 'gemini2'];
}

export function getGroqCooldownUntil(client: Pick<OpenAI, 'chat'> = openai): string | null {
  const until = providerCooldownUntil.get(client) || 0;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

function noteProviderCooldown(error: any, client: Pick<OpenAI, 'chat'>): void {
  const headers = error?.headers ?? error?.response?.headers;
  const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  const seconds = Number(retryAfter);
  const fromHeader = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : retryAfter ? Date.parse(String(retryAfter)) - Date.now() : NaN;
  const status = error?.status ?? error?.response?.status;
  const fallback = status === 401 || status === 403 || status === 404
    ? 5 * 60_000
    : classifyProviderRateLimit(error) === 'daily_tpd_exhausted' ? 60 * 60_000 : 60_000;
  const duration = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : fallback;
  providerCooldownUntil.set(client, Math.max(providerCooldownUntil.get(client) || 0, Date.now() + Math.min(duration, 24 * 60 * 60_000)));
}

async function recordModelUsage(
  provider: ChatProvider,
  model: string,
  response?: any,
  error?: any,
  failover = false
): Promise<void> {
  try {
    await prisma.aiModelUsage.create({ data: {
      provider,
      model,
      inputTokens: response?.usage?.prompt_tokens || 0,
      outputTokens: response?.usage?.completion_tokens || 0,
      totalTokens: response?.usage?.total_tokens || 0,
      status: error ? 'failed' : 'success',
      failover,
      errorCode: error ? String(error?.status || error?.code || 'unknown') : null,
    } });
  } catch (storageError) {
    console.error('Failed to record model usage:', storageError);
  }
}

function isFailoverError(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  // 413: the request exceeds this account's per-minute token cap; another provider can still take it.
  return status === 404 || status === 408 || status === 413 || status === 429 || status >= 500
    || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code);
}

function isAuthenticationError(error: any): boolean {
  const status = error?.status ?? error?.response?.status;
  return status === 401 || status === 403;
}

export async function createChatCompletion(
  params: any,
  preferredProvider?: ChatProvider,
  clients: {
    groq: Pick<OpenAI, 'chat'>;
    groq2?: Pick<OpenAI, 'chat'> | null;
    gemini?: Pick<OpenAI, 'chat'> | null;
    gemini2?: Pick<OpenAI, 'chat'> | null;
  } = { groq: openai, groq2, gemini, gemini2: geminiBackup2 },
  primary: ChatProvider = primaryProvider()
): Promise<{ response: any; provider: ChatProvider; completionCalls: number }> {
  const order = providerOrderFor(primary);
  const start = preferredProvider ?? primary;
  const startIndex = Math.max(0, order.indexOf(start));
  // Follow-up rounds start where the previous round succeeded, then wrap around to the rest.
  const providers = [...order.slice(startIndex), ...order.slice(0, startIndex)];
  const models: Record<ChatProvider, string> = {
    groq: params.model,
    groq2: GROQ_2_CHAT_MODEL,
    gemini: GEMINI_CHAT_MODEL,
    gemini2: process.env.GEMINI_BACKUP2_CHAT_MODEL || GEMINI_CHAT_MODEL,
  };
  let completionCalls = 0;
  let lastError: any;

  for (const provider of providers) {
    const client = clients[provider];
    if (!client) continue;
    if (Date.now() < (providerCooldownUntil.get(client) || 0)) continue;

    const model = models[provider];
    try {
      completionCalls++;
      const response = await client.chat.completions.create({ ...params, model });
      await recordModelUsage(provider, model, response, undefined, provider !== primary);
      return { response, provider, completionCalls };
    } catch (error: any) {
      lastError = error;
      await recordModelUsage(provider, model, undefined, error, provider !== primary);
      const shouldFailOver = isFailoverError(error) || isAuthenticationError(error);
      if (shouldFailOver) noteProviderCooldown(error, client);
      if (!shouldFailOver) throw error;
      const status = error?.status ?? error?.response?.status;
      console.warn('Chat provider unavailable; trying the next configured fallback:', {
        provider,
        status: status || error?.code,
      });
    }
  }

  if (lastError) throw lastError;
  if (start === 'gemini' && !clients.gemini) throw new Error('Gemini fallback is not configured');
  throw new Error('No configured chat provider is available');
}
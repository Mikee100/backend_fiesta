import OpenAI from 'openai';
import prisma from '../../../config/prisma';
import { classifyProviderRateLimit } from '../resilience.service';

const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0,
});

export const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'llama-3.1-8b-instant';
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
const gemini = process.env.GEMINI_API_KEY ? new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  maxRetries: 0,
}) : null;
export type ChatProvider = 'groq' | 'gemini';
const groqCooldownUntil = new WeakMap<Pick<OpenAI, 'chat'>, number>();

export function getGroqCooldownUntil(client: Pick<OpenAI, 'chat'> = openai): string | null {
  const until = groqCooldownUntil.get(client) || 0;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

function noteGroqRateLimit(error: any, client: Pick<OpenAI, 'chat'>): void {
  const headers = error?.headers ?? error?.response?.headers;
  const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  const seconds = Number(retryAfter);
  const fromHeader = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : retryAfter ? Date.parse(String(retryAfter)) - Date.now() : NaN;
  const fallback = classifyProviderRateLimit(error) === 'daily_tpd_exhausted' ? 60 * 60_000 : 60_000;
  const duration = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : fallback;
  groqCooldownUntil.set(client, Math.max(groqCooldownUntil.get(client) || 0, Date.now() + Math.min(duration, 24 * 60 * 60_000)));
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

export async function createChatCompletion(
  params: any,
  preferredProvider: ChatProvider = 'groq',
  clients: { groq: Pick<OpenAI, 'chat'>; gemini: Pick<OpenAI, 'chat'> | null } = { groq: openai, gemini }
): Promise<{ response: any; provider: ChatProvider; completionCalls: number }> {
  if (preferredProvider === 'gemini' || (clients.gemini && Date.now() < (groqCooldownUntil.get(clients.groq) || 0))) {
    if (!clients.gemini) throw new Error('Gemini fallback is not configured');
    try {
      const response = await clients.gemini.chat.completions.create({ ...params, model: GEMINI_CHAT_MODEL });
      await recordModelUsage('gemini', GEMINI_CHAT_MODEL, response, undefined, true);
      return { response, provider: 'gemini', completionCalls: 1 };
    } catch (error) {
      await recordModelUsage('gemini', GEMINI_CHAT_MODEL, undefined, error, true);
      throw error;
    }
  }

  try {
    const response = await clients.groq.chat.completions.create(params);
    await recordModelUsage('groq', params.model, response);
    return { response, provider: 'groq', completionCalls: 1 };
  } catch (error: any) {
    await recordModelUsage('groq', params.model, undefined, error);
    const status = error?.status ?? error?.response?.status;
    if (status === 429) noteGroqRateLimit(error, clients.groq);
    const transientNetworkError = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code);
    if (!clients.gemini || !(status === 429 || status === 408 || status >= 500 || transientNetworkError)) throw error;
    console.warn('Groq unavailable; switching chat completion to Gemini:', { status: status || error?.code });
    try {
      const response = await clients.gemini.chat.completions.create({ ...params, model: GEMINI_CHAT_MODEL });
      await recordModelUsage('gemini', GEMINI_CHAT_MODEL, response, undefined, true);
      return { response, provider: 'gemini', completionCalls: 2 };
    } catch (fallbackError) {
      await recordModelUsage('gemini', GEMINI_CHAT_MODEL, undefined, fallbackError, true);
      throw fallbackError;
    }
  }
}
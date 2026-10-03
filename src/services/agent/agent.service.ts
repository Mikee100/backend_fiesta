
import OpenAI from 'openai';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { bookingService } from '../booking/booking.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION, MINIMUM_BOOKING_DEPOSIT, PACKAGE_NAME_PATTERN, PACKAGE_NAMES_FOR_EXTRACTION, ADDON_CATALOG, type AddonCatalogItem } from '../../config/constants';
import { mpesaService } from '../payment/mpesa.service';
import { circuitBreaker, scoreSentiment, DAILY_TOKEN_CAP, FALLBACK_MESSAGE, PROVIDER_OUTAGE_MESSAGE, shouldNotifyOutage, classifyProviderRateLimit, isProviderRateLimitError } from './resilience.service';
import { notifyAdmin } from '../notifications/notification.service';
import { businessDay, inBusinessTimezone, nowInBusinessTimezone } from '../../utils/time';
import { getBookingPolicyWindow } from '../../utils/booking-policy';
import { ConversationFlowMatcher } from './conversation-flow.matcher';
import { ConversationFlowHandler } from './conversation-flow.handler';
import { customerReplyTemplates, formatCustomerReply } from '../messaging/customer-reply.templates';
import { bookingAddonService } from '../booking/booking-addon.service';
import { invoiceService } from '../invoice/invoice.service';
import { whatsappService } from '../messaging/whatsapp.service';

// Groq's API is OpenAI-compatible, so the 'openai' SDK works unmodified against its endpoint.
// Ensure you have GROQ_API_KEY in your .env
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  maxRetries: 0,
});

const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'llama-3.1-8b-instant';
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
const gemini = process.env.GEMINI_API_KEY ? new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  maxRetries: 0,
}) : null;
type ChatProvider = 'groq' | 'gemini';
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
const MAX_AGENT_COMPLETION_TOKENS = Math.min(2_500, Math.max(200, Number(process.env.AI_MAX_COMPLETION_TOKENS) || 1500));
const MAX_EXTRACTOR_COMPLETION_TOKENS = 120;
const MAX_RAG_CONTEXT_CHUNKS = 3;
const MAX_HISTORY_MESSAGES = 6;
const CANCELLATION_PROPOSAL_TTL_MS = 60 * 60 * 1000;
const OFFICIAL_WEBSITE_URLS = {
  home: 'https://www.fiestahousematernity.com/',
  reviews: 'https://www.fiestahousematernity.com/reviews',
  suspendingConcept: 'https://www.fiestahousematernity.com/gallery/suspending-concept',
} as const;
const PACKAGE_PRICING_FALLBACK = 'The Editions are THE BLOOM: Ksh 15,000, THE MUSE: Ksh 25,000, THE ICON: Ksh 35,000, THE LEGEND: Ksh 45,000, THE QUEEN: Ksh 55,000, THE EMPRESS: Ksh 70,000 (Most Loved / Signature), and THE GODDESS: Ksh 120,000 (Flagship).';

// --- Hybrid Booking Extractor ---
type BookingDetails = {
  name?: string | null;
  service?: string | null;
  date?: string | null;
  time?: string | null;
};

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  completionCalls: number;
};

type ReplyContext = {
  customerId: string;
  userMessage: string;
  platform: string;
  startedAt: number;
};

type ReplyOutcome = {
  success?: boolean;
  isFallback?: boolean;
  failureReason?: string;
  circuitBreakerTrip?: boolean;
  circuitBreakerReason?: string;
};

type MessageRouteResult = string | { reply: string; outcome?: ReplyOutcome } | null;

type MessageRoute = {
  name: string;
  when: () => boolean;
  handle: () => MessageRouteResult | Promise<MessageRouteResult>;
  deterministicOnly?: boolean;
};

function usageFromCompletion(response: any, completionCalls: number = 1): TokenUsage {
  return {
    inputTokens: response?.usage?.prompt_tokens || 0,
    outputTokens: response?.usage?.completion_tokens || 0,
    totalTokens: response?.usage?.total_tokens || 0,
    completionCalls,
  };
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.completionCalls += usage.completionCalls;
}

const MONTH_NAME_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO_DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Day-of-month only when written as an ordinal ("3rd"), next to a month name
 * ("3 Oct", "October 3") or inside an ISO date. Bare numbers ("7 months") and
 * hours ("3pm", "15:00") never count. `month` is 0-based when a month name was given.
 */
function findExplicitDate(message: string): { day: number; month: number | null } | null {
  const text = message.toLowerCase();
  const iso = text.match(ISO_DATE_PATTERN);
  if (iso) return { day: Number(iso[1].slice(8, 10)), month: Number(iso[1].slice(5, 7)) - 1 };

  const dayThenMonth = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_NAME_PATTERN})\\b`));
  const monthThenDay = text.match(new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:am|pm|:\\d|\\.\\d))`));
  const ordinal = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);

  let day: number;
  let monthName: string | null = null;
  if (dayThenMonth) {
    day = Number(dayThenMonth[1]);
    monthName = dayThenMonth[2];
  } else if (monthThenDay) {
    day = Number(monthThenDay[2]);
    monthName = monthThenDay[1];
  } else if (ordinal) {
    day = Number(ordinal[1]);
  } else {
    return null;
  }
  if (day < 1 || day > 31) return null;
  return { day, month: monthName ? MONTH_ABBREVIATIONS.indexOf(monthName.slice(0, 3)) : null };
}

function findExplicitDayOfMonth(message: string): number | null {
  return findExplicitDate(message)?.day ?? null;
}

function isAvailableSlotList(result: string[] | { status: string; reason: string }): result is string[] {
  return Array.isArray(result);
}

// Word-anchored so "exchange" or "remove" no longer read as a reschedule.
const RESCHEDULE_KEYWORD_PATTERN = /\b(?:reschedul(?:e|ed|es|ing)|chang(?:e|ed|es|ing)|mov(?:e|ed|es|ing)|postpon(?:e|ed|es|ing))\b/;

const PAYMENT_CONFIRMATION_REQUIRED_REPLY = 'Before I send the M-Pesa deposit prompt, please reply yes to confirm the booking.';
const PAYMENT_PROMPT_UNRECORDED = 'PAYMENT_PROMPT_UNRECORDED';
const PAYMENT_PROMPT_UNRECORDED_REPLY = 'Please check your phone for an M-Pesa prompt before trying again. If nothing arrives in a few minutes, the studio team can help.';

export class BookingExtractor {
  // 🧼 STEP 1: Clean Input
  private clean(text: string): string {
    return text
      .replace(/[^ 0-\w\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ⚡ STEP 2: Regex Extraction
  private regexExtract(text: string): BookingDetails {
    const cleanText = this.clean(text);

    // Don't extract names from short greetings
    if (cleanText.length < 10) return { name: null, service: null, date: null, time: null };

    // Look for patterns like "my name is..." or "this is..."
    const nameMatch = cleanText.match(/my name is ([a-z]{2,})/i) || 
                      cleanText.match(/this is ([a-z]{2,})/i) ||
                      cleanText.match(/i am ([a-z]{2,})/i);
    
    const serviceMatch = cleanText.match(
      new RegExp(`(?:the\\s+)?(${PACKAGE_NAME_PATTERN})(?:\\s+(?:package|edition))?`, 'i')
    );
    const isoDate = text.match(ISO_DATE_PATTERN)?.[1];
    const explicitDate = isoDate ? null : findExplicitDate(text);
    const timeMatch = cleanText.match(/(\d{1,2})(:|\s*)(\d{2})?\s*(am|pm)/i);

    let date;
    let time = null;

    if (timeMatch) {
      time = timeMatch[0].toLowerCase().replace(/\s/g, '');
    }
    if (isoDate && dayjs(isoDate).isValid()) {
      date = isoDate;
    } else if (explicitDate && explicitDate.month !== null) {
      const now = nowInBusinessTimezone();
      let parsed = now.month(explicitDate.month).date(explicitDate.day);
      if (parsed.isBefore(now, 'day')) parsed = parsed.add(1, 'year');
      // dayjs rolls "31 Nov" over into December; treat that as no date.
      if (parsed.month() === explicitDate.month && parsed.date() === explicitDate.day) {
        date = parsed.format('YYYY-MM-DD');
      }
    } else if (explicitDate) {
      const day = explicitDate.day;
      const now = nowInBusinessTimezone();
      let parsed = now.date(day);
      // If the resolved date is already in the past, the customer almost
      // certainly means the same day-of-month in the next calendar month
      // (e.g. "3rd" said on Sep 30 → Oct 3, not Sep 3).
      if (parsed.isValid() && parsed.isBefore(now, 'day')) {
        parsed = now.add(1, 'month').date(day);
      }
      if (parsed.isValid()) {
        date = parsed.format('YYYY-MM-DD');
      }
    }

    return {
      name: nameMatch?.[1] || null,
      service: serviceMatch?.[1] || null,
      date: date || null,
      time: time || null
    };
  }

  // 🤖 STEP 3: AI Extraction (STRICT JSON)
  private async aiExtract(message: string): Promise<{ details: BookingDetails; usage: TokenUsage }> {
    const now = nowInBusinessTimezone().format('dddd, MMMM D, YYYY h:mm A');
    const { response } = await createChatCompletion({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `Current Date/Time: ${now}\n\nExtract booking details from the user message.\n\nReturn ONLY valid JSON. No text.\n\nFormat:\n{\n  "name": string | null,\n  "service": string | null,\n  "date": string | null,\n  "time": string | null\n}\n\nRules:\n- Name must be full name if possible
- Service must be one of the 2026 Editions: ${PACKAGE_NAMES_FOR_EXTRACTION.join(', ')} (or legacy: standard, economy, executive, gold, platinum, vip, vvip if the customer still uses those names)
- Prefer Edition names like "THE EMPRESS" over legacy names
- Convert date into YYYY-MM-DD
- Convert time into 24h format (HH:mm)
- If missing, return null
`
        },
        { role: 'user', content: message }
      ],
      temperature: 0,
      max_completion_tokens: MAX_EXTRACTOR_COMPLETION_TOKENS,
    });
    let details: BookingDetails = {};
    try {
      details = JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      details = {};
    }
    return { details, usage: usageFromCompletion(response) };
  }

  // 🔥 FINAL HYBRID METHOD
  // Skips the expensive AI extraction call when no booking-related signals are
  // present in the message (e.g. pure questions, greetings, complaints) - this
  // avoids the double-LLM-call latency and token burn for ~60% of messages.
  private hasBookingSignals(message: string): boolean {
    const text = message.toLowerCase();
    return /\b(\d{1,2})(st|nd|rd|th)?\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week)\b|\b(am|pm)\b|\bbook|\bschedule|\bappointment|\bsession|\bpackage|\bbloom|\bmuse|\bicon|\blegend|\bqueen|\bempress|\bgoddess|\bresched|\bcancel|\bdeposit|\bmpesa|\bpay/i.test(text);
  }

  private needsAiExtraction(message: string): boolean {
    const text = message.toLowerCase();
    const rescheduleSignal = /\b(reschedule|change|move|postpone)\b/.test(text);
    const hasDateSignal = /\b\d{1,2}(st|nd|rd|th)?\b|\b\d{4}-\d{2}-\d{2}\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+week)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(text);
    const hasTimeSignal = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{2}:\d{2}\b/.test(text);
    return rescheduleSignal && hasDateSignal && hasTimeSignal;
  }

  async extract(message: string): Promise<{ details: BookingDetails; usage: TokenUsage }> {
    const regex = this.regexExtract(message);
    console.log('Regex result:', regex);
    if (regex.name && regex.service && regex.date && regex.time) {
      return { details: regex, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, completionCalls: 0 } };
    }
    if (!this.needsAiExtraction(message)) {
      console.log('No reschedule date/time extraction needed - skipping AI extractor call.');
      return { details: regex, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, completionCalls: 0 } };
    }
    const { details: ai, usage } = await this.aiExtract(message);
    console.log('AI result:', ai);
    return {
      details: {
        name: regex.name || ai.name,
        service: regex.service || ai.service,
        date: regex.date || ai.date,
        time: regex.time || ai.time
      },
      usage
    };
  }
}


export class AgentService {
  private readonly naturalAssistantMode = String(process.env.AI_ASSISTANT_NATURAL_MODE || 'false').toLowerCase() === 'true';
  private readonly conversationFlows = new ConversationFlowMatcher();
  private readonly conversationFlowHandler = new ConversationFlowHandler(this.conversationFlows);

  private isNaturalAssistantModeEnabled(): boolean {
    return this.naturalAssistantMode;
  }

  /** Records the turn's metric and learning rows in the background and returns the reply unchanged. */
  private respond(ctx: ReplyContext, reply: string, outcome: ReplyOutcome = {}): string {
    const { success = true, isFallback = false, ...failureDetails } = outcome;
    const latencyMs = Date.now() - ctx.startedAt;
    this.logInBackground('AI job metric', () => this.logAiJobMetric({
      customerId: ctx.customerId,
      platform: ctx.platform,
      success,
      latencyMs,
      ...(isFallback ? { isFallback } : {}),
      ...failureDetails,
    }));
    this.logInBackground('conversation learning', () => this.logConversationLearning({
      customerId: ctx.customerId,
      userMessage: ctx.userMessage,
      aiResponse: reply,
      platform: ctx.platform,
      latencyMs,
      wasSuccessful: success,
      isFallback,
    }));
    return reply;
  }

  /** Never lets a logging failure (sync throw or rejection) reach the caller or become an unhandled rejection. */
  private logInBackground(label: string, task: () => Promise<unknown>): void {
    Promise.resolve()
      .then(task)
      .catch((err) => console.error(`Failed to log ${label}:`, err));
  }

  private formatCustomerReply(
    reply: string,
    userMessage = '',
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string {
    const formattedReply = formatCustomerReply(reply);
    const aboutSuspendingConcept = /suspending\s+concept/i.test(userMessage)
      || history.slice(-6).some((message) => /suspending\s+concept/i.test(message.content));

    return formattedReply.replace(
      /https?:\/\/(?:www\.)?fiestahousematernity\.com(?:\/[^\s<>"'()[\]{}]*)?/gi,
      (matchedUrl) => {
        const trailingPunctuation = matchedUrl.match(/[.,!?;:]+$/)?.[0] || '';
        const urlWithoutPunctuation = trailingPunctuation
          ? matchedUrl.slice(0, -trailingPunctuation.length)
          : matchedUrl;
        const path = new URL(urlWithoutPunctuation).pathname.replace(/\/+$/, '') || '/';

        if (path === '/reviews' || path === '/gallery/suspending-concept' || path === '/') {
          return path === '/reviews'
            ? OFFICIAL_WEBSITE_URLS.reviews + trailingPunctuation
            : path === '/gallery/suspending-concept'
              ? OFFICIAL_WEBSITE_URLS.suspendingConcept + trailingPunctuation
              : OFFICIAL_WEBSITE_URLS.home + trailingPunctuation;
        }
        if (path === '/testimonials') return OFFICIAL_WEBSITE_URLS.reviews + trailingPunctuation;
        if (path === '/gallery' && aboutSuspendingConcept) {
          return OFFICIAL_WEBSITE_URLS.suspendingConcept + trailingPunctuation;
        }
        return OFFICIAL_WEBSITE_URLS.home + trailingPunctuation;
      }
    );
  }

  private normalizeToolName(rawName: string): string {
    return String(rawName || '').split('<|')[0].trim();
  }

  private isToolNameValidationError(error: any): boolean {
    const message = String(error?.error?.message || error?.message || '');
    return (
      error?.status === 400 &&
      error?.code === 'tool_use_failed' &&
      message.includes('attempted to call tool')
    );
  }

  /** Provider rejects the turn when the model emits a tool call while no tools were exposed. */
  private isToolCallWithoutToolsError(error: any): boolean {
    const message = String(error?.error?.message || error?.message || '').toLowerCase();
    return (
      error?.status === 400 &&
      error?.code === 'tool_use_failed' &&
      message.includes('tool choice is none')
    );
  }

  private async createCompletionWithToolNameGuard(
    params: any,
    allowedToolNames: string[],
    fallbackTools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    preferredProvider: ChatProvider = 'groq'
  ): Promise<{ response: any; completionCalls: number; provider: ChatProvider }> {
    let provider = preferredProvider;
    let completionCalls = 0;
    const request = async (requestParams: any) => {
      const result = await createChatCompletion(requestParams, provider);
      provider = result.provider;
      completionCalls += result.completionCalls;
      return result.response;
    };
    try {
      return { response: await request(params), completionCalls, provider };
    } catch (error: any) {
      if (this.isToolCallWithoutToolsError(error)) {
        console.warn('Retrying completion after tool call was emitted with no tools exposed.');
        if (fallbackTools && fallbackTools.length > 0) {
          try {
            const response = await request({
                ...params,
                tools: fallbackTools,
                tool_choice: 'auto',
              });
            return { response, completionCalls, provider };
          } catch (toolRetryError: any) {
            if (isProviderRateLimitError(toolRetryError)) throw toolRetryError;
            console.warn('Retry with fallback tools failed:', toolRetryError?.message);
          }
        }

        try {
          const { tools: _tools, tool_choice: _toolChoice, ...toollessParams } = params;
          const response = await request({
              ...toollessParams,
              messages: [
                ...params.messages,
                {
                  role: 'system',
                  content: 'CRITICAL: No tools are available this turn. Do NOT emit a tool or function call. Reply to the customer in plain text only, and ask for any missing booking details instead of looking them up.'
                }
              ],
              temperature: 0,
            });
          return { response, completionCalls, provider };
        } catch (textRetryError: any) {
          if (isProviderRateLimitError(textRetryError)) throw textRetryError;
          console.error('Toolless retry failed after model emitted tool call:', textRetryError?.message);
          throw error;
        }
      }

      if (!this.isToolNameValidationError(error)) {
        throw error;
      }

      // Some providers occasionally append transport/control tokens to tool
      // names, which fails request.tools validation. Retry once with an
      // explicit hard rule and lower temperature.
      let attemptedRawName: string | undefined;
      try {
        const failedGeneration = error?.error?.failed_generation;
        if (failedGeneration) {
          const parsed = JSON.parse(failedGeneration);
          attemptedRawName = parsed?.name;
        }
      } catch {
        // Best-effort parse only; keep retrying even if parsing fails.
      }

      const attemptedNormalized = this.normalizeToolName(attemptedRawName || '');
      console.warn('Retrying completion after malformed tool name:', {
        attemptedRawName,
        attemptedNormalized,
      });

      const retryMessages = [
        ...params.messages,
        {
          role: 'system',
          content: `CRITICAL TOOL RULE: If you call a tool, the function name must be EXACTLY one of: ${allowedToolNames.join(', ')}. Do not add any extra suffixes, prefixes, tags, or channel markers.`
        }
      ];

      const response = await request({
          ...params,
          messages: retryMessages,
          temperature: 0,
        });
      return { response, completionCalls, provider };
    }
  }

  // Hard, non-LLM gate for propose_reschedule: the customer's OWN message text
  // must actually contain a date or time signal. Neither the tool-calling
  // model's own arguments nor the separate BookingExtractor's AI pass can be
  // trusted alone here - both can echo back or hallucinate a date (e.g. the
  // customer's existing upcoming-booking date from context) even when the
  // customer only asked an info question and stated no new date/time at all.
  private messageContainsExplicitDateTimeSignal(message: string): boolean {
    return this.messageContainsExplicitDateSignal(message) && this.messageContainsExplicitTimeSignal(message);
  }

  /** Customers often give the date and time across separate messages ("8th at 6pm" then "lets do 3pm"). */
  private hasRescheduleDateTimeSignal(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const hasDate = this.messageContainsExplicitDateSignal(userMessage);
    const hasTime = this.messageContainsExplicitTimeSignal(userMessage);
    if (hasDate && hasTime) return true;
    if (!hasDate && !hasTime) return false;
    const recentUserMessages = history.filter((m) => m.role === 'user').slice(-3).map((m) => m.content);
    return hasDate
      ? recentUserMessages.some((m) => this.messageContainsExplicitTimeSignal(m))
      : recentUserMessages.some((m) => this.messageContainsExplicitDateSignal(m));
  }

  private getUnverifiedActionReply(
    reply: string,
    done: { rescheduled: boolean; cancelled: boolean; noteSaved: boolean }
  ): string | null {
    const claimsRescheduled = /\b(?:has been|have been|is now|i've|i have|successfully)\s+(?:rescheduled|moved)\b/i.test(reply);
    if (claimsRescheduled && !done.rescheduled) {
      return "Sorry, I haven't been able to apply that reschedule yet, so your booking is still on its original date and time. Please send the new date and time together (e.g. \"8th October at 3pm\") and I'll confirm it.";
    }
    const claimsCancelled = /\b(?:has been|have been|i've|i have|successfully)\s+cancell?ed\b/i.test(reply);
    if (claimsCancelled && !done.cancelled) {
      return "Sorry, I haven't been able to cancel that booking yet - it is still active. Please tell me the date of the session you'd like to cancel.";
    }
    const claimsAddonSaved = /\b(?:i've|i have)\s+(?:added|noted|included|recorded)\b|\bhas been added\b/i.test(reply)
      && (/add-?on|extra/i.test(reply) || ADDON_CATALOG.some((item) => item.match.test(reply)));
    if (claimsAddonSaved && !done.noteSaved) {
      return "Sorry, I couldn't save that add-on just yet. Please tell me the add-on and quantity (e.g. \"2 extra outfits\") and I'll record it.";
    }
    return null;
  }

  private messageContainsExplicitDateSignal(message: string): boolean {
    const text = message.toLowerCase();
    return findExplicitDayOfMonth(text) !== null
      || /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+week)\b|\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/.test(text);
  }

  private messageContainsExplicitTimeSignal(message: string): boolean {
    const text = message.toLowerCase();
    return /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{2}:\d{2}\b/.test(text);
  }

  private shouldResolvePackageSelectionImmediately(userMessage: string): boolean {
    return this.conversationFlows.isPackageSelection(userMessage)
      && !this.messageContainsExplicitDateSignal(userMessage);
  }

  private getAuthoritativeRequestedDate(
    userMessage: string,
    proposedDate: string,
    extractedDate?: string | null,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string {
    const hasDayOfMonth = findExplicitDayOfMonth(userMessage) !== null;
    if (!hasDayOfMonth) {
      const weekdayDate = this.getContextualBookingWeekdayDate(userMessage, history);
      return weekdayDate || proposedDate;
    }
    if (!extractedDate) return proposedDate;
    // Guard: never let a past extracted date override the LLM's future proposed
    // date. A past extractedDate almost always means the regex picked up the
    // wrong calendar month (e.g. Sep 3 when the customer meant Oct 3).
    const extractedIsInPast = dayjs(extractedDate).isBefore(dayjs(), 'day');
    if (extractedIsInPast) return proposedDate;
    return extractedDate;
  }

  private getContextualBookingWeekdayDate(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): string | null {
    const weekdayPattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
    const bookingContextPattern = /\b(slots?|availability|available|booking|book|session|appointment|schedule)\b/i;
    const contextualText = weekdayPattern.test(userMessage)
      ? userMessage
      : [...history].reverse().find((message) =>
        bookingContextPattern.test(message.content) && weekdayPattern.test(message.content)
      )?.content;
    const weekdayName = contextualText?.match(weekdayPattern)?.[1]?.toLowerCase();
    if (!weekdayName) return null;

    const weekdays: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const weekday = weekdays[weekdayName];
    const explicitDate = contextualText?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (explicitDate && dayjs(explicitDate).isValid() && dayjs(explicitDate).day() === weekday) {
      return explicitDate;
    }

    const now = nowInBusinessTimezone();
    let date = now.day(weekday);
    if (date.isBefore(now, 'day') || (date.isSame(now, 'day') && /\bnext\b/i.test(contextualText || ''))) {
      date = date.add(7, 'day');
    }
    return date.format('YYYY-MM-DD');
  }

  private shouldUseRescheduleRequestReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return RESCHEDULE_KEYWORD_PATTERN.test(text)
      && !this.messageContainsExplicitDateTimeSignal(userMessage)
      && !this.conversationFlows.isTimeOnlyRescheduleRequest(userMessage);
  }

  private shouldUseRescheduleWithdrawalReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const text = userMessage.toLowerCase().trim();
    const withdrawal = /\b(let'?s|we should)\s+(not|don't|do not)\s+(reschedule|change|move|postpone)\b|\b(no|never mind|nevermind|forget it)\b.*\b(reschedule|change|move|postpone)\b|\bkeep\s+(the|my|this)\s+(original|current)\s+(date|time|booking|session)\b/.test(text);
    if (!withdrawal) return false;

    return history.slice(-6).some((message) =>
      message.role === 'assistant' && /reschedul|move|forfeit.*deposit|within 72 hours/i.test(message.content)
    );
  }

  private async withdrawPendingReschedule(customerId: string): Promise<void> {
    await prisma.bookingDraft.deleteMany({
      where: { customerId, step: 'reschedule_confirm' },
    });
  }

  private inferIntent(userMessage: string): { intent: string; confidence: number; rule: string } {
    const text = userMessage.toLowerCase();

    if (RESCHEDULE_KEYWORD_PATTERN.test(text)) return { intent: 'reschedule', confidence: 0.92, rule: 'reschedule_keywords' };
    if (/(\bbook(?:s|ed|ing)?\b|appointment|session)/.test(text)) return { intent: 'booking', confidence: 0.88, rule: 'booking_keywords' };
    if (/(\bpa(?:y|ys|ying|id|yment|yments)\b|mpesa|deposit|receipt|balance)/.test(text)) return { intent: 'payment', confidence: 0.9, rule: 'payment_keywords' };
    if (/(price|cost|package|rate|services|service list)/.test(text)) return { intent: 'pricing', confidence: 0.86, rule: 'pricing_keywords' };
    if (/(where|location|located|address)/.test(text)) return { intent: 'location', confidence: 0.9, rule: 'location_keywords' };
    if (/(time|hours|open|close|availability|available|how long|duration)/.test(text)) return { intent: 'availability', confidence: 0.82, rule: 'availability_keywords' };

    return { intent: 'general_inquiry', confidence: 0.35, rule: 'fallback_default' };
  }

  private inferOutcome(aiResponse: string, isFallback: boolean): string {
    if (isFallback) return 'escalated';

    const text = aiResponse.toLowerCase();
    if (text.includes('m-pesa') && text.includes('deposit')) return 'booked';
    if (text.includes('rescheduled')) return 'resolved';
    if (text.includes('team member') || text.includes('follow up')) return 'escalated';

    return 'resolved';
  }

  private getWeekdayReply(
    userMessage: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): string | null {
    const match = userMessage.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (!match) return null;

    const day = Number(match[1]);
    if (day < 1 || day > 31) return null;

    const recentDateMention = [...history]
      .reverse()
      .map((message) => message.content.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i))
      .find((dateMatch) => dateMatch && Number(dateMatch[1]) === day);

    if (recentDateMention) {
      const contextualDate = dayjs(`${recentDateMention[1]} ${recentDateMention[2]} ${recentDateMention[3]}`, 'D MMMM YYYY');
      if (contextualDate.isValid()) {
        return `${contextualDate.format('MMMM D, YYYY')} is a ${contextualDate.format('dddd')}.`;
      }
    }

    const current = nowInBusinessTimezone();
    let date = current.date(day);
    if (date.isBefore(current, 'day')) date = date.add(1, 'month');

    return `${date.format('MMMM D, YYYY')} is a ${date.format('dddd')}.`;
  }

  private getBusinessIntroductionReply(): string {
    return 'Welcome to Fiesta House! We are a boutique luxury photography studio in Parklands, Nairobi, specialising in maternity, newborn, and family portraiture. We take care of everything—from our curated client gown closet and professional hair & makeup to gentle posing guidance so you feel relaxed and radiant in front of the camera. What kind of photoshoot are you planning?';
  }

  private shouldUseBookingProcessReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(process\s+of\s+booking|booking\s+process|how\s+to\s+book|how\s+does\s+booking\s+work|what\s+does\s+booking\s+entail|steps\s+to\s+book|explain\s+booking)/.test(text);
  }

  private shouldUsePostShootProcessReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(after\s+the\s+shoot|what\s+happens\s+after\s+the\s+shoot|post\s*shoot\s*process|after\s+session|after\s+my\s+shoot)/.test(text);
  }

  private shouldUseEarliestImageDeliveryReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(when\s+(can|will)\s+i\s+get\s+(the\s+)?(images|photos)|earliest\s+i\s+can\s+get\s+(the\s+)?(images|photos)|how\s+soon\s+can\s+i\s+get\s+(the\s+)?(images|photos)|when\s+are\s+(the\s+)?(images|photos)\s+ready|delivery\s+date\s+for\s+(images|photos))/.test(text);
  }

  private shouldUseRawFilesReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(raw\s+file|raw\s+files|unedited\s+photos|original\s+files|can\s+i\s+get\s+raw)/.test(text);
  }

  private extractInvoiceNumber(userMessage: string): string | null {
    const match = userMessage.match(/\bINV-\d{4}-\d{3}\b/i);
    return match ? match[0].toUpperCase() : null;
  }

  private extractInvoiceSessionDateRange(userMessage: string): { start: Date; end: Date } | null {
    const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const match = userMessage.match(new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?[\\s/-]+${monthPattern}|${monthPattern}[\\s/-]+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(\\d{4}))?\\b`, 'i'));
    if (!match) return null;

    const day = Number(match[1] || match[4]);
    const monthName = (match[2] || match[3]).slice(0, 3).toLowerCase();
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthName);
    if (month < 0 || day < 1 || day > 31) return null;

    const year = Number(match[5] || nowInBusinessTimezone().year());
    const start = nowInBusinessTimezone().year(year).month(month).date(day).startOf('day');
    if (start.year() !== year || start.month() !== month || start.date() !== day) return null;

    return { start: start.toDate(), end: start.add(1, 'day').toDate() };
  }

  private shouldUseInvoiceRequestReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): boolean {
    const text = userMessage.toLowerCase();
    const invoiceKeywords = /(invoice|receipt|payment summary)/.test(text);
    const actionKeywords = /(send|sent|share|download|get|give(?: me)?|provide|view|need|can you|could you)/.test(text);
    if (invoiceKeywords && actionKeywords) return true;

    const selectedSessionDate = this.extractInvoiceSessionDateRange(userMessage);
    const assistantAskedForInvoiceDate = history.slice(-6).some((message) =>
      message.role === 'assistant'
      && /\binvoices?\b[\s\S]{0,300}\bwhich session date\b/i.test(message.content)
    );
    if (selectedSessionDate && assistantAskedForInvoiceDate) return true;

    const resendRequest = /\b(send|resend|forward|share|get|deliver)\b/.test(text)
      && /\b(it|that|this|again|another time)\b/.test(text);
    const refersToInvoice = history.slice(-6).some((message) =>
      message.role === 'assistant' && /\binvoice\b|\bINV-\d{4}-\d{3}\b|pdf.{0,20}(?:whatsapp|sent|attached)/i.test(message.content)
    );
    const reportsNotReceived = /\b(not|haven't|have not|never)\s+(?:received|got|get)\b/.test(text)
      || /\bdidn't\s+(?:receive|get)\b/.test(text);
    return refersToInvoice && (reportsNotReceived || resendRequest);
  }

  private getInvoiceSessionDateFromHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): { start: Date; end: Date } | null {
    let latestInvoiceDeliveryIndex = -1;
    history.forEach((message, index) => {
      if (
        message.role === 'assistant'
        && /\binvoice\b/i.test(message.content)
        && /\b(send|sent|deliver|forward|pull up|email|attached)\b/i.test(message.content)
      ) {
        latestInvoiceDeliveryIndex = index;
      }
    });

    if (latestInvoiceDeliveryIndex < 0) return null;
    const selectedDate = history
      .slice(0, latestInvoiceDeliveryIndex)
      .reverse()
      .find((message) => message.role === 'user' && this.extractInvoiceSessionDateRange(message.content));
    return selectedDate ? this.extractInvoiceSessionDateRange(selectedDate.content) : null;
  }

  private shouldDeclineConsolidatedInvoiceRequest(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    const asksForInvoice = /\b(invoice|receipt|payment summary)\b/.test(text);
    const asksForMultiple = /\b(all|every|each|combined|consolidated)\b/.test(text)
      || /\b(?:one|single)\s+(?:combined\s+|consolidated\s+)?invoice\b/.test(text)
      || /\bin one\b/.test(text);
    return asksForInvoice && asksForMultiple;
  }

  private shouldUsePastAppointmentsListReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /\b(previous|past|earlier|prior)\s+(appointments|bookings|sessions|shoots)\b/.test(text)
      || /\b(show|list)\b.*\b(previous|past|earlier|prior)\b.*\b(appointments|bookings|sessions|shoots)\b/.test(text)
      || /\bwhat\s+(appointments|bookings|sessions|shoots)\s+have\s+i\s+had\b/.test(text);
  }

  private isUnverifiedBookingConfirmation(
    reply: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const claimsConfirmed = /\b(?:session is all set|booking is confirmed|session is confirmed|successfully booked|payment has gone through|payment is received and confirmed)\b/i.test(reply);
    if (!claimsConfirmed) return false;

    const bookingFlowInProgress = /\b(book|booking|reserve|package|new session|new appointment)\b/i.test(userMessage)
      || history.slice(-6).some((message) =>
        message.role === 'assistant'
        && /\b(?:which|what|share|tell me|let me know).{0,80}\b(?:package|date|time|slot)\b|check availability/i.test(message.content)
      );
    return bookingFlowInProgress;
  }

  private isBookingIdentityCorrection(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /\b(mixing|mixed up)\b.{0,100}\b(session|booking)s?\b/.test(text)
      || /\bthat(?:'s| is) mine\b.{0,100}\b(new|another|separate)\b/.test(text)
      || /\bcreating a new one\b/.test(text);
  }

  private getRequestedBookingFromHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): { recipient: string | null; service: string | null; date: string; time: string } | null {
    const userMessages = history.filter((message) => message.role === 'user');
    const requestedDateTimeMessage = [...userMessages].reverse().find((message) =>
      /\b\d{1,2}(?:st|nd|rd|th)?\b[\s\S]{0,24}\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message.content)
    );
    if (!requestedDateTimeMessage) return null;

    const match = requestedDateTimeMessage.content.match(
      /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))?(?:,?\s+(\d{4}))?[\s\S]{0,24}?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
    );
    if (!match) return null;

    const day = Number(match[1]);
    const monthName = match[2]?.slice(0, 3).toLowerCase();
    const monthIndex = monthName
      ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthName)
      : nowInBusinessTimezone().month();
    const explicitYear = match[3] ? Number(match[3]) : null;
    let requestedDate = nowInBusinessTimezone()
      .year(explicitYear || nowInBusinessTimezone().year())
      .month(monthIndex)
      .date(day);
    if (!requestedDate.isValid() || requestedDate.date() !== day || requestedDate.month() !== monthIndex) return null;
    if (!explicitYear && requestedDate.isBefore(nowInBusinessTimezone(), 'day')) {
      requestedDate = monthName ? requestedDate.add(1, 'year') : nowInBusinessTimezone().add(1, 'month').date(day);
    }

    const rawHour = Number(match[4]);
    const minute = Number(match[5] || 0);
    if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
    const hour = rawHour % 12 + (match[6].toLowerCase() === 'pm' ? 12 : 0);
    const service = PACKAGE_NAMES_FOR_EXTRACTION.find((packageName) =>
      userMessages.some((message) => message.content.toLowerCase().includes(packageName.toLowerCase()))
    ) || null;
    const recipientFromCustomer = [...userMessages].reverse()
      .map((message) => message.content.match(/\bfor\s+(?:my\s+(?:sister|brother|friend|husband|wife|partner|mother|father|daughter|son)\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/))
      .find(Boolean)?.[1] || null;

    return {
      recipient: recipientFromCustomer,
      service,
      date: requestedDate.format('YYYY-MM-DD'),
      time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }

  private async getBookingIdentityCorrectionReply(
    customerId: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string> {
    const request = this.getRequestedBookingFromHistory(history);
    const draft = await bookingDraftService.get(customerId);
    const recipient = draft?.recipientName || request?.recipient;
    if (!request?.service || !request.date || !request.time || !recipient) {
      return 'You’re right, I mixed up the sessions. Your existing appointment will remain unchanged, and I will not treat the separate booking as confirmed. Please confirm the recipient, package, date, and time for the new session.';
    }

    const duration = SERVICE_DURATIONS[request.service.toLowerCase()];
    const slotsResult = await bookingService.getAvailableSlots(request.date, duration || DEFAULT_DURATION);
    if (!isAvailableSlotList(slotsResult) && slotsResult.status === 'closed') {
      return `You’re right, I mixed up the sessions. Your existing appointment is unchanged. The separate ${request.service} request for ${recipient} is not booked; the studio is closed on ${inBusinessTimezone(request.date).format('dddd, D MMMM')}. Please choose another date.`;
    }

    const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(request.time)) {
      const alternatives = availableSlots.slice(0, 4)
        .map((time) => dayjs(`2000-01-01T${time}`).format('h:mm A'))
        .join(', ');
      return `You’re right, I mixed up the sessions. Your existing appointment is unchanged. The separate ${request.service} session for ${recipient} on ${inBusinessTimezone(request.date).format('dddd, D MMMM')} at ${dayjs(`2000-01-01T${request.time}`).format('h:mm A')} is not available, so I have not created another booking. Available times are ${alternatives || 'none'}. Which would work?`;
    }

    return `You’re right, I mixed up the sessions. Your existing appointment is unchanged. I understand this is a separate ${request.service} booking for ${recipient}. ${inBusinessTimezone(request.date).format('dddd, D MMMM')} at ${dayjs(`2000-01-01T${request.time}`).format('h:mm A')} is available, but it is not booked yet. What is ${recipient}’s full name so I can prepare the booking correctly?`;
  }

  private async getPastAppointmentsListReply(customerId: string): Promise<string> {
    const bookings = await prisma.booking.findMany({
      where: {
        customerId,
        status: { not: 'cancelled' },
        dateTime: { lt: new Date() },
      },
      orderBy: { dateTime: 'desc' },
      select: { service: true, dateTime: true, status: true },
    });

    if (bookings.length === 0) return "I don't see any past bookings on record yet.";

    const entries = bookings.map((booking) =>
      `${booking.service} - ${inBusinessTimezone(booking.dateTime).format('dddd, D MMMM YYYY')} (booking status: ${booking.status})`
    );
    return `Here are the past booking records I can see. The booking record doesn't confirm whether each session took place:\n${entries.join('\n')}`;
  }

  private async sendStoredInvoiceToCustomer(
    customerId: string,
    requestedInvoiceNumber?: string,
    history: { role: 'user' | 'assistant'; content: string }[] = [],
    userMessage = ''
  ): Promise<string> {
    if (this.shouldDeclineConsolidatedInvoiceRequest(userMessage)) {
      return 'Invoices are issued per booking, and I cannot combine multiple sessions into one invoice here. I have not sent an invoice, so I do not send the wrong session by mistake. Please tell me which session date you need, or ask the studio team about a consolidated statement.';
    }

    const requestedSessionDate = this.extractInvoiceSessionDateRange(userMessage)
      || this.getInvoiceSessionDateFromHistory(history);
    const refersToPastAppointment = !requestedInvoiceNumber && [...history].reverse()
      .find((message) => message.role === 'assistant')?.content
      .includes('The most recent past booking I have on record is');
    const pastBooking = refersToPastAppointment
      ? await prisma.booking.findFirst({
          where: { customerId, status: { not: 'cancelled' }, dateTime: { lt: new Date() } },
          orderBy: { dateTime: 'desc' },
          select: { id: true },
        })
      : null;

    let invoice;
    if (requestedInvoiceNumber) {
      invoice = await prisma.invoice.findFirst({
          where: { customerId, invoiceNumber: requestedInvoiceNumber },
          include: { booking: true },
        });
    } else if (requestedSessionDate) {
      const bookingOnDate = await prisma.booking.findFirst({
        where: {
          customerId,
          status: { not: 'cancelled' },
          dateTime: { gte: requestedSessionDate.start, lt: requestedSessionDate.end },
        },
        orderBy: { dateTime: 'desc' },
        select: { id: true },
      });
      if (bookingOnDate) {
        invoice = await prisma.invoice.findUnique({
          where: { bookingId: bookingOnDate.id },
          include: { booking: true },
        });
      }
    } else if (pastBooking) {
      invoice = await prisma.invoice.findUnique({
            where: { bookingId: pastBooking.id },
            include: { booking: true },
          });
    } else {
      invoice = await prisma.invoice.findFirst({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          include: { booking: true },
        });
    }

    if (!invoice) {
      if (requestedSessionDate) {
        return "I couldn't find a saved invoice for a session on that date, so I haven't sent another session's invoice.";
      }
      if (refersToPastAppointment) {
        return "I couldn't find an invoice saved for your most recent past session. I don't want to send you the wrong session's invoice, so please ask the team to check that booking.";
      }
      if (requestedInvoiceNumber) {
        return `I could not find invoice ${requestedInvoiceNumber} under your account. Please confirm the invoice number or ask the team to resend it.`;
      }
      return 'I could not find a saved invoice for your account yet. Please confirm the booking or ask the team to generate one.';
    }

    const refreshedInvoice = await invoiceService.createOrRefreshForBooking(invoice.bookingId);
    if (refreshedInvoice) invoice = refreshedInvoice;

    const { lineItems: addonLines } = await bookingAddonService.sumForBooking(invoice.bookingId);
    const addonSummary = addonLines.length > 0
      ? `\nAdd-ons:\n${addonLines.map((line) => `${line.name}: ${line.totalPrice > 0 ? `KSh ${line.totalPrice.toLocaleString()}` : 'Quoted'}`).join('\n')}\n`
      : '';
    const summary = `Invoice ${invoice.invoiceNumber}\n\nService: ${invoice.booking.service}\nDate: ${invoice.booking.dateTime.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' })}${addonSummary}\nTotal: KSh ${invoice.total.toLocaleString()}\nDeposit Paid: KSh ${invoice.depositPaid.toLocaleString()}\nBalance Due: KSh ${invoice.balanceDue.toLocaleString()}\n\nYour invoice is attached here as a PDF.`;

    try {
      if (!invoice.pdfData) {
        throw new Error('No PDF stored for this invoice');
      }

      await whatsappService.sendDocument(customerId, Buffer.from(invoice.pdfData), `${invoice.invoiceNumber}.pdf`, summary);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      return 'I’ve sent your invoice as a PDF to WhatsApp.';
    } catch (error: any) {
      console.error('Failed to send stored PDF invoice to WhatsApp:', error?.message || error);
      const downloadUrl = `${process.env.BASE_URL || ''}/api/invoices/download/${invoice.id}`;
      try {
        await whatsappService.sendMessage(customerId, `${summary}\n\nDownload your invoice: ${downloadUrl}`);
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { status: 'sent', sentAt: new Date() },
        });
        return 'I’ve sent the invoice details and a download link to WhatsApp.';
      } catch (fallbackError: any) {
        console.error('Fallback invoice message failed:', fallbackError?.message || fallbackError);
        return 'I found your invoice, but I could not send it right now. Please ask the team to resend it or use the invoice download link from the dashboard.';
      }
    }
  }

  private shouldUsePackageBudgetReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(cheapest|most affordable|lowest cost|budget friendly|budget-friendly|cheap|affordable|same as last time|like last time|same as before|same package as last time)/.test(text);
  }

  private getPackageBudgetReply(): string {
    return 'I can help with that. The most affordable option is usually THE BLOOM, while THE ICON is the most popular mid-range package. If you want to keep it simple, tell me which package you prefer: THE BLOOM, THE ICON, or a premium option like THE EMPRESS or THE ROYAL.';
  }

  private shouldClarifyMixedIntent(userMessage: string): boolean {
    if (this.shouldUseUpcomingAppointmentDetailsReply(userMessage)) return false;
    const text = userMessage.toLowerCase();
    const invoiceForSession = this.shouldUseInvoiceRequestReply(userMessage)
      && /\b(session|shoot|appointment|booking)\b/.test(text)
      && !/\b(book|schedule|reschedule|cancel)\b/.test(text);
    if (invoiceForSession) return false;

    const hasInvoice = /(invoice|receipt|payment summary)/.test(text);
    const hasPackage = /(package|session|shoot|service|edition|the bloom|the icon|the empress|the royal|gold|platinum|vip|vvip)/.test(text);
    const hasDate = /(next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\b\d{1,2}(?:st|nd|rd|th)?\b|tomorrow|today|weekend)/.test(text);
    // Must be a real action verb: "session"/"shoot" already count under hasPackage.
    const hasBookingAction = /\b(book|booking|schedule|rescheduling|reschedule|cancel|appointment)\b/.test(text);

    const matchedSignals = [hasInvoice, hasPackage, hasDate, hasBookingAction].filter(Boolean).length;
    return matchedSignals >= 3 && !(hasInvoice && !hasPackage && !hasDate && !hasBookingAction);
  }

  private getMixedIntentClarificationReply(): string {
    return 'I can help with the package, the date, or the invoice. Which one would you like to sort out first?';
  }

  private shouldUseAdditionsReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(additions|add-ons|add-on|extras|extra\s+services|extra\s+photo|extra\s+outfit|extra\s+makeup|digital\s+art|power\s+suit|wig\s+hire|suspending\s+concept|sculpture\s+set|reel\s+pricing|what\s+extras)/.test(text);
  }

  private shouldClarifyNewAddon(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const text = userMessage.toLowerCase();
    if (!/\b(add|include|put)\b.*\b(new|another|one more)\b|\b(new|another|one more)\b.*\b(add|extra)\b/.test(text)) return false;
    return history.slice(-8).some((message) => /add-on|addon|extra outfit|styled wig|extra edited photo|extra makeup/i.test(message.content));
  }

  /** "Show me" / "yes" right after we offered or listed the extras. */
  private isAddonListFollowUp(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const text = this.normalizeHyphens(userMessage).trim().toLowerCase().replace(/[.!?]+$/, '');
    const affirmative = /^(show(\s+me)?(\s+the)?(\s+(full\s+)?(list|options|extras|add-?ons))?|see\s+them|list\s+them|list\s+the\s+(extras|add-?ons)|what\s+(are\s+they|else)|yes(\s+please)?|yeah|yep|sure|ok(ay)?|please)$/.test(text);
    if (!affirmative) return false;

    const lastAssistant = [...history].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant) return false;
    return /(available extras|add-?ons?\b|optional additions|extra services|extra outfit|styled wig)/i.test(
      this.normalizeHyphens(lastAssistant.content)
    );
  }

  /** Collapse unicode dashes so regexes written with "-" still match model output. */
  private normalizeHyphens(value: string): string {
    return value.replace(/[\u2010-\u2015\u2212]/g, '-');
  }

  private isDecliningOptionalAddons(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const lastAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    return /^(?:no(?:\s*,?\s*i\s+(?:do(?:n't| not)\s+want|don't need))?.*|none|skip|no thanks|no thank you)\s*[.!]*$/i.test(userMessage.trim())
      && /optional (?:add-ons|extras)|(?:add-ons|extras).*(?:optional|include|like)/i.test(lastAssistantMessage);
  }

  private shouldExposeTools(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    platform: string
  ): boolean {
    if (platform !== 'whatsapp' && platform !== 'web') return false;

    if (this.messageContainsExplicitDateSignal(userMessage) || this.messageContainsExplicitTimeSignal(userMessage)) {
      return true;
    }

    const text = userMessage.toLowerCase();
    if (this.isDecliningOptionalAddons(userMessage, history)) {
      return true;
    }
    const explicitAction = /\b(book|schedule|reschedule|change|move|postpone|cancel|confirm|check\s+(?:availability|available\s+(?:slots|times))|availability|available\s+slots|reserve|hold\s+(?:a\s+)?(?:date|slot)|resend|send\s+(?:the\s+)?(?:payment|m-?pesa)|pay\s+(?:the\s+)?(?:deposit|balance)|add\s+(?:an?\s+)?(?:add-on|extra)|bringing|coming\s+with)\b/.test(text);
    const deliveryPreferenceAction = /\b(?:prefer|save|set|use|send|receive|deliver)\b.{0,35}\b(?:email|whatsapp|download\s+link|delivery)\b/.test(text);
    if (explicitAction || deliveryPreferenceAction) {
      return true;
    }

    const givesExplicitTime = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{2}:\d{2}\b/i.test(text);
    const recentlyAskedForTime = history.slice(-2).some((message) =>
      message.role === 'assistant' && /\b(?:what time|which time|preferred time|time would work)\b/i.test(message.content)
    );
    return givesExplicitTime && recentlyAskedForTime;
  }

  private customerReference(customerId: string): string {
    const digits = customerId.replace(/\D/g, '');
    return digits ? `***${digits.slice(-4)}` : 'unknown';
  }

  /** Exact add-on pricing injected into the system prompt so the model cannot invent it. */
  private getAddonPricingLine(): string {
    const priced = ADDON_CATALOG.filter((item) => item.unitPrice > 0)
      .map((item) => `${item.name}: Ksh ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}`)
      .join('; ');
    const quoted = ADDON_CATALOG.filter((item) => item.unitPrice === 0)
      .map((item) => item.name)
      .join(', ');
    return `${priced}. Quoted by package tier (no fixed price): ${quoted}.`;
  }

  private shouldUsePreviousAddonReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): boolean {
    const text = userMessage.toLowerCase();
    if (/\b(package|edition|bloom|muse|icon|legend|queen|empress|goddess|price|cost)\b/.test(text)) return false;
    const explicitAddonHistoryQuestion = /\b(which|what)\b[\s\S]{0,50}\b(?:add-?ons?|extras?)\b[\s\S]{0,40}\b(?:did i|have i)\b[\s\S]{0,25}\b(?:choose|chose|chosen|pick|picked|select|selected|add|added|include|included)\b/.test(text)
      || /\b(which|what)\b[\s\S]{0,50}\b(?:did i|have i)\s+(?:choose|chose|chosen|pick|picked|select|selected|add|added|include|included)\b[\s\S]{0,40}\b(?:add-?ons?|extras?)\b/.test(text)
      || /\b(?:previously|before|earlier|already)\b[\s\S]{0,40}\b(?:add-?ons?|extras?)\b[\s\S]{0,30}\b(?:choose|chosen|picked|selected|add|added|include|included)\b/.test(text);
    if (explicitAddonHistoryQuestion) return true;

    const anaphoricHistoryQuestion = /\b(which|what)\s+ones?\b[\s\S]{0,40}\b(?:choose|chose|chosen|pick|picked|select|selected|add|added)\b[\s\S]{0,30}\b(?:previously|before|earlier|already)\b/.test(text);
    return anaphoricHistoryQuestion && history.slice(-8).some((message) =>
      /(add-on|addon|extra outfit|styled wig|extra edited photo|extra makeup)/i.test(message.content)
    );
  }

  private async getPreviousAddonReply(customerId: string): Promise<string | null> {
    const bookings = await prisma.booking.findMany({
      where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
      select: { id: true, service: true, dateTime: true, recipientName: true, customer: { select: { name: true } } },
    });

    if (bookings.length === 0) return null;

    const bookingAddons = await prisma.bookingAddon.findMany({
      where: {
        bookingId: { in: bookings.map((booking) => booking.id) },
        status: { in: ['pending', 'confirmed', 'invoiced'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { bookingId: true, name: true, quantity: true, totalPrice: true },
    });

    if (bookingAddons.length === 0) {
      return `I don't see any add-ons selected for your upcoming sessions yet.`;
    }

    const sessionSummaries = bookings
      .map((booking) => {
        const addons = bookingAddons.filter((addon) => addon.bookingId === booking.id);
        if (addons.length === 0) return null;
        const selected = addons
          .map((addon) => `${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}${addon.totalPrice > 0 ? ` (Ksh ${addon.totalPrice.toLocaleString()})` : ''}`)
          .join(', ');
        const bookerName = booking.customer?.name?.trim().toLowerCase() || '';
        const recipientName = booking.recipientName?.trim() || '';
        const recipient = recipientName && recipientName.toLowerCase() !== bookerName
          ? ` for ${recipientName}`
          : '';
        return `${booking.service} on ${inBusinessTimezone(booking.dateTime).format('D MMMM')} ${recipient}: ${selected}`;
      })
      .filter((summary): summary is string => !!summary);

    return `Your previously selected add-ons are: ${sessionSummaries.join('; ')}.`;
  }

  private getSelectedAddon(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): AddonCatalogItem | null {
    const text = userMessage.toLowerCase().replace(/styles?\s+wig/g, 'styled wig');
    const selectionSignal = /\b(want|would like|add|include|choose|go with|take|prefer)\b/.test(text);
    const explicitSelection = selectionSignal
      ? ADDON_CATALOG.find((item) => item.match.test(text))
      : null;
    if (explicitSelection) return explicitSelection;

    const lastAssistant = [...history].reverse().find((message) => message.role === 'assistant');

    // "I want 2 of them" right after explaining a single add-on.
    if (selectionSignal && lastAssistant && /\b(it|them|that|those|this|one|ones)\b/.test(text)) {
      const discussed = ADDON_CATALOG.filter((item) => item.match.test(lastAssistant.content));
      if (discussed.length === 1) return discussed[0];
    }

    const affirmative = /^(?:yes+|yeah+|yep+|yup|sure|okay|ok)(?:\s*,?\s*(?:that's|that is|thats)\s+(?:what\s+i\s+want|what\s+i'd\s+like))?[.! ]*$/i;
    if (!affirmative.test(text.trim())) return null;

    if (!lastAssistant || !/\bif\s+you(?:'|’)d\s+like\b[\s\S]{0,160}\b(?:we|i)\s+can\s+(?:add|include)\b/i.test(lastAssistant.content)) {
      return null;
    }

    const offeredAddons = ADDON_CATALOG.filter((item) => item.match.test(lastAssistant.content));
    return offeredAddons.length === 1 ? offeredAddons[0] : null;
  }

  private getRequestedAddonQuantity(userMessage: string, addon: AddonCatalogItem): number {
    if (!addon.quantityFromNote) return 1;
    const text = userMessage.toLowerCase();
    const digits = text.match(/\b(\d{1,2})\b/);
    if (digits) {
      const qty = Number(digits[1]);
      if (qty > 0 && qty <= 20) return qty;
    }
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, both: 2, couple: 2 };
    const word = Object.keys(words).find((w) => new RegExp(`\\b${w}\\b`).test(text));
    return word ? words[word] : 1;
  }

  private getAddonSelectionReply(addon: AddonCatalogItem, quantity = 1): string {
    const price = addon.unitPrice > 0
      ? quantity > 1
        ? `${quantity} x Ksh ${addon.unitPrice.toLocaleString()} = Ksh ${(addon.unitPrice * quantity).toLocaleString()}`
        : `Ksh ${addon.unitPrice.toLocaleString()}${addon.quantityFromNote ? ' each' : ''}`
      : 'quoted by package tier';
    const label = quantity > 1 ? `${quantity} x ${addon.name}` : addon.name;
    return `Noted: ${label} (${price}). It will be added to the session balance, not the deposit. I have not changed your package or date. What would you like to confirm next?`;
  }

  private shouldUseBespokeReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(bespoke|custom\s+experience|custom\s+shoot|custom\s+package|tailored\s+session|tailored\s+experience|vision\s+does\s+not\s+fit)/.test(text);
  }

  private shouldUseTravellingMothersReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(travelling\s+mother|traveling\s+mother|from\s+outside\s+nairobi|from\s+abroad|airport\s+transfer|hotel\s+booking|concierge|soft\s+landing|journeying\s+to\s+us)/.test(text);
  }

  private shouldUseSocialMediaReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(social\s+media|instagram|facebook|website|where\s+can\s+i\s+find\s+you\s+online)/.test(text);
  }

  private shouldHandleResendRequest(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(resend|send\s+again|retry|repeat|send\s+it\s+again)/.test(text);
  }

  private shouldUseMultiPersonBookingReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    const mentionsAnotherPerson = /(my\s+sister|my\s+brother|my\s+friend|my\s+husband|my\s+wife|my\s+partner|my\s+family|also\s+coming|come\s+with\s+her|come\s+with\s+him|joining\s+the\s+shoot|join\s+the\s+shoot)/.test(text);
    const bookingContext = /(\bbook(?:s|ed|ing)?\b|photoshoot|shoot|session|appointment|ready\s+to\s+book)/.test(text);
    const jointSessionSignal = /(\bwith\b|alongside|together|\bjoin(?:s|ed|ing)?\b|coming\s+with\b|both\s+of\s+us|each\s+of\s+us)/.test(text);
    return mentionsAnotherPerson && bookingContext && jointSessionSignal;
  }

  private getStudioPolicyReply(userMessage: string): string | null {
    const text = userMessage.toLowerCase();

    if (/\b(nude|semi[-\s]?nude)\b/.test(text) && /\b(session|shoot|maternity|portrait|photo)\b/.test(text)) {
      return 'Yes, nude and semi-nude maternity portraits are available. We handle them with professionalism and privacy so you can feel comfortable throughout the session.';
    }

    if (/\b(couple|partner|husband|wife|children|kids|family)\b/.test(text) && /\b(session|shoot|join|include|come|attend)\b/.test(text)) {
      return 'Your partner and children are welcome to join your maternity session. We will guide poses that include everyone beautifully.';
    }

    if (/(late\s+night|late-night|evening)/.test(text) && /\b(sessions?|shoot|booking|open|slot)\b/.test(text)) {
      return 'Our studio hours are 9 AM to 7 PM, and we are closed on Mondays, so we do not offer late-night sessions.';
    }

    return null;
  }

  private getOutOfScopeReply(userMessage: string): string | null {
    const text = userMessage.toLowerCase();
    const medicalOrExplicitQuestion = /\b(fertile|fertility|ovulat(?:e|ion|ing)|fertili[sz](?:e|ation)|conceiv(?:e|ing)|conception|sperm|semen|viable\s+egg|egg\s+viab|miscarriage|medication|diagnos(?:is|e)|treatment|contraception|pregnancy\s+(?:complication|symptom)|reproductive\s+health|sexual\s+health|have\s+(?:unprotected\s+)?sex|fuck|sex\s+to\s+(?:get\s+)?pregnant|good\s+seeds|are\s+you\s+into\s+sex|horny)\b/.test(text);
    const professionalAdviceRequest = /\b(?:legal|financial|investment|tax)\s+advice\b|\bshould\s+i\s+(?:invest|take\s+out\s+a\s+loan)\b|\b(?:lawsuit|lawyer|attorney)\b/.test(text);
    const explicitSexualRequest = /\b(talk\s+dirty|dirty\s+talk|sexual\s+roleplay)\b/.test(text);

    if (explicitSexualRequest) return 'I’ll keep things professional here, but I can definitely help you plan your Fiesta House shoot.';
    if (!medicalOrExplicitQuestion && !professionalAdviceRequest) return null;

    return 'That’s outside my studio brief; a qualified professional is the right person to ask. I’m here if you need help with a shoot or booking.';
  }

  private isClearlyUnrelatedRequest(userMessage: string): boolean {
    const text = userMessage.toLowerCase().trim();
    return /\b(tell\s+(?:me\s+)?a\s+joke|capital\s+of|president\s+of|meaning\s+of\s+life|politics?|election|weather|sports?|football|recipe|cook(?:ing)?|program(?:ming)?|code|crypto|bitcoin|stock\s+market|girlfriend|boyfriend|dating|relationship\s+advice)\b/.test(text);
  }

  private getScopeBoundaryReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string | null {
    const studioPolicyReply = this.getStudioPolicyReply(userMessage);
    if (studioPolicyReply) return studioPolicyReply;

    const outOfScopeReply = this.getOutOfScopeReply(userMessage);
    if (outOfScopeReply) return outOfScopeReply;

    if (!this.isClearlyUnrelatedRequest(userMessage)) return null;

    return 'I’m your Fiesta House studio assistant, so I stick to shoots and bookings. If you need help with a session, I’m happy to help.';
  }

  private shouldClarifyBookingForSomeoneElse(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    const bookingContext = /(\bbook(?:s|ed|ing)?\b|photoshoot|shoot|session|appointment|ready\s+to\s+book)/.test(text);
    const bookingForSomeoneElse = /\b(for|on behalf of)\s+my\s+(sister|brother|friend|husband|wife|partner|mother|father|daughter|son|family)\b/.test(text);
    return bookingContext && bookingForSomeoneElse && !this.shouldUseMultiPersonBookingReply(userMessage);
  }

  private extractStandaloneFullName(userMessage: string): string | null {
    const candidate = userMessage.trim().replace(/[^a-zA-Z' -]/g, '').replace(/\s+/g, ' ');
    if (!/^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}$/.test(candidate)) return null;
    return candidate.split(' ').map((part) => `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`).join(' ');
  }

  private shouldCaptureRecipientName(
    userMessage: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): boolean {
    const name = this.extractStandaloneFullName(userMessage);
    if (!name) return false;
    const recentHistory = history.slice(-8);
    const askedAboutBookingSubject = recentHistory
      .filter((message) => message.role === 'assistant')
      .some((message) => /session just for (?:your|her|his)|both (?:of )?you.*photographed together|booking.*for.*sister|booking.*for.*brother/i.test(message.content));
    const bookingForSomeoneElse = recentHistory
      .filter((message) => message.role === 'user')
      .some((message) => this.shouldClarifyBookingForSomeoneElse(message.content));
    return askedAboutBookingSubject || bookingForSomeoneElse;
  }

  private shouldClarifyAmbiguousDeposit(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /\b(10|10000|10k)\s*(sh|k|ksh|kes)?\b.*\bdeposit\b|\bdeposit\b.*\b(10|10000|10k)\s*(sh|k|ksh|kes)?\b/.test(text);
  }

  private async getAmbiguousDepositReply(): Promise<string> {
    try {
      const deposit = this.getDepositForPackage(await this.getPackageForDeposit('THE BLOOM'));
      return `Do you mean a Ksh 10,000 deposit, or an add-on or item costing Ksh 10,000? THE BLOOM's deposit is Ksh ${deposit.toLocaleString()}, so I want to make sure I understand before recommending anything.`;
    } catch {
      console.warn('Unable to resolve Bloom deposit for clarification.');
      return 'Do you mean a Ksh 10,000 deposit, or an add-on or item costing Ksh 10,000? The studio team can confirm the current package deposit before recommending anything.';
    }
  }

  private async captureRecipientName(customerId: string, userMessage: string): Promise<string | null> {
    const recipientName = this.extractStandaloneFullName(userMessage);
    if (!recipientName) return null;

    await prisma.bookingDraft.upsert({
      where: { customerId },
      update: { name: recipientName, recipientName, isForSomeoneElse: true, step: 'service' },
      create: { customerId, name: recipientName, recipientName, isForSomeoneElse: true, step: 'service' },
    });
    return recipientName;
  }

  private shouldUseBookingStatusReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(have you done it|did you do it|is it done|is it confirmed|did it go through|have you confirmed|did you confirm|is my booking confirmed|is my session confirmed|have i paid|did i pay|is it paid|is my payment (received|confirmed|done|through)|has (my|the) payment been received|did (my|the) payment go through|did you receive (my|the) payment|did you get (my|the) (money|payment)|have you received (my|the) (money|payment))/i.test(text);
  }

  private shouldUseUpcomingAppointmentTimeReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /\b(when does|what time does|when is|what time is|what time will)\b.*\b(start|begin|session|appointment|booking)\b|\b(start|begin)\b.*\b(when|what time)\b/.test(text);
  }

  private shouldUseUpcomingAppointmentDetailsReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    if (this.shouldUseBookingProcessReply(userMessage)) return false;
    if (this.shouldUsePostShootProcessReply(userMessage)) return false;
    if (this.shouldUseUpcomingAppointmentTimeReply(userMessage)) return false;
    if (this.shouldUseLastAppointmentDetailsReply(userMessage)) return false;
    if (/\b(show|tell|remind|list)\b.*\b(in|on|for|about|included in|part of)?\s*(my|the|this)\s+(session|shoot|appointment|booking)\b/.test(text)) return true;
    if (/\bwhat(?:'s| is| are)?\b.*\b(included|in|on|booked for)\b.*\b(my|the|this)\s+(session|shoot|appointment|booking)\b/.test(text)) return true;
    return /\b(any|what|more|tell me about)\b.*\b(details?|information|shoot|session|appointment|booking)\b|\b(details?|information)\b.*\b(session|shoot|appointment|booking)\b/.test(text);
  }

  private shouldUseLastAppointmentDetailsReply(userMessage: string): boolean {
    return /\b(last|previous|most recent)\s+(session|shoot|appointment|booking)\b/i.test(userMessage);
  }

  private formatBookingDuration(durationMinutes?: number | null): string {
    const minutes = durationMinutes || DEFAULT_DURATION;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours === 0) return `${remainder} minutes`;
    if (remainder === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${hours} hour${hours === 1 ? '' : 's'} ${remainder} minutes`;
  }

  private wasUpcomingAppointmentDetailsJustProvided(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const previousUserMessage = [...history].reverse().find((message) => message.role === 'user')?.content;
    const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    return Boolean(
      previousUserMessage
      && this.shouldUseUpcomingAppointmentDetailsReply(previousUserMessage)
      && /\b(session|booking|appointment)\b/i.test(previousAssistantMessage)
    );
  }

  private async getUpcomingAppointmentDetailsReply(
    customerId: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): Promise<string | null> {
    const booking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
      include: {
        customer: { select: { name: true } },
        bookingAddons: {
          where: { status: { in: ['pending', 'confirmed', 'invoiced'] } },
          orderBy: { createdAt: 'asc' },
          select: { name: true, quantity: true },
        },
      },
    });

    if (!booking) return null;

    const payment = await prisma.payment.findFirst({
      where: { bookingId: booking.id, status: 'success' },
      orderBy: { updatedAt: 'desc' },
      select: { amount: true },
    });
    const localDateTime = inBusinessTimezone(booking.dateTime);
    const bookerName = booking.customer?.name?.trim() || '';
    const recipientName = booking.recipientName?.trim() || '';
    const isSelfBooking = !recipientName || recipientName.toLowerCase() === bookerName.toLowerCase();
    const date = localDateTime.format('dddd, D MMMM YYYY');
    const time = localDateTime.format('h:mm A');
    const recipient = isSelfBooking ? '' : ` for ${recipientName}`;
    const extras = booking.bookingAddons.map((addon) => `${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}`);
    const extrasText = extras.length > 0 ? ` Your saved extras are ${extras.join(' and ')}.` : '';
    const confirmation = payment ? ' It is confirmed, and your deposit has been paid.' : ' Your booking is confirmed.';
    const duration = this.formatBookingDuration(booking.durationMinutes);

    if (this.wasUpcomingAppointmentDetailsJustProvided(history)) {
      return `It’s the same session we just discussed: ${booking.service} on ${date} at ${time}${recipient}. It runs for ${duration} at our Parklands studio.${extrasText}${confirmation}`;
    }

    return `Your ${booking.service} session is on ${date} at ${time}${recipient}. It runs for ${duration} at our Parklands studio.${extrasText}${confirmation}`;
  }

  private async getLastAppointmentDetailsReply(customerId: string): Promise<string> {
    const booking = await prisma.booking.findFirst({
      where: {
        customerId,
        status: { not: 'cancelled' },
        dateTime: { lt: new Date() },
      },
      orderBy: { dateTime: 'desc' },
      select: {
        service: true,
        dateTime: true,
        durationMinutes: true,
        recipientName: true,
        bookingAddons: {
          where: { status: { in: ['pending', 'confirmed', 'invoiced'] } },
          orderBy: { createdAt: 'asc' },
          select: { name: true, quantity: true },
        },
      },
    });

    if (!booking) return "I don't see a past booking on record yet. Are you asking about your upcoming session?";

    const localDateTime = inBusinessTimezone(booking.dateTime);
    const details = [
      `Date: ${localDateTime.format('dddd, D MMMM YYYY')} at ${localDateTime.format('h:mm A')}`,
      ...(booking.durationMinutes ? [`Duration: ${this.formatBookingDuration(booking.durationMinutes)}`] : []),
      ...(booking.recipientName ? [`Booked for: ${booking.recipientName}`] : []),
    ];

    if (booking.bookingAddons.length > 0) {
      details.push('Add-ons recorded:');
      details.push(...booking.bookingAddons.map((addon) => `- ${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}`));
    }

    return `The most recent past booking I have on record is ${booking.service}.\n${details.join('\n')}\n\nDoes that sound like the session you mean?`;
  }

  private async getUpcomingAppointmentTimeReply(customerId: string): Promise<string | null> {
    const upcomingBooking = await prisma.booking.findFirst({
      where: {
        customerId,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
      orderBy: { dateTime: 'asc' },
      select: { service: true, dateTime: true },
    });

    if (!upcomingBooking) return null;

    return `Your ${upcomingBooking.service} session starts on ${inBusinessTimezone(upcomingBooking.dateTime).format('dddd, MMMM D, YYYY')} at ${inBusinessTimezone(upcomingBooking.dateTime).format('h:mm A')}. Please arrive about 30 minutes early.`;
  }

    private shouldUsePastAppointmentReply(userMessage: string): boolean {
      const text = userMessage.toLowerCase();
      return /(that|the|my)\s+(date|day|appointment|booking|session).*(already\s+)?(passed|past)|already\s+passed|that\s+was\s+in\s+the\s+past/.test(text);
    }

      private isPastAppointmentFollowUp(
        userMessage: string,
        history: { role: 'user' | 'assistant', content: string }[]
      ): boolean {
        const text = userMessage.toLowerCase().trim();
        const isFollowUp = /^(say|tell|repeat)\s+(that|it|again)\b|^(so\s+)?(how|what)\b|what\s+(do|should)\s+i\s+do|which\s+(one|option)|(?:do|choose|pick|i(?:'ll| will) take)\s+(?:number\s+)?[12]\b/.test(text);
        const recentAssistantMessages = history
          .filter((message) => message.role === 'assistant')
          .slice(-3)
          .map((message) => message.content.toLowerCase());
        const invalidPastAppointmentMenu = recentAssistantMessages.some((message) => {
          const describesPastAppointment = /(date|day|appointment|booking|session).*(already\s+)?(passed|past)|already\s+passed/.test(message);
          return describesPastAppointment && /reschedule/.test(message) && /cancel/.test(message);
        });

        return isFollowUp && invalidPastAppointmentMenu;
      }

  private buildPackageCard(pkg: {
    name: string;
    price: number;
    duration: string;
    images: number;
    makeup: boolean;
    outfits: number;
    photobook: boolean;
    photobookSize: string | null;
    mount: boolean;
    balloonBackdrop: boolean;
    wig: boolean;
    notes: string | null;
  }): string {
    const lowerName = pkg.name.toLowerCase();

    let badge = '';
    if (lowerName.includes('empress')) {
      badge = ' (Signature Edition - Most Loved)';
    } else if (lowerName.includes('goddess')) {
      badge = ' (Flagship Edition)';
    }

    const items: string[] = [];
    if (pkg.duration) items.push(`Session length: ${pkg.duration}`);
    if (pkg.images > 0) items.push(`${pkg.images} final edited photos`);
    if (pkg.makeup) items.push('Professional makeup');

    if (pkg.outfits > 0) {
      if (lowerName.includes('empress') || lowerName.includes('goddess')) {
        items.push(`${pkg.outfits} studio outfits with styling, including the Power Suit`);
      } else {
        items.push(`${pkg.outfits} studio outfit${pkg.outfits > 1 ? 's' : ''} with styling`);
      }
    }

    if (pkg.wig) {
      if (lowerName.includes('empress') || lowerName.includes('goddess')) {
        items.push('2 styled wigs');
      } else {
        items.push('1 styled wig');
      }
    }

    if (pkg.balloonBackdrop) {
      if (lowerName.includes('goddess')) {
        items.push('Custom balloon backdrop or Goddess Sculpture Set');
      } else {
        items.push('Custom balloon backdrop with flowers');
      }
    }

    if (lowerName.includes('goddess')) {
      items.push('1 professionally produced Reel');
    }

    if (pkg.photobook) {
      const size = pkg.photobookSize ? ` (${pkg.photobookSize})` : '';
      items.push(`Hardcover photobook${size}`);
    }

    if (pkg.mount) {
      if (lowerName.includes('goddess')) {
        items.push('1 A2 fine art mount');
      } else {
        items.push('1 A3 fine art mount');
      }
    }

    return `${pkg.name} - Ksh ${pkg.price.toLocaleString()}${badge}\n${items.map((item) => `- ${item}`).join('\n')}`;
  }

  private async getPackageCatalogReply(showInclusions = false): Promise<string | null> {
    try {
      const packages = await prisma.package.findMany({
        orderBy: [{ price: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          price: true,
          duration: true,
          images: true,
          makeup: true,
          outfits: true,
          photobook: true,
          photobookSize: true,
          mount: true,
          balloonBackdrop: true,
          wig: true,
          notes: true,
        }
      });

      if (!packages.length) return null;

      const cards = packages.map((pkg) => this.buildPackageCard(pkg));
      const introduction = showInclusions ? 'Here is what each package includes:' : 'Here are our maternity packages:';
      const closing = showInclusions
        ? 'If one stands out, I can help you choose a date for it.'
        : 'Tell me which package you are considering, and I can explain its inclusions or help check available dates.';
      return `Fiesta House Maternity - Rate Card 2026\n\n${introduction}\n\n${cards.join('\n\n')}\n\n${closing}`;
    } catch (err) {
      console.error('Failed to build package catalog reply:', err);
      return null;
    }
  }

  private async getPackageAdviceReply(userMessage: string): Promise<string | null> {
    const packages = await prisma.package.findMany({
      orderBy: [{ price: 'asc' }, { name: 'asc' }],
      select: {
        name: true,
        price: true,
        duration: true,
        images: true,
        makeup: true,
        outfits: true,
        photobook: true,
        photobookSize: true,
        mount: true,
        balloonBackdrop: true,
        wig: true,
        notes: true,
      },
    });

    const text = userMessage.toLowerCase();
    const mentionedPackages = packages.filter((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
    if (mentionedPackages.length >= 2) {
      const [first, second] = mentionedPackages;
      const differences: string[] = [];
      if (first.price !== second.price) differences.push(`${first.name} is Ksh ${first.price.toLocaleString()}, while ${second.name} is Ksh ${second.price.toLocaleString()}`);
      if (first.images !== second.images) differences.push(`${first.name} includes ${first.images} edited images and ${second.name} includes ${second.images}`);
      if (first.duration !== second.duration) differences.push(`${first.name} is ${first.duration}, while ${second.name} is ${second.duration}`);
      if (first.photobook !== second.photobook) differences.push(second.photobook ? `${second.name} includes an ${second.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook') : `${first.name} includes an ${first.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook'));
      if (first.mount !== second.mount) differences.push(first.mount ? `${first.name} includes an A3 mount` : `${second.name} includes an A3 mount`);

      const higherValuePackage = first.price >= second.price ? first : second;
      const lowerCostPackage = higherValuePackage === first ? second : first;
      return `${differences.join('. ')}. ${higherValuePackage.name} makes sense if its extra inclusions matter to you; ${lowerCostPackage.name} is the lower-cost option. Will your older child be joining you in the shoot?`;
    }

    const higherValue = packages.find((pkg) => ['the empress', 'the goddess', 'the queen', 'the legend'].includes(pkg.name.toLowerCase())) || packages[packages.length - 1];
    const lowerCost = packages.find((pkg) => ['the icon', 'the muse', 'the bloom'].includes(pkg.name.toLowerCase())) || packages[0];
    if (!higherValue || !lowerCost) return null;

    const higherPhotobookInfo = higherValue.photobook ? ` and a photobook` : '';
    return `Congratulations on your pregnancy! I would lean toward ${higherValue.name} if you would enjoy more variety: it includes ${higherValue.images} edited images${higherPhotobookInfo} for Ksh ${higherValue.price.toLocaleString()}. ${lowerCost.name} is Ksh ${lowerCost.price.toLocaleString()} and includes ${lowerCost.images} edited images, so it is a lovely option as well. Will your partner or family be joining you in the shoot?`;
  }

  private async getPackageSelectionReply(customerId: string, userMessage: string): Promise<string | null> {
    const text = userMessage.toLowerCase();
    const packages = await prisma.package.findMany({ select: { name: true, deposit: true } });
    const selectedPackage = packages.find((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
    if (!selectedPackage) return null;

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (draft?.step === 'awaiting_confirmation' && draft.date && draft.time && draft.dateTimeIso) {
      const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => selectedPackage.name.toLowerCase().includes(key));
      const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
      const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);

      if (!Array.isArray(slotsResult)) {
        return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
      }

      if (!slotsResult.includes(draft.time)) {
        const alternatives = slotsResult.slice(0, 3).join(', ');
        return `${selectedPackage.name} needs a different amount of time, and ${draft.time} is not free on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
      }

      let deposit: number;
      try {
        deposit = this.getDepositForPackage(selectedPackage);
      } catch {
        console.warn('Unable to resolve package-selection deposit.');
        return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The studio team will confirm the deposit before any payment prompt is sent.`;
      }
      await prisma.bookingDraft.update({
        where: { customerId },
        data: { service: selectedPackage.name, step: 'awaiting_confirmation' },
      });

      return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
    }

    return `${selectedPackage.name} is a lovely choice. What date are you considering? Once you have a day in mind, I can check the available times for you.`;
  }

  private async getSameBookingSlotReply(
    customerId: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (draft?.step !== 'awaiting_confirmation' || !draft.date || !draft.time || !draft.dateTimeIso || !draft.service) {
      return null;
    }

    const packages = await prisma.package.findMany({ select: { name: true } });
    const selectedPackage = history
      .filter((message) => message.role === 'user')
      .reverse()
      .map((message) => packages.find((pkg) => message.content.toLowerCase().includes(pkg.name.replace(/ package$/i, '').toLowerCase())))
      .find((pkg): pkg is { name: string } => Boolean(pkg));
    const packageToUse = selectedPackage || packages.find((pkg) => pkg.name === draft.service);
    if (!packageToUse) return null;

    let deposit: number;
    try {
      deposit = this.getDepositForPackage(await this.getPackageForDeposit(packageToUse.name));
    } catch {
      console.warn('Unable to resolve same-slot package deposit.');
      return 'I have the session details, but the studio team will confirm the deposit before I send a payment proposal.';
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => packageToUse.name.toLowerCase().includes(key));
    const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
    const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);
    if (!Array.isArray(slotsResult)) {
      return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
    }
    if (!slotsResult.includes(draft.time)) {
      const alternatives = slotsResult.slice(0, 3).join(', ');
      return `${packageToUse.name} is not available at ${draft.time} on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
    }

    await prisma.bookingDraft.update({
      where: { customerId },
      data: { service: packageToUse.name, step: 'awaiting_confirmation' },
    });

    return `${packageToUse.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
  }

  private async getRescheduleTimeReply(customerId: string): Promise<string | null> {
    const booking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
      select: { service: true, dateTime: true },
    });
    if (!booking) return null;

    if (this.isRescheduleWithin72Hours(booking.dateTime)) {
      return this.getReschedulePolicyMessage();
    }

    return `Of course. Your ${booking.service} session is currently on ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')} at ${inBusinessTimezone(booking.dateTime).format('h:mm A')}. What time would work better for you that day?`;
  }

  private async getRescheduleTimeProposalReply(customerId: string, userMessage: string): Promise<string | null> {
    const newTime = this.conversationFlows.parseTimeOnly(userMessage);
    if (!newTime) return null;

    const booking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
      select: { id: true, service: true, dateTime: true },
    });
    if (!booking) return null;

    if (this.isRescheduleWithin72Hours(booking.dateTime)) {
      return this.getReschedulePolicyMessage();
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => booking.service.toLowerCase().includes(key));
    const bookingDay = inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD');
    const slotsResult = await bookingService.getAvailableSlots(
      bookingDay,
      serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION,
      booking.id
    );
    const availableSlots = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(newTime)) {
      const alternatives = availableSlots.slice(0, 3).map((time) => dayjs(`2000-01-01T${time}`).format('h:mm A')).join(', ');
      return `${dayjs(`2000-01-01T${newTime}`).format('h:mm A')} is not free on ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would work for you?`;
    }

    const result = await this.executeProposeRescheduleTool(customerId, bookingDay, newTime);
    await this.notifyRescheduleAdmin({
      customerId,
      event: 'proposed',
      service: result.service,
      oldDateTime: result.oldDateTime,
      newDate: bookingDay,
      newTime,
    });

    return `I can move your ${result.service} session to ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')} at ${dayjs(`2000-01-01T${newTime}`).format('h:mm A')}. Would you like me to confirm that change?`;
  }

  private isRescheduleWithin72Hours(bookingDateTime: Date, now = new Date()): boolean {
    return getBookingPolicyWindow(bookingDateTime, now).rescheduleForfeitsDeposit;
  }

  private getReschedulePolicyMessage(): string {
    return 'Your session is within 72 hours. According to our policy, rescheduling now will forfeit your deposit. Would you still like to proceed? If yes, please share your preferred date and time.';
  }

  private async getBookingProcessReply(): Promise<string> {
    let startingDeposit: number | null = null;
    let location = '4th Avenue Parklands, Diamond Plaza Annex, 2nd Floor, Nairobi';

    try {
      startingDeposit = this.getDepositForPackage(await this.getPackageForDeposit());
    } catch {
      console.warn('Unable to resolve starting deposit for booking process reply.');
    }
    try {
      const studioInfo = await prisma.studioInfo.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { location: true },
      });
      if (studioInfo?.location?.trim()) location = studioInfo.location.trim();
    } catch (error) {
      console.error('Failed to resolve booking process location:', error);
    }

    return [
      'Great question. Booking is simple:',
      '1) Choose your package.',
      '2) Share your preferred date and time (we are closed on Mondays).',
      '3) Choose any optional add-ons if you wish (extra outfit, wig hire, extra photos, etc. — completely optional!).',
      startingDeposit === null
        ? '4) We confirm availability, and the studio team will confirm the deposit amount before any M-Pesa prompt is sent.'
        : `4) We confirm availability and send an M-Pesa deposit prompt (starting from Ksh ${startingDeposit.toLocaleString()}).`,
      '5) Once deposit is received, your booking is confirmed and reminders are scheduled.',
      `6) Come for your session at ${location}.`,
      '7) Pay the remaining balance after the shoot (M-Pesa or cash).',
      '',
      "If you're ready, tell me your package and preferred date/time and I'll check slots now."
    ].join('\n');
  }

  private getPostShootProcessReply(): string {
    return [
      'After the shoot:',
      '1) Any remaining balance is cleared as per your package terms (M-Pesa or cash).',
      '2) Edited photos are ready within 10 working days.',
      '3) Edited photos are delivered as a secure download link only.',
      '4) We can share that link via WhatsApp or email, based on your preference.',
      '5) Express delivery is available at an extra fee if you need them sooner.',
      '6) Raw files are available at an extra fee if requested.',
      '',
      "Tell me your preferred delivery method and I'll save it now."
    ].join('\n');
  }

  private addWorkingDays(from: dayjs.Dayjs, days: number): dayjs.Dayjs {
    let cursor = from;
    let remaining = days;

    while (remaining > 0) {
      cursor = cursor.add(1, 'day');
      const day = cursor.day(); // 0=Sun, 6=Sat
      if (day !== 0 && day !== 6) {
        remaining -= 1;
      }
    }

    return cursor;
  }

  private async getEarliestImageDeliveryReply(customerId: string): Promise<string> {
    const upcomingConfirmed = await prisma.booking.findFirst({
      where: {
        customerId,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
      orderBy: { dateTime: 'asc' },
      select: { dateTime: true },
    });

    if (!upcomingConfirmed) {
      return [
        'Edited photos are ready 10 working days after the shoot.',
        'If you share your booked date, I can give you the exact earliest delivery date.',
        'Express delivery is available at an extra fee if you need them sooner.'
      ].join('\n');
    }

    const shootDate = inBusinessTimezone(upcomingConfirmed.dateTime);
    const earliest = this.addWorkingDays(shootDate, 10);

    return [
      'Edited photos are ready 10 working days after the shoot.',
      `Since your session is on ${shootDate.format('dddd, MMMM D, YYYY')}, the earliest delivery date is ${earliest.format('dddd, MMMM D, YYYY')}.`,
      'If you need them sooner, we offer express delivery at an extra fee.'
    ].join('\n');
  }

  private getRawFilesReply(): string {
    return [
      'Raw files are quoted by package tier.',
      'They are shared as a secure download link.',
      'If you let me know which package tier you are interested in, our team can confirm the exact quote for raw files.'
    ].join('\n');
  }

  private async getAdditionsReply(): Promise<string> {
    let deposit: number | null = null;
    try {
      deposit = this.getDepositForPackage(await this.getPackageForDeposit());
    } catch {
      console.warn('Unable to resolve starting deposit for add-ons reply.');
    }

    const pricedLines = ADDON_CATALOG
      .filter((item) => item.unitPrice > 0)
      .map((item) => `${item.name}: Ksh ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}`);
    const quotedLines = ADDON_CATALOG
      .filter((item) => item.unitPrice === 0)
      .map((item) => `${item.name}: quoted by package tier`);

    return [
      'Yes, these optional additions are available:',
      '',
      ...pricedLines,
      '',
      'Quoted by package tier:',
      ...quotedLines,
      '',
      deposit === null
        ? 'They are optional and are added to the balance, not the deposit. The studio team can confirm the deposit amount. Nothing has been added yet.'
        : `They are optional, are added to the balance, and are not included in the Ksh ${deposit.toLocaleString()} deposit. Nothing has been added yet.`,
      '',
      'Which, if any, would you like me to note for the session?'
    ].join('\n');
  }

  private getBespokeReply(): string {
    return [
      'Bespoke Experiences',
      '',
      'For the mother whose vision does not fit inside a package, we design custom experiences by consultation.',
      '',
      'Reach out to our team to begin the conversation, and we will craft a session around your unique story.'
    ].join('\n');
  }

  private getTravellingMothersReply(): string {
    return [
      'For Our Travelling Mothers',
      '',
      'For mothers journeying to us from beyond Nairobi, we curate the full arrival.',
      '',
      'Airport transfers, hotel bookings, and a soft landing arranged by our concierge, so all you carry with you is your presence.',
      '',
      'Available on request! Let us know your travel dates and we will be delighted to coordinate for you.'
    ].join('\n');
  }

  private getSocialMediaReply(): string {
    return [
      'Instagram: @fiestahousematernity',
      'https://www.instagram.com/fiestahousematernity',
      '',
      'Facebook: Fiesta House Attire',
      'https://www.facebook.com/fiestahouseattire/',
      '',
      'Website: https://www.fiestahousematernity.com/',
      '',
      'We only share client photos with consent.'
    ].join('\n');
  }

  private getPortfolioReply(): string {
    return 'You can see our maternity, newborn and family sessions in the portfolio here: https://www.fiestahousematernity.com/. Have a look and tell me which style feels most like you.';
  }

  private getSuspendingConceptGalleryReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): string | null {
    if (/\b(packages?|editions?|price list|pricing)\b/i.test(userMessage)) return null;

    const asksToSeeExample = /\b(where\s+(?:can|could|do)\s+i\s+(?:see|view)|can\s+i\s+see|see\s+this\s+(?:idea|concept))\b/i.test(userMessage)
      || /\bshow\s+me\b.{0,24}\b(gallery|photos?|pictures?|images?|examples?|concept)\b/i.test(userMessage);
    if (!asksToSeeExample) return null;

    const mentionsConcept = /suspending\s+concept/i.test(userMessage)
      || history.slice(-6).some((message) => /suspending\s+concept/i.test(message.content));
    if (!mentionsConcept) return null;

    return 'You can see the Suspending Concept gallery here: https://www.fiestahousematernity.com/gallery/suspending-concept';
  }

  private getReviewPageReply(userMessage: string): string | null {
    const asksAboutReviews = /\b(reviews?|testimonials?|client feedback)\b/i.test(userMessage);
    const asksForPage = /\b(page|website|where|see|read|view|link)\b/i.test(userMessage);
    if (!asksAboutReviews || !asksForPage) return null;

    return 'You can read Fiesta House Maternity client reviews here: https://www.fiestahousematernity.com/reviews';
  }

  private getWebsiteReply(): string {
    return 'You can find us here: https://www.fiestahousematernity.com/. It has our portfolio, current packages and more about the studio.';
  }

  private getContactDetailsReply(): string {
    return 'We are at Diamond Plaza Annex, 2nd Floor, on 4th Avenue in Parklands, Nairobi. You can reach us on 0720 111928 or at info@fiestahouseattire.com. Our website is https://www.fiestahousematernity.com/.';
  }

  private getMultiPersonBookingReply(): string {
    return [
      'Great question, and yes, we can plan that.',
      'Do you want:',
      '1) one joint session together, or',
      '2) separate bookings for each of you?',
      '',
      "I've noted that another person may join.",
      "Once you confirm option 1 or 2, share your package, date, and preferred time and I'll check availability."
    ].join('\n');
  }

  private getBookingForSomeoneElseReply(): string {
    return 'Of course. Is the session just for your sister, or would you both like to be photographed together? Once I know that, I can help with the package, date, and preferred time.';
  }

  private async captureMultiPersonBookingNote(customerId: string, userMessage: string): Promise<void> {
    const lower = userMessage.toLowerCase();
    const relation =
      lower.includes('sister') ? 'sister' :
      lower.includes('brother') ? 'brother' :
      lower.includes('friend') ? 'friend' :
      lower.includes('husband') ? 'husband' :
      lower.includes('wife') ? 'wife' :
      lower.includes('partner') ? 'partner' :
      lower.includes('family') ? 'family member' :
      'another person';

    await this.executeAddNoteTool(
      customerId,
      '',
      `Customer mentioned ${relation} may join the shoot; confirm if this is a joint session or separate bookings before finalizing package/price.`,
      'special_request'
    );
  }

  private async getBookingStatusReply(customerId: string): Promise<string | null> {
    // If the customer already has an upcoming confirmed booking, that takes highest precedence
    const upcomingConfirmed = await prisma.booking.findFirst({
      where: {
        customerId,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
      orderBy: { dateTime: 'asc' },
      select: { id: true, service: true, dateTime: true },
    });

    if (upcomingConfirmed) {
      const successfulPayment = await prisma.payment.findFirst({
        where: { bookingId: upcomingConfirmed.id, status: 'success' },
        orderBy: { updatedAt: 'desc' },
      });
      const receiptNote = successfulPayment?.mpesaReceipt ? ` (M-Pesa receipt: ${successfulPayment.mpesaReceipt})` : '';
      const sessionDetails = `Your ${upcomingConfirmed.service} session is confirmed for ${inBusinessTimezone(upcomingConfirmed.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}.`;
      return successfulPayment
        ? `Your payment is received and confirmed${receiptNote}. ${sessionDetails}`
        : `${sessionDetails} I can't verify a successful payment from the records I can see; the studio team can confirm the payment status.`;
    }

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });

    if (draft?.step === 'reschedule_confirm') {
      return customerReplyTemplates.rescheduleAwaitingConfirmation();
    }

    if (draft?.step === 'awaiting_confirmation') {
      return customerReplyTemplates.bookingAwaitingConfirmation();
    }

    if (draft?.step === 'payment_pending') {
      const pendingPayment = await prisma.payment.findFirst({
        where: { bookingDraftId: draft.id, status: 'pending' },
        orderBy: { updatedAt: 'desc' },
      });

      if (pendingPayment) {
        return customerReplyTemplates.paymentPending();
      }
    }

    return null;
  }

  private async getPastAppointmentReply(customerId: string): Promise<string | null> {
    const pastBooking = await prisma.booking.findFirst({
      where: {
        customerId,
        status: { not: 'cancelled' },
        dateTime: { lt: new Date() },
      },
      orderBy: { dateTime: 'desc' },
      select: { service: true, dateTime: true },
    });

    if (!pastBooking) return null;

    return `You're right - that ${pastBooking.service} appointment was on ${inBusinessTimezone(pastBooking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}. Did the session happen, or did you miss it? We can't change or cancel a past appointment, but I can help arrange a new session.`;
  }

  private async logConversationLearning(params: {
    customerId: string;
    userMessage: string;
    aiResponse: string;
    platform: string;
    latencyMs: number;
    wasSuccessful: boolean;
    isFallback: boolean;
  }): Promise<void> {
    try {
      const { score, sentiment, confidence: toneConfidence } = scoreSentiment(params.userMessage);
      const inferred = this.inferIntent(params.userMessage);
      const conversationLength = Math.max(1, params.userMessage.split('\n').filter(Boolean).length);

      await prisma.conversationLearning.create({
        data: {
          customerId: params.customerId,
          userMessage: params.userMessage,
          aiResponse: params.aiResponse,
          extractedIntent: inferred.intent,
          detectedEmotionalTone: sentiment,
          wasSuccessful: params.wasSuccessful,
          conversationOutcome: this.inferOutcome(params.aiResponse, params.isFallback),
          conversationLength,
          timeToResolution: Math.max(1, Math.round(params.latencyMs / 1000)),
          metadata: {
            platform: params.platform,
            isFallback: params.isFallback,
            sentimentScore: score,
            toneConfidence,
            intentConfidence: inferred.confidence,
            intentRule: inferred.rule,
            classifierVersion: 'v2',
          },
        },
      });
    } catch (err) {
      console.error('Failed to log conversation learning:', err);
    }
  }

  async getInstructionGuide(): Promise<string> {
    const packagePricing = await this.getPackagePricingLine();
    return this.getSystemPrompt('', 'whatsapp', true, true, packagePricing);
  }

  private async getPackagePricingLine(): Promise<string> {
    try {
      const packages = await prisma.package.findMany({
        where: { name: { in: [...PACKAGE_NAMES_FOR_EXTRACTION] } },
        orderBy: { price: 'asc' },
        select: { name: true, price: true },
      });
      if (
        packages.length !== PACKAGE_NAMES_FOR_EXTRACTION.length
        || packages.some((pkg) => !Number.isInteger(pkg.price) || pkg.price <= 0)
      ) {
        throw new Error('The package catalog is missing one or more valid Edition prices.');
      }

      const packageDescriptions = packages.map((pkg) => {
        const name = pkg.name.toUpperCase();
        const badge = name === 'THE EMPRESS'
          ? ' (Most Loved / Signature)'
          : name === 'THE GODDESS'
            ? ' (Flagship)'
            : '';
        return `${name}: Ksh ${pkg.price.toLocaleString()}${badge}`;
      });
      return `The Editions are ${packageDescriptions.join(', ')}.`;
    } catch (error) {
      console.warn('[AGENT] Package catalog unavailable; using the hardcoded package-price prompt fallback.');
      return PACKAGE_PRICING_FALLBACK;
    }
  }

  private getSystemPrompt(
    businessContext: string,
    platform: string,
    includePackagePricing = true,
    includeAddonPricing = true,
    packagePricingLine = PACKAGE_PRICING_FALLBACK
  ): string {
    const now = nowInBusinessTimezone().format('dddd, MMMM D, YYYY h:mm A');
    const packagePricing = includePackagePricing
      ? packagePricingLine
      : 'Use package prices only when present in Business Context; if unavailable, offer to confirm with the team rather than guess.';
    const addonPricing = includeAddonPricing
      ? this.getAddonPricingLine()
      : 'Use exact add-on prices only when present in Business Context; if unavailable, offer to confirm with the team rather than guess.';
    return `Current Date/Time: ${now}
You are the dedicated Studio Concierge & Host for Fiesta House Attire & Maternity, a premier luxury maternity, newborn, and family photography studio in Parklands, Nairobi.
Your purpose is to provide warm, consultative, and effortless guidance—helping expecting mothers and families feel celebrated, pampered, and completely at ease as they plan and book their photography sessions.

Conversation process (internal; do not narrate): Understand the customer's vision and intent from the full conversation history. Decide whether a tool is needed, provide consultative guidance with genuine warmth, and proactively guide them toward the next natural step in their booking journey. Treat follow-ups with continuous context and care.

Business Context and Customer History:
${businessContext}

Instructions:
These are grouped by category. If any two instructions ever seem to conflict, resolve it using this priority order: [A] Hard Constraints > [B] Tool-Use Workflow > [C] Business Knowledge > [D] Conversation Style. Never let a Conversation Style preference (like being warm or proactive) override a Hard Constraint or Tool-Use Workflow rule.

[A] HARD CONSTRAINTS (non-negotiable, check these first, before anything else)
A1. PLATFORM CAPABILITY GATE - CHECK THIS BEFORE STARTING ANY BOOKING FLOW: you are currently talking to the user on "${platform}". If the platform is "instagram" or "facebook", YOU CANNOT MAKE BOOKINGS on this channel at all - do not begin gathering Name/Service/Date/Time here even if the customer offers them. As soon as it becomes clear they want to book, immediately and politely tell them bookings are only accepted via WhatsApp, and instruct them to click the WhatsApp link/button on our profile to continue. If the platform IS "whatsapp" or "web", the booking flow in [B] is fully available.
A2. We are CLOSED on Mondays. Do NOT allow any bookings on Mondays.
A3. Never assume, guess, or invent a date or time for a booking, reschedule, or anything else the customer hasn't explicitly stated.
A4. CANCELLATIONS MUST BE TWO STEPS AND REAL, NOT TEXT-ONLY: when a customer asks to cancel, identify the exact upcoming session and state its date, time, and refund eligibility, then stop and wait. Only cancel on a later customer message that clearly says yes, yeah, yep, ndio, or confirm, and only after checking that the pending cancellation proposal came from a prior turn and has not expired. "ok", "okay", and "sawa" are not cancellation consent. Never claim a cancellation succeeded unless the cancellation action returns success. If there are multiple upcoming sessions, ask which one and cancel nothing until they identify it. If they say no or keep it, clear the proposal and say the booking is unchanged. If they send an unrelated message, clear the pending cancellation proposal so a later yes cannot act on stale consent. Never replace an existing booking, reschedule, or payment draft to stage a cancellation; explain that the existing step is unchanged. State refund eligibility only; never promise an amount or say money was returned.
A5. PAYMENT STATUS ACCURACY: Check the "Payment Status" in the Customer History above. Only say a deposit was received or paid when Payment Status explicitly says it succeeded/was paid. A confirmed booking status alone does not prove payment was received. If the booking is confirmed but payment status is missing or unclear, confirm only the booking and offer to have the team verify payment. Never state a deposit was forfeited unless a successful reschedule tool result or another verified source explicitly says it was forfeited. Keep payment received, booking confirmed, and deposit forfeited as distinct facts.
A6. DO NOT RE-CONFIRM WHAT'S ALREADY DONE: once a booking, reschedule, or cancellation has already been confirmed and applied earlier in this conversation, never ask the customer to reconfirm it again (e.g. "just to confirm, you'd like to move it to X, right?"). If the customer replies with a simple acknowledgement like "okay", "thanks", or "got it" afterward, just accept it warmly (e.g. "You're welcome! Let me know if you need anything else.") - do not repeat, second-guess, or re-verify a change that is already done. This acknowledgement rule applies only after the action is complete; while a cancellation proposal is pending, only a clear yes/yeah/yep/ndio/confirm confirms it, and no/keep it or an unrelated message clears it.
A7. MEDIA POLICY: Do NOT offer to send, share, or forward videos, photos, or any media files directly in this chat. If a customer asks to see photos, videos, or a studio tour, direct them to our Instagram (@fiestahousematernity), Facebook, or website instead.
A8. SCOPE: Only provide information about Fiesta House services, sessions, bookings, and studio policies. Do not provide sexual-health, fertility, medical, legal, financial, or other professional advice. For a question outside this scope, briefly say you can help with Fiesta House photo sessions and direct them to an appropriate qualified professional. This does not prohibit answering studio questions about nude or semi-nude maternity portraits, privacy, partners, or children joining a shoot.
A9. VERIFIED WEBSITE LINKS: Use only these exact Fiesta House website URLs: ${Object.values(OFFICIAL_WEBSITE_URLS).join(', ')}. Never guess or construct a page path. The reviews page is /reviews; the Suspending Concept gallery is /gallery/suspending-concept. If no verified link fits, share the homepage or offer to check with the team.

[B] TOOL-USE WORKFLOW (how and when to call tools, once [A] allows it)
B1. If the customer asks about their upcoming appointment, its date/time, or its details (e.g. "tell me about my appointment", "when is my session", "what are its details") - this is an INFO REQUEST, NOT a reschedule request. Just answer directly using the "Upcoming Booking" / "Past Bookings" information already provided above. Do NOT call propose_reschedule, get_available_slots, or ask them for a new date/time unless they explicitly say they want to reschedule, change, move, postpone, or cancel it.
B2. BOOKING FLOW, IN THIS EXACT ORDER - never skip or reorder a step:
    a) Gather their real Name, the Service they want, a Date, and a Time. Track which of these are already known from earlier in this same conversation (e.g. they already agreed to a themed backdrop, or already named a package) and only ask for what's still missing - ask for it in ONE clear question, do not re-ask about something already settled, and do not pivot to an unrelated topic when they've just answered the specific question you asked. If a date/time they give looks like a typo of a real day or time (e.g. "Sundat" for "Sunday"), interpret it as they most likely meant rather than ignoring it or changing the subject; only ask them to clarify if it's genuinely ambiguous.
    b) Call 'get_available_slots' for that specific date and service to see which times are free. If their preferred time is taken, suggest the closest available slots from the list returned.
    c) Once the time is confirmed free, ask ONCE if they'd like any optional add-ons (e.g. "Would you like to include any optional add-ons with your shoot, such as an extra outfit, styled wig hire, or extra edited photos? It's completely optional!"). Make clear it's optional. If they accept an add-on, save it with 'add_session_note'. If they decline ("no", "none", "skip") or don't respond to it after one ask, move on immediately - never ask about add-ons more than once per booking.
    d) Only now call 'propose_booking'. This only tells the customer the deposit amount - it does NOT charge anything or send any payment prompt. STOP THERE and wait.
    e) Only after the customer explicitly replies yes/confirm/go ahead in their OWN next message do you call 'confirm_booking', which is what actually sends the M-Pesa payment prompt. NEVER call propose_booking and confirm_booking in the same turn, even if the customer's message sounds enthusiastic.
    f) Once 'confirm_booking' runs, tell the customer they'll get an M-Pesa STK push to enter their PIN, and that the booking is only "provisional" until the deposit is paid - they'll get a confirmation message once payment succeeds.
B3. RESCHEDULING IS TWO STEPS, NEVER SKIP OR COMBINE THEM: if they want to reschedule but haven't given a specific new date/time, DO NOT call any tool - ask them what date/time they want first. Once they've stated a specific new date/time, call 'propose_reschedule' (this only tells them the proposed new date/time - it changes nothing yet), then STOP and wait. Only call 'confirm_reschedule' after they explicitly reply yes/confirm on their OWN later message - never in the same turn as propose_reschedule.
B4. PHOTO DELIVERY PREFERENCES: if a customer asks about receiving edited photos, clarify that delivery is always via a secure download link, then capture their preferred channel (email/WhatsApp/download link) using 'save_delivery_preference'. If they requested email but have not provided the exact email address (and it isn't already known), ask for the email first before calling the tool. When confirming a saved delivery email, use plain text (no markdown asterisks) and remind them edited photos are delivered within 10 working days.
B5. SESSION NOTES - USE JUDGEMENT ON WHAT'S WORTH SAVING: use 'add_session_note' only for details that would actually change how the shoot day is planned or run - e.g. who else is attending, a specific backdrop/colour/theme request, a mobility or access need, or an explicit special request. Do not save incidental chit-chat or vague preferences that don't affect planning (e.g. "I like blue" said in passing). When in doubt, ask yourself whether the studio team would need to know this before the shoot - if not, don't save it.

[C] BUSINESS KNOWLEDGE (answer from this, then tool results, then escalate)
C1. INFORMATION PRIORITY ORDER: answer customer questions using, in this order: (1) the Business Context provided above, (2) the customer's own Upcoming/Past Booking or payment context provided above, (3) results actually returned by a tool call this turn. If none of these answer the question, follow C2. Never invent facts, prices, or policies that aren't present in one of these three sources.
C2. If none of the above answers their question, politely let them know you'll have a human team member follow up.
C3. RATE CARD 2026 & ACTIVE OFFERINGS: ${packagePricing} Legacy names like Standard, Economy, Executive, Gold, Platinum, VIP, VVIP are retired/deprecated. If asked about current offerings, describe THE EDITIONS; additions include extra photos, extra makeup, Power Suit, wig hire, Suspending Concept, Sculpture Set, and Reels; Bespoke Experiences; or Concierge Services for Travelling Mothers. Never present legacy names as current packages or use "standard" generically for the lineup.
C3b. ADD-ON PRICES: These are the only exact prices to quote: ${addonPricing} When asked what add-ons are available, list their prices accurately; never invent a price or say a fixed-price item "varies". Add-ons are settled with the balance, not the deposit.
C4. POST-APPOINTMENT: Never offer to reschedule or cancel an appointment whose date/time has already passed. Acknowledge that it has passed, ask whether the session took place or was missed, and offer to make a new booking if appropriate.
C5. MISSED CALLS / UNREACHABLE STAFF: If a customer says they called the studio phone and no one answered, or they cannot reach anyone by phone, respond with warmth and genuine empathy - the team is very likely mid-shoot and cannot answer. Acknowledge the inconvenience, reassure them the team is available right now via WhatsApp, and offer to answer any questions or complete a booking on the spot. Say something like: "I'm sorry about that - the team is most likely in the middle of a session and can't step away to answer. You're through to me right now and I can answer any questions or lock in a date for you straight away. What would you like to do?"

[D] CONVERSATION STYLE
D1. IDENTITY & NAME HANDLING: Greet clients warmly by name whenever known. If the Customer Name is "Unknown" or "WhatsApp User", ask for their name with genuine hospitality (e.g. "By the way, what name should I put down for you?"), and address them naturally once provided. You MUST have their real name before proposing any booking - never invent or reuse a placeholder name.
D2. VOICE: Be warm, gracious, capable, and attentive—like a dedicated personal concierge at a luxury photography studio. Maternity and newborn milestones are celebratory life events; share their excitement and speak with genuine care and reassurance.
D3. CONTEXT & VARIATION: Read recent turns, resolve references, acknowledge repeats, and vary phrasing. Avoid robotic canned openers, parroting, narration, repeated wording, and rigid menus. Speak consultatively—highlighting what makes each session special (styling from our gown closet, professional hair & makeup, partner joining).
D4. FORMAT: Use plain WhatsApp text that is easy and inviting to read on mobile, typically 2 to 4 comfortable sentences. Use a list only when specifically requested or genuinely clearer; never dump irrelevant context fields.
D4b. EDITION COMPARISONS: When comparing two or more editions, never use a markdown table or a wide side-by-side grid. Use a short heading, then one compact block per edition with the price and only the most decision-useful facts (studio time, edited photos, outfits, and notable inclusions). Follow with 1 to 3 plain-language "The difference" bullets and a gentle recommendation question. State each edition's actual inclusions independently; never write that one edition has the "same" extras as another unless that is explicitly verified in Business Context. Keep the comparison easy to scan on a phone and under 650 characters when possible.
D5. LENGTH: Aim for concise, well-paced replies (under 800 characters) that provide helpful substance without overwhelming the customer or sounding like an abrupt robot.
D6. OWN ERRORS: Correct previous incorrect guidance plainly and briefly with polite grace; do not defend or repeat it.
D7. BUSINESS INTRODUCTION EXAMPLE: Describe Fiesta House as a boutique luxury photography studio in Parklands, Nairobi, specialising in maternity, newborn, and family sessions. Mention our curated client gown closet, professional hair & makeup pampering, and relaxed posing guidance naturally rather than giving a brochure. Use only facts in Business Context.
D8. PROACTIVE CLOSING: Guide the conversation naturally with a warm next-step invitation or question (e.g. offering to check open dates or reserve a slot). Keep it genuine and caring rather than aggressive, and skip it once a booking, reschedule, or cancellation is confirmed.`;
  }


  /**
   * Runs the actual RAG + tool-calling pipeline. Can throw (provider errors,
   * DB errors, etc.) - callers should go through handleMessage, which wraps
   * this with the circuit breaker, rate limiting, and a safe fallback.
   */
  private async runAgent(customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<{ content: string; tokensUsed: number; failureType?: string }> {
    const modelRunStartedAt = Date.now();
    // 1. Fetch Customer and Booking History for Memory
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        bookings: {
          orderBy: { dateTime: 'desc' },
          take: 5,
          include: {
            bookingAddons: {
              where: { status: { in: ['pending', 'confirmed', 'invoiced'] } },
              orderBy: { createdAt: 'asc' },
              select: { name: true, quantity: true, totalPrice: true },
            },
            sessionNotes: {
              where: { status: { in: ['pending', 'approved'] } },
              orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
              select: { description: true, category: true, priority: true, structuredData: true },
            },
          },
        },
      }
    });

    const customerName = customer?.name && customer.name !== 'WhatsApp User' ? customer.name : 'Unknown';
    const now2 = dayjs();
    const upcomingBookings = (customer?.bookings || [])
      .filter(b => dayjs(b.dateTime).isAfter(now2) && b.status !== 'cancelled')
      .sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime());
    const upcomingBooking = upcomingBookings[0];
    const otherUpcomingBookings = upcomingBookings.slice(1)
      .map(b => `${b.service} on ${inBusinessTimezone(b.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')} (status: ${b.status})`)
      .join('; ') || 'None';
    const upcomingAddons = upcomingBooking?.bookingAddons || [];
    const upcomingNotes = upcomingBooking?.sessionNotes || [];
    const recipientSummary = upcomingBooking?.recipientName
      ? ` Recipient: ${upcomingBooking.recipientName}.`
      : '';
    const addonSummary = upcomingAddons.length > 0
      ? ` Add-ons: ${upcomingAddons.map((addon) => `${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}${addon.totalPrice > 0 ? ` (Ksh ${addon.totalPrice.toLocaleString()})` : ''}`).join(', ')}.`
      : '';
    const noteSummary = upcomingNotes.length > 0
      ? ` Special session details: ${upcomingNotes.map((note) => `${note.description} [${note.category}, ${note.priority} priority]`).join('; ')}.`
      : '';
    const upcomingBookingSummary = upcomingBooking
      ? `${upcomingBooking.service} on ${inBusinessTimezone(upcomingBooking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')} (status: ${upcomingBooking.status}; duration: ${upcomingBooking.durationMinutes || DEFAULT_DURATION} minutes).${recipientSummary}${addonSummary}${noteSummary}`
      : 'None';
    const pastBookings = customer?.bookings
      .filter((booking) => dayjs(booking.dateTime).isBefore(now2) && booking.status !== 'cancelled')
      .map(b =>
      `${b.service} on ${inBusinessTimezone(b.dateTime).format('YYYY-MM-DD')} (${b.status})`
    ).join(', ') || 'No past bookings';

    // Snapshot the booking draft's step as it stood BEFORE this turn's tool calls
    // run. confirm_booking checks against this snapshot, not the live value, so
    // a propose_booking call made earlier in this same turn can never satisfy it -
    // confirmation is only valid if it was already pending from a PRIOR message.
    const draftBeforeThisTurn = await prisma.bookingDraft.findUnique({ where: { customerId } });
    const initialDraftStep = draftBeforeThisTurn?.step;

    // Fetch latest payment status for upcoming booking or active draft
    let paymentSummary = 'No active payment on file.';
    if (upcomingBooking && upcomingBooking.status === 'confirmed') {
      const paidPayment = await prisma.payment.findFirst({
        where: { bookingId: upcomingBooking.id, status: 'success' },
        orderBy: { updatedAt: 'desc' },
      });
      paymentSummary = paidPayment
        ? `PAYMENT SUCCEEDED via M-Pesa${paidPayment.mpesaReceipt ? ` (Receipt: ${paidPayment.mpesaReceipt})` : ''}. The booking is confirmed. Do NOT claim the payment is pending.`
        : 'The booking is confirmed, but no successful payment is recorded. Do not say the deposit was paid or received; tell the customer the studio team can verify payment status.';
    } else if (draftBeforeThisTurn?.step === 'payment_pending') {
      paymentSummary = 'Payment pending user M-Pesa PIN entry for booking draft.';
    }

    // 1b. Long-term memory beyond the last 10 messages of raw history
    const memory = await prisma.customerMemory.findUnique({ where: { customerId } });
    const memorySummary = memory
      ? `Relationship Stage: ${memory.relationshipStage}. Total Past Bookings: ${memory.totalBookings}.`
        + (memory.preferredPackages.length ? ` Preferred Packages: ${memory.preferredPackages.join(', ')}.` : '')
        + (memory.lastInteractionSummary ? ` Last Interaction Summary: "${memory.lastInteractionSummary}"` : '')
      : 'No prior interaction history - this looks like a new customer.';

    // 2. Retrieve RAG Context
    const relevantKnowledge = await knowledgeRetrieval.search(userMessage, MAX_RAG_CONTEXT_CHUNKS);
    const contextString = relevantKnowledge.map(k => k.content).join('\n---\n');

    const fullContext = `Customer Name: ${customerName}
  Booking Draft: ${draftBeforeThisTurn?.recipientName ? `This booking is for ${draftBeforeThisTurn.recipientName}, on behalf of the WhatsApp customer. Do not ask for the recipient's name again.` : 'None'}
Upcoming Booking (their next appointment, if any): ${upcomingBookingSummary}
Other Upcoming Bookings: ${otherUpcomingBookings}
Payment Status: ${paymentSummary}
Past Bookings: ${pastBookings}
Customer Memory: ${memorySummary}

Business Context:
${contextString}`;

    // 3. Build conversation history
    const recentConversation = [...history.slice(-MAX_HISTORY_MESSAGES).map((message) => message.content), userMessage]
      .join('\n')
      .toLowerCase();
    const includePackagePricing = /\b(package|edition|bloom|muse|icon|legend|queen|empress|goddess|rate\s*card|pricing|price|cost|how\s+much|cheapest|affordable)\b/.test(recentConversation);
    const includeAddonPricing = /\b(add-?ons?|extras?|extra\s+(?:outfit|photo|makeup)|styled\s+wig|wig\s+hire|power\s+suit|sculpture\s+set|balloon\s+backdrop|reel\s+pricing)\b/.test(recentConversation);
    const packagePricingLine = includePackagePricing ? await this.getPackagePricingLine() : undefined;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.getSystemPrompt(fullContext, platform, includePackagePricing, includeAddonPricing, packagePricingLine) },
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: 'user', content: userMessage }
    ];

    // 3. Hybrid Extraction (for logging/debug, we'll let LLM handle the tool calls)
    const extractor = new BookingExtractor();
    const { details: extracted, usage: extractorUsage } = await extractor.extract(userMessage);
    console.log('Extracted details:', extracted);

    // 4. Define the tools the AI can use
    const availableTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'add_session_note',
          description: 'Saves a note about a specific request or detail for a booking (e.g. "bringing husband", "special backdrop request").',
          parameters: {
            type: 'object',
            properties: {
              bookingDate: { type: 'string', description: 'The date of the booking this note applies to (YYYY-MM-DD)' },
              note: { type: 'string', description: 'The specific detail to save' },
              type: { type: 'string', enum: ['external_people', 'external_items', 'special_request', 'other'], description: 'Legacy storage type for the note' },
              category: { type: 'string', enum: ['client_wish', 'operational', 'addon', 'accessibility', 'companion', 'styling', 'delivery', 'other'], description: 'What kind of operational detail this is' },
              priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'How important this detail is for preparing the session' }
            },
            required: ['bookingDate', 'note', 'type']
          }
        }
      }
    ];

    if (platform === 'whatsapp' || platform === 'web') {
      availableTools.push(
        {
          type: 'function',
          function: {
            name: 'propose_booking',
            description: 'Prepares a booking and tells the customer the exact deposit amount, once you have their real name, service, date, and a confirmed-free time. Does NOT charge anything or send any payment prompt yet - it only proposes. You must get an explicit yes/confirm from the customer on a LATER message before calling confirm_booking.',
            parameters: {
              type: 'object',
              properties: {
                customerName: { type: 'string', description: "The customer's real full name - never pass 'Unknown' or leave this as a placeholder, ask them for it first if you don't have it" },
                service: { type: 'string', description: 'The photography or attire service requested' },
                date: { type: 'string', description: 'The date for the booking (YYYY-MM-DD)' },
                time: { type: 'string', description: 'The time for the booking (HH:mm)' }
              },
              required: ['customerName', 'service', 'date', 'time']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'confirm_booking',
            description: "Sends the actual M-Pesa deposit payment prompt to the customer's phone. Only call this after propose_booking has already told them the deposit amount AND the customer has explicitly replied yes/confirm/go ahead in their OWN message - never call this in the same turn as propose_booking.",
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_reschedule',
            description: "Proposes moving the customer's upcoming booking to a new date/time they just told you. Only call this if the customer EXPLICITLY asked to reschedule/change/move/postpone their booking - merely asking about their appointment or its details (e.g. 'tell me about my appointment') is NOT a reschedule request, do not call this tool for that. NEVER invent or guess a date/time yourself - only call this with a date/time the customer actually stated in their own message. If they asked to reschedule without giving a new date/time, do not call this at all - ask them what date/time they want instead. Does NOT change anything yet - you must get an explicit yes/confirm from the customer on a LATER message before calling confirm_reschedule.",
            parameters: {
              type: 'object',
              properties: {
                newDate: { type: 'string', description: 'The new date, exactly as the customer stated it (YYYY-MM-DD)' },
                newTime: { type: 'string', description: 'The new time, exactly as the customer stated it (HH:mm)' }
              },
              required: ['newDate', 'newTime']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'confirm_reschedule',
            description: 'Actually applies the reschedule. Only call this after propose_reschedule already told the customer the new date/time AND they explicitly replied yes/confirm on their OWN later message - never call this in the same turn as propose_reschedule.',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_available_slots',
            description: 'Check available time slots for a specific date and service duration',
            parameters: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'The date to check (YYYY-MM-DD)' },
                service: { type: 'string', description: 'The service name (to determine duration)' }
              },
              required: ['date', 'service']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'cancel_booking',
            description: 'Two-step cancellation tool. On the first turn, identify the exact upcoming session, state its date/time and whether it is eligible for a refund (never promise an amount or that money was returned), save a cancel_confirm proposal, and STOP. If there are multiple upcoming sessions, ask which one and save no cancellation proposal until the customer identifies one. On a later turn, call this tool to cancel only when initialDraftStep was already cancel_confirm, the customer message clearly says yes/yeah/yep/ndio/confirm, and the immediately preceding assistant message asked them to confirm this cancellation. ok/okay/sawa are not consent. A no/keep response or unrelated message must clear the pending proposal. The actual cancellation updates the booking and removes its Google Calendar event through the existing cancellation action.',
            parameters: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'Date (YYYY-MM-DD) of the appointment to cancel. Required when the customer has more than one upcoming appointment.' }
              }
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'save_delivery_preference',
            description: 'Saves how the customer wants to receive the secure download link for edited photos (especially email delivery). If email delivery is requested, include the exact email address when known.',
            parameters: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['email', 'download_link', 'whatsapp'], description: 'Preferred channel for receiving the secure download link for edited photos' },
                email: { type: 'string', description: 'Customer email address if method is email (optional only when already known and previously confirmed)' },
                whatsappNumber: { type: 'string', description: 'WhatsApp number to receive the download link when method is whatsapp (optional if same as customer number on file)' },
                note: { type: 'string', description: 'Any extra delivery preference details (e.g. express requested)' }
              },
              required: ['method']
            }
          }
        }
      );
    }

    const allTools = this.shouldExposeTools(userMessage, history, platform) ? availableTools : [];
    const allowedToolNames = allTools
      .map((tool) => tool.type === 'function' ? tool.function.name : '')
      .filter((name): name is string => !!name);

    // 5. Call LLM. Booking a slot is naturally multi-step (check availability,
    // then book), so the model can legitimately want to chain more than one
    // tool call in a single turn - loop until it returns plain text instead of
    // assuming a single round. A hard cap prevents a runaway loop.
    const usage: TokenUsage = { ...extractorUsage };
    let toolCalls = 0;
    const MAX_TOOL_ROUNDS = 3;
    const completionParams = {
      model: CHAT_MODEL,
      messages,
      temperature: 0.3,
      max_completion_tokens: MAX_AGENT_COMPLETION_TOKENS,
      ...(allTools.length > 0 ? { tools: allTools, tool_choice: 'auto' as const } : {}),
    };
    let completion = await this.createCompletionWithToolNameGuard(completionParams, allowedToolNames, availableTools);
    let currentResponse = completion.response;
    addUsage(usage, usageFromCompletion(currentResponse, completion.completionCalls));

    let rounds = 0;
    let proposedThisTurn = false; // blocks confirm_booking if propose_booking (even a re-propose with changed details) ran earlier in this same turn
    let confirmedActionThisTurn = false; // once a booking/reschedule is confirmed, blocks ALL further booking tool calls this turn - the model has looped and re-proposed unasked-for changes after a successful confirm before
    let rescheduleAppliedThisTurn = false;
    let cancelledThisTurn = false;
    let noteSavedThisTurn = false;
    let cancellationReply: string | null = null;
    while (currentResponse.choices[0].message.tool_calls && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const responseMessage = currentResponse.choices[0].message;
      messages.push(responseMessage); // Add assistant message to history once

      for (const toolCall of responseMessage.tool_calls!) {
        if (toolCall.type === 'function') {
          toolCalls++;
          const functionName = toolCall.function.name;
          let args: any = {};
          let toolResponse: string;

          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            toolResponse = `ERROR: Invalid arguments for tool ${functionName}. Ask the customer for the missing details again and then retry the correct tool.`;
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResponse
            });
            continue;
          }

          console.log(`Tool Called: ${functionName} with args:`, args);

          try {
            if (['propose_booking', 'confirm_booking', 'propose_reschedule', 'confirm_reschedule', 'cancel_booking'].includes(functionName) && confirmedActionThisTurn) {
              toolResponse = `ERROR: A booking/reschedule was already confirmed earlier in this same turn. The task is done - stop calling booking tools and just tell the customer it's confirmed.`;
            }
            else if (functionName === 'propose_booking') {
              const requestedDate = this.getAuthoritativeRequestedDate(userMessage, args.date, extracted.date, history);
              const result = await this.executeProposeBookingTool(customerId, args.customerName, args.service, `${requestedDate}T${args.time}`);
              proposedThisTurn = true;
              toolResponse = `PROPOSED (not yet charged): ${args.service} on ${requestedDate} at ${args.time}, deposit KSH ${result.depositAmount}. Use this exact customer-facing confirmation: "Great, I can hold ${args.service} for ${requestedDate} at ${args.time}. The deposit is KSH ${result.depositAmount}. If that works for you, just reply yes and I'll send the M-Pesa prompt." Do NOT call confirm_booking in this same turn.`;
            }
            else if (functionName === 'confirm_booking') {
              if (proposedThisTurn) {
                toolResponse = `ERROR: You already called propose_booking earlier in this same turn - possibly with different details than what the customer last saw and agreed to. You must stop here and wait for the customer's own separate message explicitly confirming before calling confirm_booking.`;
              } else if (!this.isPaymentConfirmation(userMessage)) {
                toolResponse = `ERROR: The customer has not explicitly replied yes, confirm, go ahead, or proceed in this message, so the M-Pesa prompt was NOT sent. Ask them to reply yes to confirm the booking.`;
              } else {
                const expectedDeposit = this.getDepositAmountFromProposalHistory(history);
                const result = await this.executeConfirmBookingTool(customerId, initialDraftStep, expectedDeposit);
                confirmedActionThisTurn = true;
                toolResponse = `I've initiated a deposit payment request of KSH ${result.depositAmount} to your phone. Once you enter your M-Pesa PIN and the payment is successful, your booking for ${result.service} on ${result.date} at ${result.time} will be officially confirmed. This is DONE - do not call any more booking tools this turn.`;
              }
            }
            else if (functionName === 'propose_reschedule') {
              if (!args.newDate || !args.newTime || !this.hasRescheduleDateTimeSignal(userMessage, history)) {
                toolResponse = `ERROR: The customer has not actually stated a specific new date and time in their OWN message this turn. Do NOT invent one, and do NOT reuse the date/time from their existing upcoming booking as if it were a new request - ask them what date and time they'd like to reschedule to.`;
              } else {
                const result = await this.executeProposeRescheduleTool(customerId, args.newDate, args.newTime);
                await this.notifyRescheduleAdmin({
                  customerId,
                  event: 'proposed',
                  service: result.service,
                  oldDateTime: result.oldDateTime,
                  newDate: args.newDate,
                  newTime: args.newTime,
                });
                proposedThisTurn = true;
                const policyNotice = this.isRescheduleWithin72Hours(result.oldDateTime)
                  ? `${this.getReschedulePolicyMessage()} `
                  : '';
                toolResponse = `${policyNotice}PROPOSED (not yet applied): reschedule ${result.service} to ${args.newDate} at ${args.newTime}. Use this exact customer-facing confirmation: "Great, I can move your ${result.service} session to ${args.newDate} at ${args.newTime}. If that works for you, just reply yes and I'll confirm it." Do NOT call confirm_reschedule in this same turn.`;
              }
            }
            else if (functionName === 'confirm_reschedule') {
              if (proposedThisTurn) {
                toolResponse = `ERROR: You already called propose_reschedule earlier in this same turn - possibly with different details than what the customer last saw and agreed to. You must stop here and wait for the customer's own separate message explicitly confirming before calling confirm_reschedule.`;
              } else {
                const result = await this.executeConfirmRescheduleTool(customerId, initialDraftStep);
                rescheduleAppliedThisTurn = true;
                await this.notifyRescheduleAdmin({
                  customerId,
                  event: 'confirmed',
                  service: result.service,
                  oldDateTime: result.oldDateTime,
                  newDateTime: result.newDateTime,
                });
                confirmedActionThisTurn = true;
                const policyNotice = result.depositForfeited
                  ? ' The customer was rescheduled within 72 hours, so the deposit was forfeited according to policy.'
                  : '';
                toolResponse = `SUCCESS: Booking for ${result.service} rescheduled to ${inBusinessTimezone(result.newDateTime).format('YYYY-MM-DD HH:mm')} Nairobi time.${policyNotice} This is DONE - do not call any more booking tools this turn.`;
              }
            }
            else if (functionName === 'cancel_booking') {
              if (proposedThisTurn) {
                toolResponse = 'ERROR: A cancellation proposal or booking selection was already made this turn. Stop and wait for the customer to respond on a later message.';
              } else if (initialDraftStep === 'cancel_confirm') {
                if (!this.isCancellationConfirmation(userMessage) || !this.previousMessageRequestsConfirmation(history)) {
                  toolResponse = 'ERROR: The customer has not clearly confirmed this pending cancellation in their own message immediately after the cancellation proposal. Do not cancel; ask them to reply yes, yeah, yep, ndio, or confirm.';
                } else {
                  const result = await this.executeConfirmCancellationTool(customerId, initialDraftStep);
                  confirmedActionThisTurn = true;
                  cancelledThisTurn = true;
                  cancellationReply = this.getCancellationCompletionReply(result);
                  toolResponse = `SUCCESS: ${cancellationReply} This is DONE - do not call any more booking tools this turn.`;
                }
              } else {
                const proposal = await this.proposeCancellation(customerId, userMessage, history);
                proposedThisTurn = true;
                cancellationReply = proposal.reply;
                toolResponse = `${proposal.reply} Do not call cancel_booking again this turn; wait for the customer's own next message.`;
              }
            }
            else if (functionName === 'save_delivery_preference') {
              const result = await this.executeSaveDeliveryPreferenceTool(customerId, args.method, args.email, args.whatsappNumber, args.note, platform);
              if (result.method === 'email' && result.email) {
                toolResponse = `SUCCESS: Delivery preference saved. Use this exact customer-facing confirmation: "Perfect, I've saved ${result.email} as your delivery email. We'll share your secure download link within 10 working days after the shoot."`;
              } else if (result.method === 'whatsapp' && result.whatsappNumber) {
                toolResponse = `SUCCESS: Delivery preference saved. Use this exact customer-facing confirmation: "Perfect, I've saved WhatsApp delivery to ${result.whatsappNumber}. We'll share your secure download link within 10 working days after the shoot."`;
              } else {
                toolResponse = `SUCCESS: Delivery preference saved as ${result.method}. Use this exact customer-facing confirmation: "Perfect, I've saved your delivery preference. We'll share your secure download link within 10 working days after the shoot."`;
              }
            }
            else if (functionName === 'add_session_note') {
              const noteResult = await this.executeAddNoteTool(customerId, args.bookingDate, args.note, args.type, args.category, args.priority, userMessage, platform);
              if (noteResult.created) {
                noteSavedThisTurn = true;
                toolResponse = `SUCCESS: Note added to session as ${noteResult.type}.`;
              } else {
                toolResponse = `INFO: Note not queued (${noteResult.reason || 'non-actionable'}).`;
              }
            }
            else if (functionName === 'get_available_slots') {
              const requestedDate = this.getAuthoritativeRequestedDate(userMessage, args.date, extracted.date, history);
              const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => args.service.toLowerCase().includes(k));
              if (!serviceKey) {
                toolResponse = `ERROR: "${args.service}" isn't one of our packages. Valid packages are: ${Object.keys(SERVICE_DURATIONS).join(', ')}. Ask the customer to pick one of these.`;
              } else {
                const duration = SERVICE_DURATIONS[serviceKey];
                const result: any = await bookingService.getAvailableSlots(requestedDate, duration);
                // Spell out the weekday so the model never has to infer it from the raw ISO date.
                const dateLabel = `${dayjs(requestedDate).format('dddd, MMMM D, YYYY')} (${requestedDate})`;

                if (result.status === 'closed') {
                  toolResponse = `The business is CLOSED on ${dateLabel} because: ${result.reason}.`;
                } else {
                  const slots = Array.isArray(result) ? result : [];
                  toolResponse = `Available slots for ${args.service} on ${dateLabel}: ${slots.length > 0 ? slots.join(', ') : 'None'}. When referring to this date with the customer, use exactly this weekday - do not guess it.`;
                }
              }
            } else {
              toolResponse = `ERROR: Tool ${functionName} not found.`;
            }
          } catch (e: any) {
            console.error(`Tool execution error (${functionName}):`, e);
            if (functionName === 'propose_reschedule' || functionName === 'confirm_reschedule') {
              await this.notifyRescheduleAdmin({
                customerId,
                event: 'failed',
                newDate: args?.newDate,
                newTime: args?.newTime,
                reason: e?.message,
              });
            }
            if (functionName === 'cancel_booking') {
              await notifyAdmin(
                'booking',
                `Cancellation failed for ${customerId}`,
                `Cancellation tool failed: ${e?.message || 'Unknown error'}`,
                { customerId, event: 'cancel_failed', reason: e?.message }
              );
            }
            toolResponse = `ERROR: ${e.message}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResponse
          });
        }
      }

      if (allTools.length === 0 && currentResponse.choices[0].message.tool_calls) {
        completionParams.tools = availableTools;
        completionParams.tool_choice = 'auto';
      }

      completion = await this.createCompletionWithToolNameGuard({
        ...completionParams,
        messages,
      }, allowedToolNames, availableTools, completion.provider);
      currentResponse = completion.response;
      addUsage(usage, usageFromCompletion(currentResponse, completion.completionCalls));
    }

    const modelContent = currentResponse.choices[0].message.content?.trim() || '';
    const emptyResponse = modelContent.length === 0;
    console.info('[AGENT_USAGE]', JSON.stringify({
      customerRef: this.customerReference(customerId),
      model: CHAT_MODEL,
      completionCalls: usage.completionCalls,
      toolCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs: Date.now() - modelRunStartedAt,
      rateLimited: false,
      failureType: emptyResponse ? 'empty_model_response' : null,
    }));

    const unverifiedActionReply = this.getUnverifiedActionReply(modelContent, {
      rescheduled: rescheduleAppliedThisTurn,
      cancelled: cancelledThisTurn,
      noteSaved: noteSavedThisTurn,
    });
    if (unverifiedActionReply) {
      console.warn('[AGENT_FLOW] Blocked unverified action claim:', JSON.stringify({ customerRef: this.customerReference(customerId), reply: modelContent.slice(0, 200) }));
    }

    const safeModelContent = cancellationReply || (unverifiedActionReply
      ? unverifiedActionReply
      : this.isUnverifiedBookingConfirmation(modelContent, userMessage, history)
      && !rescheduleAppliedThisTurn
      ? 'I can’t confirm a new booking from that message alone. No new appointment has been confirmed or paid for. I can check whether the requested date and time are available.'
      : this.formatCustomerReply(modelContent, userMessage, history));

    return {
      content: emptyResponse
        ? 'Sorry, I lost the thread there. Could you tell me a little more about what you need?'
        : safeModelContent,
      tokensUsed: usage.totalTokens,
      ...(emptyResponse ? { failureType: 'empty_model_response' } : {}),
    };
  }

  private createMessageRoutes(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    platform: string,
    startedAt: number
  ): MessageRoute[] {
    let scopeBoundaryReply: string | null = null;
    let informationalFlowResolved = false;
    let informationalFlow: ReturnType<ConversationFlowHandler['resolveInformationalFlow']> | undefined;
    const getInformationalFlow = () => {
      if (!informationalFlowResolved) {
        informationalFlow = this.conversationFlowHandler.resolveInformationalFlow(userMessage, history);
        informationalFlowResolved = true;
      }
      return informationalFlow;
    };

    return [
      {
        name: 'scopeBoundary',
        when: () => Boolean(scopeBoundaryReply = this.getScopeBoundaryReply(userMessage, history)),
        handle: () => scopeBoundaryReply,
      },
      {
        name: 'identityCorrection',
        when: () => this.isBookingIdentityCorrection(userMessage),
        handle: async () => this.getBookingIdentityCorrectionReply(customerId, history),
      },
      {
        name: 'recipientName',
        when: () => this.shouldCaptureRecipientName(userMessage, history),
        handle: async () => {
          const recipientName = await this.captureRecipientName(customerId, userMessage);
          return recipientName
            ? `Thanks, I’ll set the session up for ${recipientName}. Which package would you like, and what date and time would work best?`
            : null;
        },
      },
      {
        name: 'ambiguousDeposit',
        when: () => this.shouldClarifyAmbiguousDeposit(userMessage),
        handle: () => this.getAmbiguousDepositReply(),
      },
      {
        name: 'rescheduleWithdrawalConfirmation',
        when: () => this.shouldConfirmRescheduleWithdrawal(userMessage, history),
        handle: () => 'Yes. Your original session date and time are still booked, and your deposit remains held for it.',
      },
      {
        name: 'postActionAcknowledgement',
        when: () => this.isPostActionAcknowledgement(userMessage, history),
        handle: () => this.previousMessageRequestsConfirmation(history)
          ? 'No rush. Let me know when you are ready to go ahead.'
          : 'You are welcome. I am here if you need anything else.',
      },
      {
        name: 'cancellationDeclined',
        when: () => this.hasPendingCancellationProposal(history) && this.isCancellationDecline(userMessage),
        handle: async () => {
          await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
          return 'Understood. Your booking is unchanged, and I have not cancelled it.';
        },
      },
      {
        name: 'staleCancellationProposal',
        when: () => this.hasPendingCancellationProposal(history)
          && !this.isCancellationConfirmation(userMessage)
          && !this.isCancellationDecline(userMessage)
          && !this.shouldUseCancellationRequest(userMessage, history),
        handle: async () => {
          await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
          return null;
        },
      },
      {
        name: 'cancellationProposal',
        when: () => (platform === 'whatsapp' || platform === 'web')
          && this.shouldUseCancellationRequest(userMessage, history),
        handle: async () => (await this.proposeCancellation(customerId, userMessage, history)).reply,
      },
      {
        name: 'bookingStatus',
        when: () => this.shouldUseBookingStatusReply(userMessage),
        handle: async () => this.getBookingStatusReply(customerId),
      },
      {
        name: 'upcomingAppointmentTime',
        when: () => this.shouldUseUpcomingAppointmentTimeReply(userMessage),
        handle: async () => this.getUpcomingAppointmentTimeReply(customerId),
      },
      {
        name: 'pastAppointmentsList',
        when: () => this.shouldUsePastAppointmentsListReply(userMessage),
        handle: async () => this.getPastAppointmentsListReply(customerId),
      },
      {
        name: 'lastAppointmentDetails',
        when: () => this.shouldUseLastAppointmentDetailsReply(userMessage),
        handle: async () => this.getLastAppointmentDetailsReply(customerId),
      },
      {
        name: 'upcomingAppointmentDetails',
        when: () => this.shouldUseUpcomingAppointmentDetailsReply(userMessage),
        handle: async () => this.getUpcomingAppointmentDetailsReply(customerId, history),
      },
      {
        name: 'mixedIntent',
        when: () => this.shouldClarifyMixedIntent(userMessage),
        handle: () => this.getMixedIntentClarificationReply(),
      },
      {
        name: 'invoice',
        when: () => this.shouldUseInvoiceRequestReply(userMessage, history),
        handle: async () => {
          const requestedInvoiceNumber = this.extractInvoiceNumber(userMessage);
          return this.sendStoredInvoiceToCustomer(customerId, requestedInvoiceNumber ?? undefined, history, userMessage);
        },
      },
      {
        name: 'pastAppointment',
        when: () => this.shouldUsePastAppointmentReply(userMessage) || this.isPastAppointmentFollowUp(userMessage, history),
        handle: async () => this.getPastAppointmentReply(customerId),
      },
      {
        name: 'bookingForSomeoneElse',
        when: () => this.shouldClarifyBookingForSomeoneElse(userMessage),
        handle: () => this.getBookingForSomeoneElseReply(),
      },
      {
        name: 'multiPersonBooking',
        when: () => this.shouldUseMultiPersonBookingReply(userMessage),
        handle: async () => {
          await this.captureMultiPersonBookingNote(customerId, userMessage).catch((err) => {
            console.error('Failed to capture multi-person booking note:', err);
          });
          return this.getMultiPersonBookingReply();
        },
      },
      {
        name: 'packageBudget',
        deterministicOnly: true,
        when: () => this.shouldUsePackageBudgetReply(userMessage),
        handle: () => this.getPackageBudgetReply(),
      },
      {
        name: 'paymentResend',
        when: () => this.shouldHandleResendRequest(userMessage),
        handle: async () => this.tryHandlePaymentResend(customerId),
      },
      {
        name: 'suspendingConceptGallery',
        when: () => {
          getInformationalFlow();
          return Boolean(this.getSuspendingConceptGalleryReply(userMessage, history));
        },
        handle: () => this.getSuspendingConceptGalleryReply(userMessage, history),
      },
      {
        name: 'reviewPage',
        when: () => Boolean(this.getReviewPageReply(userMessage)),
        handle: () => this.getReviewPageReply(userMessage),
      },
      {
        name: 'businessIntroduction',
        deterministicOnly: true,
        when: () => getInformationalFlow() === 'business_introduction',
        handle: () => this.getBusinessIntroductionReply(),
      },
      {
        name: 'weekday',
        deterministicOnly: true,
        when: () => getInformationalFlow() === 'weekday',
        handle: () => this.getWeekdayReply(userMessage, history),
      },
      {
        name: 'website',
        deterministicOnly: true,
        when: () => getInformationalFlow() === 'website',
        handle: () => this.getWebsiteReply(),
      },
      {
        name: 'contactDetails',
        deterministicOnly: true,
        when: () => getInformationalFlow() === 'contact_details',
        handle: () => this.getContactDetailsReply(),
      },
      {
        name: 'portfolio',
        deterministicOnly: true,
        when: () => getInformationalFlow() === 'portfolio',
        handle: () => this.getPortfolioReply(),
      },
      {
        name: 'socialMedia',
        deterministicOnly: true,
        when: () => this.shouldUseSocialMediaReply(userMessage),
        handle: () => this.getSocialMediaReply(),
      },
      {
        name: 'rawFiles',
        deterministicOnly: true,
        when: () => this.shouldUseRawFilesReply(userMessage),
        handle: () => this.getRawFilesReply(),
      },
      {
        name: 'previousAddon',
        when: () => this.shouldUsePreviousAddonReply(userMessage, history),
        handle: async () => this.getPreviousAddonReply(customerId),
      },
      {
        name: 'clarifyNewAddon',
        when: () => this.shouldClarifyNewAddon(userMessage, history),
        handle: () => 'Which add-on would you like to add to your session? I can show you the available extras if you are not sure yet.',
      },
      {
        name: 'addonListFollowUp',
        when: () => this.isAddonListFollowUp(userMessage, history),
        handle: () => this.getAdditionsReply(),
      },
      {
        name: 'selectedAddon',
        when: () => Boolean(this.getSelectedAddon(userMessage, history)),
        handle: async () => {
          const selectedAddon = this.getSelectedAddon(userMessage, history);
          if (!selectedAddon) return null;
          const addonQuantity = this.getRequestedAddonQuantity(userMessage, selectedAddon);
          const noteResult = await this.executeAddNoteTool(
            customerId,
            '',
            addonQuantity > 1 ? `${addonQuantity} x ${selectedAddon.name}` : selectedAddon.name,
            'special_request',
            'addon',
            'normal',
            userMessage,
            platform
          );
          return noteResult.created
            ? this.getAddonSelectionReply(selectedAddon, addonQuantity)
            : noteResult.reason === 'duplicate_pending_note'
              ? `${selectedAddon.name} is already recorded for your session, so I have not added it twice.`
              : 'I could not save that add-on just yet. Please tell me which extra you would like to include.';
        },
      },
      {
        name: 'additions',
        deterministicOnly: true,
        when: () => this.shouldUseAdditionsReply(userMessage),
        handle: () => this.getAdditionsReply(),
      },
      {
        name: 'bespoke',
        deterministicOnly: true,
        when: () => this.shouldUseBespokeReply(userMessage),
        handle: () => this.getBespokeReply(),
      },
      {
        name: 'travellingMothers',
        deterministicOnly: true,
        when: () => this.shouldUseTravellingMothersReply(userMessage),
        handle: () => this.getTravellingMothersReply(),
      },
      {
        name: 'earliestImageDelivery',
        deterministicOnly: true,
        when: () => this.shouldUseEarliestImageDeliveryReply(userMessage),
        handle: async () => this.getEarliestImageDeliveryReply(customerId),
      },
      {
        name: 'postShootProcess',
        deterministicOnly: true,
        when: () => this.shouldUsePostShootProcessReply(userMessage),
        handle: () => this.getPostShootProcessReply(),
      },
      {
        name: 'bookingProcess',
        deterministicOnly: true,
        when: () => this.shouldUseBookingProcessReply(userMessage),
        handle: async () => this.getBookingProcessReply(),
      },
      {
        name: 'timeOnlyRescheduleSelection',
        when: () => this.conversationFlows.isTimeOnlyRescheduleSelection(userMessage, history),
        handle: async () => this.getRescheduleTimeProposalReply(customerId, userMessage),
      },
      {
        name: 'rescheduleWithdrawal',
        when: () => this.shouldUseRescheduleWithdrawalReply(userMessage, history),
        handle: async () => {
          await this.withdrawPendingReschedule(customerId);
          return 'Understood! We will keep your original session date and time, and your booking remains unchanged. Your deposit is still held for that session. Let us know if you need anything else preparing for your shoot!';
        },
      },
      {
        name: 'timeOnlyRescheduleRequest',
        when: () => this.conversationFlows.isTimeOnlyRescheduleRequest(userMessage),
        handle: async () => this.getRescheduleTimeReply(customerId),
      },
      {
        name: 'rescheduleRequest',
        when: () => this.shouldUseRescheduleRequestReply(userMessage),
        handle: async () => this.getRescheduleTimeReply(customerId),
      },
      {
        name: 'sameBookingSlot',
        when: () => this.conversationFlows.isSameBookingSlotRequest(userMessage),
        handle: async () => this.getSameBookingSlotReply(customerId, history),
      },
      {
        name: 'packageSelection',
        deterministicOnly: true,
        when: () => this.shouldResolvePackageSelectionImmediately(userMessage),
        handle: async () => this.getPackageSelectionReply(customerId, userMessage),
      },
      {
        name: 'packageAdvice',
        deterministicOnly: true,
        when: () => this.conversationFlows.isPackageAdviceRequest(userMessage),
        handle: async () => this.getPackageAdviceReply(userMessage),
      },
      {
        name: 'packageCatalog',
        when: () => this.conversationFlows.isPackageCatalogRequest(userMessage, history),
        handle: async () => {
          const showInclusions = this.conversationFlows.isPackageInclusionFollowUp(userMessage, history);
          return this.getPackageCatalogReply(showInclusions);
        },
      },
      {
        name: 'immediateConfirmation',
        when: () => (platform === 'whatsapp' || platform === 'web')
          && this.isExplicitConfirmation(userMessage)
          && this.previousMessageRequestsConfirmation(history),
        handle: async () => {
          try {
            const immediate = await this.tryImmediateConfirmation(customerId, userMessage, history);
            return immediate;
          } catch (error: any) {
            console.error('[AGENT_FLOW] Immediate confirmation failed:', error);
            return {
              reply: error?.code === PAYMENT_PROMPT_UNRECORDED
                ? PAYMENT_PROMPT_UNRECORDED_REPLY
                : 'Sorry, something went wrong and I couldn’t finish that step just now. Please try again in a moment, or the studio team can help.',
              outcome: {
                success: false,
                isFallback: true,
                failureReason: String(error?.message || error).slice(0, 200),
              },
            };
          }
        },
      },
      {
        name: 'runAgent',
        when: () => true,
        handle: async () => {
          try {
            console.log('[AGENT_FLOW] No deterministic early exit matched; invoking runAgent()');
            const { content, tokensUsed, failureType } = await this.runAgent(customerId, userMessage, history, platform);
            console.log('[AGENT_FLOW] runAgent() completed successfully:', JSON.stringify({
              customerId,
              tokensUsed,
              replyPreview: content.slice(0, 200)
            }));
            circuitBreaker.recordSuccess();
            await this.recordTokenUsage(customerId, tokensUsed);
            if (failureType) {
              return { reply: content, outcome: { success: false, isFallback: true, failureReason: failureType } };
            }
            this.touchCustomerMemory(customerId, userMessage, platform).catch(err => console.error('Customer memory update failed:', err));
            return content;
          } catch (error: any) {
            console.error('[AGENT_FLOW] Agent reply pipeline failed:', error);
            const rateLimitType = classifyProviderRateLimit(error);
            console.log('[AGENT_FLOW] Failure classification:', JSON.stringify({
              customerRef: this.customerReference(customerId),
              errorName: error?.name,
              status: error?.status,
              code: error?.code,
              rateLimitType,
            }));
            console.info('[AGENT_USAGE]', JSON.stringify({
              customerRef: this.customerReference(customerId),
              model: CHAT_MODEL,
              completionCalls: null,
              toolCalls: null,
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              latencyMs: Date.now() - startedAt,
              rateLimited: rateLimitType !== null,
              failureType: rateLimitType || 'agent_pipeline_failure',
            }));
            const justTripped = circuitBreaker.recordFailure();
            const isOutage = isProviderRateLimitError(error);
            const pendingExtrasDecline = isOutage && (platform === 'whatsapp' || platform === 'web')
              && this.isDecliningOptionalAddons(userMessage, history);
            const fallbackReply = pendingExtrasDecline
              ? 'Noted, no optional extras. Our booking assistant is temporarily unavailable, so I have not sent a deposit proposal or M-Pesa prompt. A team member will follow up to finish your booking.'
              : isOutage
              ? PROVIDER_OUTAGE_MESSAGE
              : 'Sorry, I could not process that request right now. Please try again, or a team member will follow up with you.';
            if (rateLimitType === 'daily_tpd_exhausted' && shouldNotifyOutage()) {
              await this.escalate(customerId, 'error', `AI PROVIDER OUTAGE: Groq's daily token limit has been reached - ALL customers are currently getting the fallback message, not just this one. It resets on its own; check console.groq.com/settings/billing if this keeps recurring. Original error: ${error.message}`);
            } else if (rateLimitType === 'transient_rate_limit' && shouldNotifyOutage()) {
              await this.escalate(customerId, 'error', `AI PROVIDER RATE LIMIT: requests are being limited. No automatic retry was attempted. Original error: ${error.message}`);
            } else if (justTripped && !isOutage) {
              await this.escalate(customerId, 'error', `Circuit breaker just tripped: ${error.message}`);
            }
            if (pendingExtrasDecline) {
              await this.escalate(customerId, 'booking', 'Customer declined optional extras, but the AI provider is unavailable before the deposit proposal. Review the recent conversation, recheck slot availability, and send the booking proposal manually. No payment prompt was sent.');
            }
            return {
              reply: fallbackReply,
              outcome: {
                success: false,
                isFallback: true,
                failureReason: rateLimitType || String(error.message || error).slice(0, 200),
                circuitBreakerTrip: justTripped,
                circuitBreakerReason: justTripped ? 'Repeated failures in the reply pipeline' : undefined,
              },
            };
          }
        },
      },
    ];
  }

  /**
   * Handles an incoming message from a customer, with conversation history.
   * Wraps runAgent with a circuit breaker, per-customer daily token budget,
   * best-effort frustration detection, and AI job metrics. Never throws -
   * always resolves to a string that's safe to send to the customer.
   */
  async handleMessage(customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<string> {
    const startedAt = Date.now();
    const ctx: ReplyContext = { customerId, userMessage, platform, startedAt };
    const naturalAssistantMode = this.isNaturalAssistantModeEnabled();
    const cancellationDraftReply = await this.clearStaleCancellationDraftBeforeRouting(customerId, userMessage, history);
    if (cancellationDraftReply) return this.respond(ctx, cancellationDraftReply);
    const routes = this.createMessageRoutes(customerId, userMessage, history, platform, startedAt);
    const scopeBoundaryRoute = routes[0];
    if (scopeBoundaryRoute.when()) {
      console.log(`[AGENT_FLOW] route=${scopeBoundaryRoute.name}`);
      return await scopeBoundaryRoute.handle() as string;
    }

    console.log('[AGENT_FLOW] handleMessage start:', JSON.stringify({
      customerId,
      platform,
      messagePreview: userMessage.slice(0, 200),
      historyLength: history.length,
      naturalAssistantMode
    }));

    this.trackSentiment(customerId, userMessage).catch(err => console.error('Sentiment tracking failed:', err));

    if (circuitBreaker.isOpen()) {
      console.log('[AGENT_FLOW] Circuit breaker is open; returning fallback reply.');
      if (shouldNotifyOutage()) {
        await this.escalate(customerId, 'error', 'AI circuit breaker is open due to repeated failures - customers are getting the canned fallback message.');
      }
      return this.respond(ctx, FALLBACK_MESSAGE, {
        success: false,
        isFallback: true,
        failureReason: 'circuit_open',
        circuitBreakerTrip: true,
        circuitBreakerReason: 'Reply pipeline failing repeatedly, cooling down',
      });
    }

    const withinBudget = await this.checkTokenBudget(customerId);
    console.log('[AGENT_FLOW] Budget check result:', { customerId, withinBudget });
    if (!withinBudget) {
      console.log('[AGENT_FLOW] Daily token budget exceeded; returning fallback reply.', {
        customerId,
        dailyTokenCap: DAILY_TOKEN_CAP,
        platform
      });
      await this.escalate(
        customerId,
        'quota',
        `Customer hit the daily AI token budget (cap: ${DAILY_TOKEN_CAP}). The bot sent the quota fallback instead of continuing the conversation.`
      );
      return this.respond(ctx, FALLBACK_MESSAGE, { success: false, isFallback: true, failureReason: 'daily_token_limit_exceeded' });
    }

    for (const route of routes.slice(1)) {
      if (route.deterministicOnly && naturalAssistantMode) continue;
      if (!route.when()) continue;
      console.log(`[AGENT_FLOW] route=${route.name}`);
      const result = await route.handle();
      if (result === null) continue;
      if (typeof result === 'string') return this.respond(ctx, result);
      return this.respond(ctx, result.reply, result.outcome);
    }

    return this.respond(ctx, FALLBACK_MESSAGE, { success: false, isFallback: true, failureReason: 'no_matching_route' });
  }

  private isExplicitConfirmation(userMessage: string): boolean {
    const normalized = userMessage
      .trim()
      .toLowerCase()
      .replace(/[!?.,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || normalized.length > 40) return false;

    // Guard against ambiguous/negative replies that should not auto-confirm.
    if (/\b(no|not|don't|dont|cancel|wait|hold)\b/.test(normalized)) return false;

    const confirmations = new Set([
      'yes', 'y', 'yep', 'yeah', 'yess', 'yesss',
      'ok', 'okay', 'confirm', 'confirmed',
      'go ahead', 'go-ahead', 'proceed', 'continue',
      'that works', 'works for me', 'that one', 'same one', 'lets do that', "let's do that", 'let us do that',
      'sawa', 'ndio'
    ]);

    if (confirmations.has(normalized)) return true;

    // Accept short natural affirmations like "yes that works for me" or
    // "yess that one" for pending booking/reschedule drafts.
    return [
      /^yes+s?\b/,
      /^yep\b/,
      /^yeah\b/,
      /^ok(ay)?\b/,
      /^confirm(ed)?\b/,
      /^go[\s-]?ahead\b/,
      /^that works\b/,
      /^works for me\b/,
      /^that one\b/,
      /^same one\b/,
      /^let'?s do that\b/,
      /^let us do that\b/
    ].some((pattern) => pattern.test(normalized));
  }

  private isPostActionAcknowledgement(
    userMessage: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): boolean {
    const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, '').replace(/\s+/g, ' ');
    const isAcknowledgement = /^(?:ok|okay|thanks|thank you(?: so much)?|got it|sawa|alright|perfect|great|all good)(?:\s+(?:thanks|thank you))?$/.test(normalized);
    if (!isAcknowledgement) return false;

    const awaitingConfirmation = this.previousMessageRequestsConfirmation(history);
    const includesThanks = /\b(thanks|thank you)\b/.test(normalized);
    if (awaitingConfirmation && !includesThanks && /^(?:ok|okay|alright|sawa)$/.test(normalized)) return false;

    return true;
  }

  /** Sending an M-Pesa prompt needs an explicit yes/yeah/yep/ndio/confirm/go ahead/proceed; "ok" or "sawa" is not enough. */
  private isPaymentConfirmation(userMessage: string): boolean {
    const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ');
    if (/\b(no|not|don't|dont|cancel|wait|hold)\b/.test(normalized)) return false;
    return /\b(?:yes+|yeah|yep|ndio|confirm(?:ed)?|go[\s-]?ahead|proceed)\b/.test(normalized);
  }

  private isCancellationConfirmation(userMessage: string): boolean {
    const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
    return /^(?:yes+|yeah|yep|ndio|confirm(?:ed)?)(?: please)?$/.test(normalized);
  }

  private isCancellationDecline(userMessage: string): boolean {
    const normalized = userMessage.trim().toLowerCase().replace(/[.!?,]/g, '').replace(/\s+/g, ' ');
    return /^(?:no(?:\s+(?:thanks|thank you|keep it|keep my booking|keep the booking|keep my session|keep the session))?|keep it|keep my booking|keep the booking|keep my session|keep the session|leave it|leave it unchanged|don't cancel|do not cancel)$/.test(normalized);
  }

  private hasPendingCancellationProposal(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    return /if you want me to cancel this booking, reply yes to confirm/i.test(previousAssistantMessage);
  }

  private isCancellationProposalExpired(draft: { cancelProposedAt?: Date | string | null }, now = Date.now()): boolean {
    const proposedAt = draft.cancelProposedAt ? new Date(draft.cancelProposedAt).getTime() : NaN;
    return !Number.isFinite(proposedAt) || now - proposedAt >= CANCELLATION_PROPOSAL_TTL_MS;
  }

  private async clearStaleCancellationDraftBeforeRouting(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string | null> {
    const previousMessageWasCancellationProposal = this.hasPendingCancellationProposal(history);
    const isConfirmation = this.isCancellationConfirmation(userMessage);
    if (!previousMessageWasCancellationProposal) return null;

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (draft?.step !== 'cancel_confirm') return null;

    if (this.isCancellationProposalExpired(draft)) {
      await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
      return isConfirmation
        ? 'That cancellation proposal expired, so your booking was not changed. If you still want to cancel it, please ask again.'
        : null;
    }

    if (isConfirmation || this.isCancellationDecline(userMessage)) return null;

    await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
    return isConfirmation
      ? 'I could not verify a current cancellation proposal, so your booking was not changed. Please tell me which session you want to cancel.'
      : null;
  }

  private hasPendingCancellationSelection(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    return /which session would you like me to cancel\?/i.test(previousAssistantMessage);
  }

  private hasCancellationBookingSelector(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    const date = (new BookingExtractor() as any).regexExtract(userMessage).date;
    const time = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{2}:\d{2}\b/i.test(text);
    const service = PACKAGE_NAMES_FOR_EXTRACTION.some((packageName) =>
      text.includes(packageName.toLowerCase().replace(/ package$/i, ''))
    );
    return Boolean(date || time || service);
  }

  private shouldUseCancellationRequest(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const text = userMessage.toLowerCase();
    const explicitRequest = /^(?:please\s+)?cancel(?:\s+please)?[!. ]*$/.test(text.trim())
      || /\b(?:please\s+)?cancel\s+(?:my|the|this|that|it|booking|appointment|session|shoot)\b/.test(text)
      || /\b(?:i want|i need|i'd like|i would like|can i|could i|may i) to? cancel\b/.test(text)
      || /\b(?:can|could|would) you cancel\b/.test(text);
    return explicitRequest || (this.hasPendingCancellationSelection(history)
      && this.hasCancellationBookingSelector(userMessage));
  }

  private async proposeCancellation(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<{ reply: string; proposed: boolean }> {
    const existingDraft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (existingDraft?.step && existingDraft.step !== 'cancel_confirm') {
      const draftDescription = existingDraft.step === 'payment_pending'
        ? 'An M-Pesa payment prompt is already pending'
        : existingDraft.step === 'awaiting_confirmation'
          ? 'A booking proposal is already awaiting your confirmation'
          : existingDraft.step === 'reschedule_confirm'
            ? 'A reschedule proposal is already awaiting your confirmation'
            : 'A booking is already being prepared';
      return {
        reply: `${draftDescription}, so I have not changed that request or started a cancellation. Please finish that step or ask the studio team to help.`,
        proposed: false,
      };
    }

    const upcomingBookings = await prisma.booking.findMany({
      where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
    });
    if (upcomingBookings.length === 0) {
      return { reply: 'I could not find an upcoming booking to cancel.', proposed: false };
    }

    const extractedDate = (new BookingExtractor() as any).regexExtract(userMessage).date as string | null;
    const timeMatch = userMessage.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{2}):(\d{2})\b/i);
    let requestedTime: string | null = null;
    if (timeMatch) {
      if (timeMatch[4]) {
        requestedTime = `${timeMatch[4]}:${timeMatch[5]}`;
      } else {
        const rawHour = Number(timeMatch[1]);
        const hour = rawHour % 12 + (timeMatch[3].toLowerCase() === 'pm' ? 12 : 0);
        requestedTime = `${String(hour).padStart(2, '0')}:${String(Number(timeMatch[2] || 0)).padStart(2, '0')}`;
      }
    }
    const text = userMessage.toLowerCase();
    const requestedPackage = PACKAGE_NAMES_FOR_EXTRACTION.find((packageName) =>
      text.includes(packageName.toLowerCase().replace(/ package$/i, ''))
    );
    const hasSelector = Boolean(extractedDate || requestedTime || requestedPackage);
    let matches = upcomingBookings;
    if (extractedDate) {
      matches = matches.filter((booking) => inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD') === extractedDate);
    }
    if (requestedTime) {
      matches = matches.filter((booking) => inBusinessTimezone(booking.dateTime).format('HH:mm') === requestedTime);
    }
    if (requestedPackage) {
      matches = matches.filter((booking) => booking.service.toLowerCase().includes(requestedPackage.toLowerCase()));
    }

    const describeBooking = (booking: { service: string; dateTime: Date }) => {
      const localDateTime = inBusinessTimezone(booking.dateTime);
      return `${booking.service} on ${localDateTime.format('dddd, D MMMM YYYY')} at ${localDateTime.format('h:mm A')}`;
    };
    if ((!hasSelector && upcomingBookings.length > 1) || matches.length !== 1) {
      const options = upcomingBookings.map((booking) => `- ${describeBooking(booking)}`).join('\n');
      const prompt = hasSelector && matches.length === 0
        ? `I could not match that to an upcoming session. Please choose one of these:\n${options}\nWhich session would you like me to cancel?`
        : `I found more than one upcoming session:\n${options}\nWhich session would you like me to cancel?`;
      return { reply: prompt, proposed: false };
    }

    const booking = matches[0];
    const localDateTime = inBusinessTimezone(booking.dateTime);
    const date = localDateTime.format('YYYY-MM-DD');
    const time = localDateTime.format('HH:mm');
    await prisma.bookingDraft.upsert({
      where: { customerId },
      update: {
        bookingId: booking.id,
        service: booking.service,
        date,
        time,
        dateTimeIso: booking.dateTime.toISOString(),
        cancelProposedAt: new Date(),
        step: 'cancel_confirm',
      },
      create: {
        customerId,
        bookingId: booking.id,
        service: booking.service,
        date,
        time,
        dateTimeIso: booking.dateTime.toISOString(),
        cancelProposedAt: new Date(),
        step: 'cancel_confirm',
      },
    });

    const refundEligible = getBookingPolicyWindow(booking.dateTime).cancellationRefundEligible;
    const refundPosition = refundEligible
      ? 'It is more than 72 hours away and is eligible for a refund under the policy. Eligibility does not confirm a refund amount or that money has been returned.'
      : 'It is 72 hours away or less and is not automatically refundable under the policy.';
    return {
      reply: `You asked to cancel your ${describeBooking(booking)}. ${refundPosition} If you want me to cancel this booking, reply yes to confirm.`,
      proposed: true,
    };
  }

  private shouldConfirmRescheduleWithdrawal(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, '').replace(/\s+/g, ' ');
    if (!/^(sure|yes|yeah|yep|okay|ok)$/.test(normalized)) return false;

    return history
      .filter((message) => message.role === 'assistant')
      .slice(-3)
      .some((message) => /original session date and time|booking remains unchanged|deposit is still held/i.test(message.content));
  }

  private previousMessageRequestsConfirmation(history: { role: 'user' | 'assistant', content: string }[]): boolean {
    const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content.toLowerCase() || '';
    return /(?:reply\s+["“”']?yes["“”']?|if\s+that\s+works\s+for\s+you.*reply\s+["“”']?yes["“”']?|would\s+you\s+like\s+me\s+to\s+confirm|confirm\s+that\s+change|confirm\s+the\s+change|shall\s+i\s+confirm|reply\W{0,3}yes\b|if\s+you\s+want\s+me\s+to\s+cancel\s+this\s+booking,?\s+reply\s+yes\s+to\s+confirm)/.test(previousAssistantMessage);
  }

  private getDepositAmountFromProposalHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): number | null {
    const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    const match = previousAssistantMessage.match(/\bdeposit\s+is\s+KSH\s+([\d,]+)/i);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    return Number.isInteger(amount) && amount > 0 ? amount : null;
  }

  private async tryImmediateConfirmation(
    customerId: string,
    userMessage = '',
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (!draft?.step) return null;

    if (draft.step === 'payment_pending') {
      return `I’ve already sent the M-Pesa deposit prompt to your phone for ${draft.service || 'your booking'}. Please complete the payment there and I’ll confirm the booking as soon as it succeeds.`;
    }

    if (draft.step === 'awaiting_confirmation') {
      if (!this.isPaymentConfirmation(userMessage)) {
        return PAYMENT_CONFIRMATION_REQUIRED_REPLY;
      }
      const expectedDeposit = this.getDepositAmountFromProposalHistory(history);
      const result = await this.executeConfirmBookingTool(customerId, 'awaiting_confirmation', expectedDeposit);
      return `I've sent the M-Pesa deposit prompt of KSH ${result.depositAmount} to your phone. Enter your PIN to complete it, and I'll confirm your ${result.service} session once the payment goes through.`;
    }

    if (draft.step === 'reschedule_confirm') {
      const result = await this.executeConfirmRescheduleTool(customerId, 'reschedule_confirm');
      void this.notifyRescheduleAdmin({
        customerId,
        event: 'confirmed',
        service: result.service,
        oldDateTime: result.oldDateTime,
        newDateTime: result.newDateTime,
      });
      return customerReplyTemplates.rescheduleConfirmed(
        result.service,
        dayjs(result.newDateTime).format('dddd, MMMM D, YYYY [at] h:mm A'),
        result.depositForfeited
      );
    }

    if (draft.step === 'cancel_confirm') {
      if (!this.hasPendingCancellationProposal(history)) {
        await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
        return null;
      }
      if (this.isCancellationProposalExpired(draft)) {
        await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
        return 'That cancellation proposal expired, so your booking was not changed. If you still want to cancel it, please ask again.';
      }
      if (!this.isCancellationConfirmation(userMessage)) {
        return 'Please reply yes, yeah, yep, ndio, or confirm if you want me to cancel this booking. Ok, okay, and sawa do not confirm a cancellation.';
      }
      const result = await this.executeConfirmCancellationTool(customerId, draft.step);
      return this.getCancellationCompletionReply(result);
    }

    return null;
  }

  private async tryHandlePaymentResend(customerId: string): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });

    // Valid resend path: customer has a pending payment draft.
    if (draft?.step === 'payment_pending') {
      const payment = await prisma.payment.findFirst({
        where: { bookingDraftId: draft.id, status: { in: ['pending', 'failed'] } },
        orderBy: { updatedAt: 'desc' },
      });

      if (!payment) {
        return 'I cannot find an active payment request to resend right now. Please say "book" and I will re-open the booking payment step for you.';
      }

      try {
        const mpesaResponse = await mpesaService.initiateStkPush(customerId, payment.amount, draft.id);
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'pending',
            checkoutRequestId: mpesaResponse.CheckoutRequestID,
            updatedAt: new Date(),
          }
        });

        return `Done - I've resent the M-Pesa deposit prompt of KSH ${payment.amount} to your phone. Please enter your PIN to complete payment.`;
      } catch (error: any) {
        console.error('Failed to resend M-Pesa STK push:', error);
        return `I couldn't resend the payment prompt right now. Please try again in a minute, or I can have the team assist immediately.`;
      }
    }

    // If a successful payment already exists for an upcoming confirmed booking,
    // never offer to resend payment.
    const confirmedPaidBooking = await prisma.payment.findFirst({
      where: {
        status: 'success',
        booking: {
          customerId,
          status: 'confirmed',
          dateTime: { gte: new Date() },
        }
      },
      include: { booking: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (confirmedPaidBooking?.booking) {
      return `Your payment is already successful and your booking is confirmed for ${confirmedPaidBooking.booking.service} on ${dayjs(confirmedPaidBooking.booking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}. No resend is needed.`;
    }

    return null;
  }

  /**
   * Keyword-based frustration check, run on every inbound message. Cheap
   * enough to never skip - no LLM call involved. Best-effort: failures here
   * must never break the actual reply.
   */
  private async trackSentiment(customerId: string, userMessage: string): Promise<void> {
    const { score, sentiment, confidence } = scoreSentiment(userMessage);

    await prisma.sentimentScore.create({
      data: { customerId, score, sentiment, confidence, triggeredAlert: score <= -0.6 }
    });

    if (score <= -0.6) {
      await this.escalate(customerId, 'frustration', `Customer message scored ${score.toFixed(2)} (${sentiment}) on the frustration heuristic.`, score);
    }
  }

  /**
   * Keeps CustomerMemory current with cheap, directly-derivable facts (no
   * extra LLM call - deeper summarization is a separate feature to build
   * later if wanted). Best-effort: failures here must never break the reply.
   */
  private async touchCustomerMemory(customerId: string, userMessage: string, platform: string): Promise<void> {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return; // customer doesn't exist yet (e.g. first-ever web chat message)

    const summary = userMessage.length > 200 ? userMessage.slice(0, 200) + '…' : userMessage;
    const existing = await prisma.customerMemory.findUnique({ where: { customerId } });

    await prisma.customerMemory.upsert({
      where: { customerId },
      update: {
        relationshipStage: existing?.relationshipStage === 'new' || !existing ? 'interested' : existing.relationshipStage,
        lastInteractionSummary: summary,
        preferredChannel: platform
      },
      create: {
        customerId,
        relationshipStage: 'interested',
        lastInteractionSummary: summary,
        preferredChannel: platform
      }
    });
  }

  /**
   * Creates an escalation row so a human knows to follow up. Best-effort -
   * a failure here must never break the actual customer-facing reply.
   */
  private async escalate(customerId: string, escalationType: string, description: string, sentimentScore?: number): Promise<void> {
    try {
      await prisma.escalation.create({
        data: { customerId, escalationType, description, status: 'OPEN', sentimentScore }
      });
      await notifyAdmin(
        'escalation',
        `Customer ${customerId} needs attention`,
        description,
        { customerId, escalationType, sentimentScore }
      );
    } catch (err) {
      console.error('Failed to create escalation:', err);
    }
  }

  /**
   * Emits operational notifications for reschedule milestones/failures
   * without automatically creating escalations.
   */
  private async notifyRescheduleAdmin(params: {
    customerId: string;
    event: 'proposed' | 'confirmed' | 'failed';
    service?: string;
    oldDateTime?: Date;
    newDate?: string;
    newTime?: string;
    newDateTime?: Date;
    reason?: string;
  }): Promise<void> {
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: params.customerId },
        select: { name: true, phone: true }
      });

      const actor = customer?.name && customer.name !== 'WhatsApp User'
        ? `${customer.name} (${customer.phone || params.customerId})`
        : customer?.phone || params.customerId;

      if (params.event === 'proposed') {
        await notifyAdmin(
          'reschedule',
          `Reschedule proposed: ${actor}`,
          `${params.service || 'Session'} proposed from ${params.oldDateTime ? dayjs(params.oldDateTime).format('YYYY-MM-DD HH:mm') : 'current slot'} to ${params.newDate} ${params.newTime}. Awaiting customer confirmation.`,
          {
            customerId: params.customerId,
            event: params.event,
            service: params.service,
            oldDateTime: params.oldDateTime?.toISOString(),
            newDate: params.newDate,
            newTime: params.newTime,
          }
        );
        return;
      }

      if (params.event === 'confirmed') {
        await notifyAdmin(
          'reschedule',
          `Reschedule confirmed: ${actor}`,
          `${params.service || 'Session'} moved from ${params.oldDateTime ? dayjs(params.oldDateTime).format('YYYY-MM-DD HH:mm') : 'previous slot'} to ${params.newDateTime ? dayjs(params.newDateTime).format('YYYY-MM-DD HH:mm') : `${params.newDate} ${params.newTime}`}.`,
          {
            customerId: params.customerId,
            event: params.event,
            service: params.service,
            oldDateTime: params.oldDateTime?.toISOString(),
            newDateTime: params.newDateTime?.toISOString(),
          }
        );
        return;
      }

      await notifyAdmin(
        'reschedule',
        `Reschedule failed: ${actor}`,
        `Reschedule attempt failed: ${params.reason || 'Unknown reason'}`,
        {
          customerId: params.customerId,
          event: params.event,
          service: params.service,
          newDate: params.newDate,
          newTime: params.newTime,
          reason: params.reason,
        }
      );
    } catch (err) {
      console.error('Failed to emit reschedule admin notification:', err);
    }
  }

  private async logAiJobMetric(data: {
    customerId: string; platform: string; success: boolean; latencyMs: number;
    failureReason?: string; isFallback?: boolean; circuitBreakerTrip?: boolean; circuitBreakerReason?: string;
  }): Promise<void> {
    try {
      await prisma.aiJobMetric.create({ data });
    } catch (err) {
      console.error('Failed to log AI job metric:', err);
    }
  }

  /**
   * Resets and checks a customer's rolling daily token budget. Missing customer
   * = allow (nothing to enforce yet). Only enforced in production - during
   * development a single person's own testing traffic blows past a budget
   * meant to catch runaway/abusive customers long before real usage would.
   */
  private async checkTokenBudget(customerId: string): Promise<boolean> {
    if (process.env.NODE_ENV !== 'production') return true;

    // Optional: allow exempting tester or admin phone numbers via comma-separated list
    const exemptNumbers = (process.env.EXEMPT_TOKEN_CAP_NUMBERS || '')
      .split(',')
      .map(n => n.trim().replace(/\D/g, ''))
      .filter(Boolean);
    const cleanId = customerId.replace(/\D/g, '');
    if (cleanId && exemptNumbers.includes(cleanId)) {
      return true;
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { dailyTokenUsage: true, tokenResetDate: true }
    });
    if (!customer) return true;

    const isNewDay = !customer.tokenResetDate || customer.tokenResetDate.toDateString() !== new Date().toDateString();
    const currentUsage = isNewDay ? 0 : customer.dailyTokenUsage;
    return currentUsage < DAILY_TOKEN_CAP;
  }

  /** Records token usage after a successful reply, resetting the daily counter if a new day has started. */
  private async recordTokenUsage(customerId: string, tokensUsed: number): Promise<void> {
    if (tokensUsed <= 0) return;
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { dailyTokenUsage: true, tokenResetDate: true }
      });
      if (!customer) return; // customer created later in the flow (e.g. at booking time) - nothing to update yet

      const isNewDay = !customer.tokenResetDate || customer.tokenResetDate.toDateString() !== new Date().toDateString();
      await prisma.customer.update({
        where: { id: customerId },
        data: {
          dailyTokenUsage: isNewDay ? tokensUsed : { increment: tokensUsed },
          tokenResetDate: new Date(),
          totalTokensUsed: { increment: tokensUsed }
        }
      });
    } catch (err) {
      console.error('Failed to record token usage:', err);
    }
  }

  /**
   * Step 1 of 2: validates the package/date and saves a BookingDraft in
   * 'awaiting_confirmation' - tells the customer the deposit amount, but never
   * touches M-Pesa. No payment prompt gets sent until confirm_booking runs,
   * which can only happen on a later turn (see initialDraftStep in runAgent).
   */
  private async executeProposeBookingTool(customerId: string, name: string, service: string, date: string) {
    if (!name || name.trim() === '' || name.trim().toLowerCase() === 'unknown') {
      throw new Error('Customer name is required before proposing a booking. Ask the customer for their full name first.');
    }

     let customer = await prisma.customer.findUnique({ where: { id: customerId } });
     const existingDraft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (!customer) {
       customer = await prisma.customer.create({
           data: { id: customerId, name: name }
       });
     } else if (customer.name !== name && !existingDraft?.isForSomeoneElse) {
       await prisma.customer.update({ where: { id: customerId }, data: { name }});
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => service.toLowerCase().includes(k));
    if (!serviceKey) {
      throw new Error(`"${service}" isn't one of our packages. Valid packages are: ${Object.keys(SERVICE_DURATIONS).join(', ')}. Ask the customer to pick one of these before booking.`);
    }

    const requestedSlot = date.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
    if (!requestedSlot) {
      throw new Error('The requested date and time are invalid. Ask the customer to provide a date and time, then check availability.');
    }
    const requestedDate = requestedSlot[1];
    const hour = Number(requestedSlot[2]);
    const minute = Number(requestedSlot[3]);
    const requestedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (hour > 23 || minute > 59) {
      throw new Error('The requested time is invalid. Ask the customer to choose a valid time.');
    }

    const slotsResult: any = await bookingService.getAvailableSlots(
      requestedDate,
      SERVICE_DURATIONS[serviceKey],
      undefined,
      existingDraft?.id
    );
    if (slotsResult?.status === 'closed') {
      throw new Error(`The studio is closed on ${requestedDate}. Ask the customer to select another date.`);
    }
    const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(requestedTime)) {
      throw new Error(`That time is unavailable on ${requestedDate}. Available times are: ${availableSlots.join(', ') || 'none'}. Ask the customer to choose an available time.`);
    }

    const dateTimeIso = businessDay(requestedDate)
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0)
      .toISOString();

    const depositAmount = this.getDepositForPackage(await this.getPackageForDeposit(service));

    await bookingDraftService.saveBookingProposal({
      customerId: customer.id,
      service,
      dateTime: dateTimeIso,
      customerName: name,
    });

    return { depositAmount };
  }

  /**
   * Step 2 of 2: actually sends the M-Pesa STK push. Only proceeds if
   * initialDraftStep (captured at the START of this turn, before any tool
   * calls ran) was already 'awaiting_confirmation' - meaning propose_booking
   * happened on a PRIOR message, not earlier in this same turn. This is what
   * guarantees the customer explicitly agreed before any prompt is sent.
   */
  private async executeConfirmBookingTool(
    customerId: string,
    initialDraftStep: string | undefined,
    expectedDeposit: number | null
  ) {
    if (initialDraftStep !== 'awaiting_confirmation') {
      throw new Error('No pending booking proposal from a prior message. Call propose_booking first and wait for the customer to explicitly confirm on their own next message before calling confirm_booking.');
    }

    const draft = await bookingDraftService.get(customerId);
    if (!draft || draft.step !== 'awaiting_confirmation') {
      throw new Error('No pending booking proposal found. Call propose_booking first.');
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => draft.service?.toLowerCase().includes(k));
    if (!serviceKey) {
      throw new Error(`The pending booking's package "${draft.service || 'unknown'}" isn't recognised, so the deposit can't be worked out. Do not start payment; ask the studio team to check the package.`);
    }
    if (!draft.date || !draft.time) {
      throw new Error('The pending booking is missing its date or time. Ask the customer to start the booking again.');
    }
    const slotsResult: any = await bookingService.getAvailableSlots(
      draft.date,
      SERVICE_DURATIONS[serviceKey],
      undefined,
      draft.id
    );
    if (slotsResult?.status === 'closed') {
      throw new Error(`The studio is closed on ${draft.date}. Do not start payment for this booking.`);
    }
    const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(draft.time)) {
      throw new Error(`The proposed time ${draft.time} on ${draft.date} is no longer available. Do not start payment; ask the customer to choose another time.`);
    }

    const depositAmount = this.getDepositForPackage(await this.getPackageForDeposit(draft.service || ''));
    if (expectedDeposit === null || expectedDeposit !== depositAmount) {
      throw new Error('The package deposit no longer matches the amount in the customer-visible proposal. Do not start payment; prepare a new proposal and ask for confirmation again.');
    }

    await bookingDraftService.markPaymentPending(customerId);

    // Initiate M-Pesa STK Push using draft ID as reference
    let mpesaResponse: any;
    try {
      mpesaResponse = await mpesaService.initiateStkPush(customerId, depositAmount, draft.id);
    } catch (error: any) {
      console.error('Failed to initiate M-Pesa STK Push:', error);
      // No prompt reached the phone, so put the draft back where the customer can confirm again.
      await prisma.bookingDraft.update({
        where: { customerId },
        data: { step: 'awaiting_confirmation' },
      }).catch((restoreError) => console.error('Failed to restore booking draft after STK push failure:', restoreError));
      throw new Error(`We couldn't initiate the payment request. Error: ${error.message}`);
    }

    try {
      // Upsert payment record linked to the draft
      await prisma.payment.upsert({
        where: { bookingDraftId: draft.id },
        update: {
          amount: depositAmount,
          status: 'pending',
          checkoutRequestId: mpesaResponse.CheckoutRequestID,
          updatedAt: new Date()
        },
        create: {
          bookingDraftId: draft.id,
          amount: depositAmount,
          phone: customerId,
          status: 'pending',
          checkoutRequestId: mpesaResponse.CheckoutRequestID
        }
      });

      return {
        success: true,
        draftId: draft.id,
        depositAmount: depositAmount,
        service: draft.service,
        date: draft.date,
        time: draft.time,
        checkoutRequestId: mpesaResponse.CheckoutRequestID
      };
    } catch (error: any) {
      console.error('Failed to record M-Pesa payment after STK Push:', error);
      throw Object.assign(
        new Error(`An M-Pesa prompt may already have been sent to the customer's phone, but it could not be recorded (${error.message}). Do not send another prompt; ask the customer to check their phone first.`),
        { code: PAYMENT_PROMPT_UNRECORDED }
      );
    }
  }

  private async getPackageForDeposit(packageName?: string): Promise<{ name: string; deposit: number | null } | null> {
    if (!packageName) {
      return prisma.package.findFirst({
        orderBy: { deposit: 'asc' },
        select: { name: true, deposit: true },
      });
    }

    const normalizedName = packageName.trim().toLowerCase().replace(/\s+(?:package|edition)$/i, '');
    const canonicalName = PACKAGE_NAMES_FOR_EXTRACTION.find((name) => {
      const normalizedPackageName = name.toLowerCase();
      return normalizedPackageName === normalizedName
        || normalizedPackageName.replace(/^the\s+/, '') === normalizedName;
    }) || packageName.trim();
    return prisma.package.findUnique({
      where: { name: canonicalName },
      select: { name: true, deposit: true },
    });
  }

  private getDepositForPackage(pkg: { name: string; deposit: number | null } | null | undefined): number {
    if (!pkg) {
      throw new Error('No package deposit is configured. Ask the studio team to confirm the amount.');
    }

    const depositAmount: unknown = pkg.deposit;
    const isProductionMpesa = (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase() === 'production';
    if (typeof depositAmount !== 'number' || !Number.isInteger(depositAmount) || depositAmount < 1) {
      throw new Error(`The configured deposit for ${pkg.name} is missing or invalid. Do not quote or initiate payment; ask the studio team to correct package pricing.`);
    }
    if (isProductionMpesa && depositAmount < MINIMUM_BOOKING_DEPOSIT) {
      throw new Error(`The configured booking deposit is below the KSh ${MINIMUM_BOOKING_DEPOSIT.toLocaleString()} minimum. Do not initiate payment; ask the studio team to correct package pricing.`);
    }
    return depositAmount;
  }

  /**
   * Step 1 of 2 for rescheduling: validates there's an upcoming confirmed
   * booking and saves the proposed new date/time on the customer's
   * BookingDraft. Does NOT touch the real booking yet.
   */
  private async executeProposeRescheduleTool(customerId: string, newDate: string, newTime: string) {
    const upcomingBooking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' }
    });

    if (!upcomingBooking) {
      throw new Error('No upcoming confirmed booking found to reschedule.');
    }

    // Verify the proposed new slot is actually free before proposing it - this
    // can't be left to the model remembering to call get_available_slots first.
    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => upcomingBooking.service.toLowerCase().includes(k));
    const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
    const slotsResult: any = await bookingService.getAvailableSlots(newDate, duration, upcomingBooking.id);

    // Spell out the weekday so the model never has to infer it from the raw ISO date.
    const newDateLabel = `${dayjs(newDate).format('dddd, MMMM D, YYYY')} (${newDate})`;

    if (slotsResult.status === 'closed') {
      throw new Error(`We're closed on ${newDateLabel} (${slotsResult.reason}). Ask the customer to pick a different date. Always refer to the date using this exact weekday.`);
    }
    const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(newTime)) {
      throw new Error(`${newTime} on ${newDateLabel} isn't available. Available times that day: ${availableSlots.length > 0 ? availableSlots.join(', ') : 'none'}. Ask the customer to pick one of these instead. Always refer to the date using this exact weekday - do not guess it.`);
    }

    const [hour, minute] = newTime.split(':').map(Number);
    const newDateTimeIso = businessDay(newDate)
      .startOf('day')
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0)
      .toISOString();

    await prisma.bookingDraft.upsert({
      where: { customerId },
      update: {
        bookingId: upcomingBooking.id,
        service: upcomingBooking.service,
        date: newDate,
        time: newTime,
        dateTimeIso: newDateTimeIso,
        step: 'reschedule_confirm'
      },
      create: {
        customerId,
        bookingId: upcomingBooking.id,
        service: upcomingBooking.service,
        date: newDate,
        time: newTime,
        dateTimeIso: newDateTimeIso,
        step: 'reschedule_confirm'
      }
    });

    return {
      service: upcomingBooking.service,
      oldDateTime: upcomingBooking.dateTime,
    };
  }

  /**
   * Step 2 of 2: applies the reschedule for real. Only proceeds if
   * initialDraftStep (captured at the START of this turn) was already
   * 'reschedule_confirm' - meaning propose_reschedule happened on a PRIOR
   * message, not earlier in this same turn.
   */
  private async executeConfirmRescheduleTool(customerId: string, initialDraftStep: string | undefined) {
    if (initialDraftStep !== 'reschedule_confirm') {
      throw new Error('No pending reschedule proposal from a prior message. Call propose_reschedule first and wait for the customer to explicitly confirm on their own next message.');
    }

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (!draft || draft.step !== 'reschedule_confirm' || !draft.bookingId || !draft.dateTimeIso) {
      throw new Error('No pending reschedule proposal found. Call propose_reschedule first.');
    }

    const upcomingBooking = await prisma.booking.findUnique({
      where: { id: draft.bookingId },
      include: { customer: true }
    });
    if (!upcomingBooking) {
      throw new Error('The booking being rescheduled no longer exists.');
    }

    const newDateTime = new Date(draft.dateTimeIso);

    await prisma.booking.update({
      where: { id: upcomingBooking.id },
      data: { dateTime: newDateTime }
    });

    if (upcomingBooking.googleEventId) {
      const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => upcomingBooking.service.toLowerCase().includes(k));
      const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;

      void googleCalendarService.updateEvent(upcomingBooking.googleEventId, {
        service: upcomingBooking.service,
        dateTime: newDateTime,
        customerName: upcomingBooking.customer.name,
        durationMinutes: duration
      }).then((updated) => {
        if (!updated) {
          void this.notifyRescheduleAdmin({
            customerId,
            event: 'failed',
            service: upcomingBooking.service,
            newDate: draft.date || undefined,
            newTime: draft.time || undefined,
            reason: 'The booking was rescheduled, but Google Calendar did not update.',
          });
        }
      }).catch((error) => {
        console.error('Google Calendar reschedule sync failed:', error);
      });
    }

    await prisma.bookingDraft.delete({ where: { customerId } }).catch(err => console.error('Failed to clear reschedule draft:', err));

    return {
      newDateTime,
      oldDateTime: upcomingBooking.dateTime,
      service: upcomingBooking.service,
      depositForfeited: this.isRescheduleWithin72Hours(upcomingBooking.dateTime),
    };
  }

  /**
   * Cancels the next upcoming confirmed booking and removes its Google
   * Calendar event if linked.
   */
  private async executeConfirmCancellationTool(customerId: string, initialDraftStep: string | undefined) {
    if (initialDraftStep !== 'cancel_confirm') {
      throw new Error('No pending cancellation proposal from a prior message. Ask which booking to cancel, propose it, and wait for the customer to explicitly confirm on their own next message.');
    }

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (!draft || draft.step !== 'cancel_confirm' || !draft.bookingId || !draft.date) {
      throw new Error('No pending cancellation proposal found. Ask which booking to cancel and propose it first.');
    }
    if (this.isCancellationProposalExpired(draft)) {
      await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
      throw new Error('The cancellation proposal expired. Nothing was cancelled; ask the customer to make a new cancellation request.');
    }

    return this.executeCancelBookingTool(customerId, draft.date, draft.bookingId);
  }

  private getCancellationCompletionReply(result: {
    service: string;
    dateTime: Date;
    refundEligible: boolean;
    depositPaid?: boolean;
  }): string {
    const session = `${result.service} on ${inBusinessTimezone(result.dateTime).format('dddd, D MMMM YYYY [at] h:mm A')}`;
    if (result.refundEligible) {
      const refundStatus = result.depositPaid
        ? 'A successful deposit is recorded. The studio team has been notified to review any refund; no refund has been issued.'
        : 'This is eligibility under the timing policy only; it does not confirm a refund amount or that money has been returned.';
      return `Your ${session} has been cancelled. It was eligible under the more-than-72-hours refund policy. ${refundStatus}`;
    }

    const refundStatus = result.depositPaid
      ? 'A successful deposit is recorded. The studio team has been notified to review the payment; no refund has been issued.'
      : 'It is not automatically refundable under the timing policy.';
    return `Your ${session} has been cancelled. It was 72 hours away or less. ${refundStatus}`;
  }

  private async executeCancelBookingTool(customerId: string, date?: string, bookingId?: string) {
    const upcoming = await prisma.booking.findMany({
      where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' }
    });

    if (upcoming.length === 0) {
      throw new Error('No upcoming booking found to cancel.');
    }

    const describe = (b: { service: string; dateTime: Date }) =>
      `${b.service} on ${inBusinessTimezone(b.dateTime).format('YYYY-MM-DD h:mm A')}`;
    const requestedDate = date?.trim();
    const matches = bookingId
      ? upcoming.filter((booking) => booking.id === bookingId)
      : requestedDate
        ? upcoming.filter((booking) => inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD') === requestedDate)
        : upcoming;

    if (matches.length === 0) {
      throw new Error(`No upcoming booking on ${requestedDate}. Upcoming bookings: ${upcoming.map(describe).join('; ')}. Ask the customer which one to cancel.`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple upcoming bookings match: ${matches.map(describe).join('; ')}. Nothing was cancelled - ask the customer which one to cancel, then call cancel_booking with that date.`);
    }

    const booking = matches[0];
    const successfulPayment = await prisma.payment.findFirst({
      where: { bookingId: booking.id, status: 'success' },
      orderBy: { updatedAt: 'desc' },
      select: { amount: true, mpesaReceipt: true },
    });
    let calendarEventRemoved = !booking.googleEventId;
    if (booking.googleEventId) {
      calendarEventRemoved = await googleCalendarService.deleteEvent(booking.googleEventId);
      if (!calendarEventRemoved) {
        console.warn('Google Calendar delete failed during cancellation:', booking.googleEventId);
      }
    }

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        // Keep the id when deletion failed so the stale calendar event can still be found and removed.
        ...(calendarEventRemoved ? { googleEventId: null } : {}),
      }
    });

    await prisma.bookingDraft.deleteMany({ where: { customerId } });

    const refundEligible = getBookingPolicyWindow(booking.dateTime).cancellationRefundEligible;

    await notifyAdmin(
      'booking',
      `Booking cancelled for ${customerId}`,
      `${booking.service} on ${dayjs(booking.dateTime).format('YYYY-MM-DD HH:mm')} was cancelled via AI assistant. ${successfulPayment ? `A successful deposit of KSh ${successfulPayment.amount.toLocaleString()} is recorded${successfulPayment.mpesaReceipt ? ` (M-Pesa receipt ${successfulPayment.mpesaReceipt})` : ''}. Studio team: manual refund review is required; no refund was issued by the assistant.` : 'No successful deposit is recorded.'}`,
      {
        customerId,
        event: 'cancel_confirmed',
        bookingId: booking.id,
        service: booking.service,
        dateTime: booking.dateTime.toISOString(),
        refundEligible,
        successfulDepositRecorded: Boolean(successfulPayment),
        depositAmount: successfulPayment?.amount,
        mpesaReceipt: successfulPayment?.mpesaReceipt,
        manualRefundReviewRequired: Boolean(successfulPayment),
        refundReviewOwner: successfulPayment ? 'studio_team' : undefined,
      }
    );

    return {
      bookingId: booking.id,
      service: booking.service,
      dateTime: booking.dateTime,
      refundEligible,
      depositPaid: Boolean(successfulPayment),
    };
  }

  private isPlaceholderContactEmail(email?: string | null): boolean {
    if (!email) return true;
    const value = email.trim().toLowerCase();
    if (!value) return true;
    return value.endsWith('@whatsapp.local') || value.endsWith('@messenger.local') || value.endsWith('@instagram.local');
  }

  /**
   * Saves customer's preferred edited-photo delivery method (especially email)
   * and emits an admin notification so the team can follow through.
   */
  private async executeSaveDeliveryPreferenceTool(
    customerId: string,
    method: 'email' | 'download_link' | 'whatsapp',
    email?: string,
    whatsappNumber?: string,
    note?: string,
    platform?: string,
  ) {
    const normalizedMethod = (method || '').toLowerCase();
    if (!['email', 'download_link', 'whatsapp'].includes(normalizedMethod)) {
      throw new Error('Invalid delivery method. Use email, download_link, or whatsapp.');
    }

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw new Error('Customer not found while saving delivery preference.');
    }

    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedWhatsappNumber = whatsappNumber?.trim();
    const emailFromCustomer = this.isPlaceholderContactEmail(customer.email) ? undefined : customer.email?.trim().toLowerCase();
    const resolvedEmail = normalizedEmail || emailFromCustomer;
    const resolvedWhatsappNumber = normalizedWhatsappNumber || customer.phone || customerId;

    if (normalizedMethod === 'email') {
      if (!resolvedEmail) {
        throw new Error('Email delivery requested but no email address is on file. Ask the customer for their exact email address first.');
      }
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(resolvedEmail)) {
        throw new Error('The provided email format looks invalid. Ask the customer to confirm the exact email address.');
      }

      if (customer.email !== resolvedEmail) {
        await prisma.customer.update({ where: { id: customerId }, data: { email: resolvedEmail } });
      }
    }

    const booking = await prisma.booking.findFirst({
      where: { customerId, dateTime: { gte: new Date() }, status: { not: 'cancelled' } },
      orderBy: { dateTime: 'asc' }
    });

    const description = [
      `Delivery preference: ${normalizedMethod}`,
      normalizedMethod === 'email' && resolvedEmail ? `Email: ${resolvedEmail}` : '',
      normalizedMethod === 'whatsapp' && resolvedWhatsappNumber ? `WhatsApp: ${resolvedWhatsappNumber}` : '',
      note ? `Note: ${note}` : ''
    ].filter(Boolean).join(' | ');

    await prisma.customerSessionNote.create({
      data: {
        customerId,
        bookingId: booking?.id,
        type: 'special_request',
        description,
        status: 'pending',
        platform: platform || 'whatsapp',
        sourceMessage: note?.trim() || undefined,
      }
    });

    await notifyAdmin(
      'booking',
      `Delivery preference captured for ${customerId}`,
      `${customer.name || customerId} prefers ${normalizedMethod}${normalizedMethod === 'email' && resolvedEmail ? ` via ${resolvedEmail}` : ''}${normalizedMethod === 'whatsapp' && resolvedWhatsappNumber ? ` via ${resolvedWhatsappNumber}` : ''}.`,
      {
        customerId,
        bookingId: booking?.id,
        event: 'delivery_preference',
        deliveryMethod: normalizedMethod,
        deliveryEmail: normalizedMethod === 'email' ? resolvedEmail : undefined,
        deliveryPhone: normalizedMethod === 'whatsapp' ? resolvedWhatsappNumber : undefined,
      }
    );

    return {
      method: normalizedMethod,
      email: normalizedMethod === 'email' ? resolvedEmail : undefined,
      whatsappNumber: normalizedMethod === 'whatsapp' ? resolvedWhatsappNumber : undefined,
    };
  }

  /**
   * Logic to save a note for a customer session
   */
  extractSessionNoteMetadata(note: string, type?: string, category?: string, priority?: string): {
    normalizedType: string;
    category: string;
    priority: string;
    tags: string[];
    details: {
      addOns: string[];
      companions: string[];
      accessibilityNeeds: string[];
      stylingRequests: string[];
      deliveryPreferences: string[];
    };
  } {
    const rawNote = (note || '').trim();
    const lower = rawNote.toLowerCase();

    const addOns: string[] = [];
    for (const item of ADDON_CATALOG) {
      if (item.match.test(rawNote)) {
        const itemName = item.name;
        if (!addOns.includes(itemName)) {
          addOns.push(itemName);
        }
      }
    }

    const companions = Array.from(new Set(
      ['husband', 'wife', 'partner', 'sister', 'brother', 'mother', 'father', 'friend', 'child', 'children', 'family', 'mother-in-law', 'father-in-law', 'relative']
        .filter((word) => lower.includes(word))
        .map((word) => word.replace(/-in-law/g, ''))
    ));

    const accessibilityNeeds = Array.from(new Set(
      (['wheelchair', 'mobility', 'accessible', 'accessibility', 'medical', 'allerg', 'injur', 'pregnant'] as const)
        .filter((word) => lower.includes(word))
        .map((word) => word === 'pregnant' ? 'pregnancy-related need' : word)
    ));

    const stylingRequests = Array.from(new Set(
      (['wig', 'makeup', 'hair', 'outfit', 'gown', 'backdrop', 'theme', 'colour', 'color'] as const)
        .filter((word) => lower.includes(word))
        .map((word) => word === 'colour' || word === 'color' ? 'colour/theme request' : word)
    ));

    const deliveryPreferences = Array.from(new Set(
      (['email', 'whatsapp', 'download link', 'delivery', 'secure link'] as const)
        .filter((word) => lower.includes(word))
    ));

    const highlightTags = new Set<string>();
    if (addOns.length > 0) highlightTags.add('addon');
    if (companions.length > 0) highlightTags.add('companion');
    if (accessibilityNeeds.length > 0) highlightTags.add('accessibility');
    if (stylingRequests.length > 0) highlightTags.add('styling');
    if (deliveryPreferences.length > 0) highlightTags.add('delivery');

    let normalizedType = (type || 'other').trim().toLowerCase();
    if (normalizedType === 'other') {
      if (/(list of services|service list|show.*services|send.*services|package list|pricing)/i.test(rawNote)) {
        normalizedType = 'action_request';
      } else if (/(delivery preference|download link|email.*link|whatsapp.*link|thank.*for.*photo|send.*photos?)/i.test(rawNote)) {
        normalizedType = 'special_request';
      } else if (highlightTags.size > 0 || addOns.length > 0 || companions.length > 0 || accessibilityNeeds.length > 0) {
        normalizedType = 'special_request';
      }
    }

    let categoryValue = ['client_wish', 'operational', 'addon', 'accessibility', 'companion', 'styling', 'delivery', 'other'].includes(category || '')
      ? category!
      : addOns.length > 0
        ? 'addon'
        : accessibilityNeeds.length > 0
          ? 'accessibility'
          : companions.length > 0
            ? 'companion'
            : stylingRequests.length > 0
              ? 'styling'
              : deliveryPreferences.length > 0
                ? 'delivery'
                : normalizedType === 'action_request'
                  ? 'operational'
                  : 'client_wish';

    const prioritySignals = /(urgent|asap|must|important|allerg|medical|mobility|wheelchair|emergency|cannot|can't|need.*soon)/i;
    let priorityValue = ['normal', 'high', 'urgent'].includes(priority || '')
      ? priority!
      : prioritySignals.test(rawNote) || accessibilityNeeds.length > 0 || (companions.length > 0 && addOns.length > 0)
        ? 'high'
        : 'normal';

    const tags = Array.from(highlightTags);
    return {
      normalizedType,
      category: categoryValue,
      priority: priorityValue,
      tags,
      details: {
        addOns,
        companions,
        accessibilityNeeds,
        stylingRequests,
        deliveryPreferences,
      },
    };
  }

  private async executeAddNoteTool(
    customerId: string,
    bookingDate: string,
    note: string,
    type: string,
    category?: string,
    priority?: string,
    sourceMessage?: string,
    platform?: string
  ): Promise<{ created: boolean; reason?: string; type?: string }> {
    const rawNote = (note || '').trim();
    if (!rawNote) {
      return { created: false, reason: 'empty_note' };
    }

    const normalized = rawNote.toLowerCase();
    const nonActionablePatterns = [
      /^no special requests? mentioned$/,
      /^no special requests?$/,
      /^no requests?$/,
      /^none$/,
      /^n\/a$/,
    ];
    if (nonActionablePatterns.some((pattern) => pattern.test(normalized))) {
      return { created: false, reason: 'non_actionable_note' };
    }

    const metadata = this.extractSessionNoteMetadata(rawNote, type, category, priority);
    const normalizedType = metadata.normalizedType;
    const normalizedCategory = metadata.category;
    const normalizedPriority = metadata.priority;

    const duplicateWindowStart = dayjs().subtract(24, 'hour').toDate();
    const duplicate = await prisma.customerSessionNote.findFirst({
      where: {
        customerId,
        status: 'pending',
        type: normalizedType,
        description: rawNote,
        createdAt: { gte: duplicateWindowStart },
      },
      select: { id: true },
    });
    if (duplicate) {
      return { created: false, reason: 'duplicate_pending_note', type: normalizedType };
    }

    // Customers often mention session details ("bringing family") before they've
    // confirmed a booking date at all - the AI still calls this tool, but with no
    // real date to work with (empty string, "unknown", etc). new Date() on that
    // silently produces an Invalid Date, which Prisma then throws on. Validate
    // first, and fall back to the nearest upcoming booking when there's no
    // usable date, so the note still lands somewhere instead of crashing the tool call.
    const parsedDate = bookingDate ? dayjs(bookingDate) : null;
    const bookingOnDate = parsedDate?.isValid()
      ? await prisma.booking.findFirst({
          where: {
            customerId: customerId,
            status: { not: 'cancelled' },
            dateTime: {
              gte: parsedDate.startOf('day').toDate(),
              lte: parsedDate.endOf('day').toDate()
            }
          }
        })
      : null;
    const booking = bookingOnDate ?? await prisma.booking.findFirst({
      where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' }
    });

    const createdNote = await prisma.customerSessionNote.create({
      data: {
        customerId: customerId,
        bookingId: booking?.id,
        description: rawNote,
        type: normalizedType,
        status: 'pending',
        category: normalizedCategory,
        priority: normalizedPriority,
        actionStatus: 'open',
        structuredData: {
          tags: metadata.tags,
          details: metadata.details,
          originalType: type || 'other',
          originalCategory: category || null,
          originalPriority: priority || null,
        },
        sourceMessage,
        platform,
      }
    });

    // Persist matched add-ons as priced line items (not only free-text notes)
    await bookingAddonService.createFromNote({
      customerId,
      bookingId: booking?.id,
      note: rawNote,
      sessionNoteId: createdNote.id,
    });

    if (normalizedType === 'action_request' || normalizedType === 'special_request') {
      await notifyAdmin(
        'booking',
        `Session note requires review for ${customerId}`,
        `${rawNote}${booking ? ` (Booking: ${booking.service} on ${dayjs(booking.dateTime).format('YYYY-MM-DD HH:mm')})` : ''}`,
        {
          customerId,
          bookingId: booking?.id,
          sessionNoteId: createdNote.id,
          noteType: normalizedType,
          event: 'session_note_review_required',
        }
      );
    }

    return { created: true, type: normalizedType };
  }
}

export const agentService = new AgentService();

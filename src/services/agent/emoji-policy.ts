import prisma from '../../config/prisma';

export const REPLY_EMOJI = {
  welcome: '\u{1F90D}',
  packageChosen: '\u{1F930}',
  slotAvailable: '\u{1F4C5}',
  paymentConfirmed: '\u2705',
  location: '\u{1F4CD}',
  reminder: '\u{1F4F8}',
  family: '\u{1F380}',
  closing: '\u{1F90D}',
} as const;

export type EmojiReplyType = keyof typeof REPLY_EMOJI | 'other';
export const EMOJI_POLICY = { maximum: 1, greetingClosingMaximum: 2, maximumReplyLength: 4096 } as const;
export const EMOJI_WHITELIST: readonly string[] = [...new Set(Object.values(REPLY_EMOJI))];
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiPattern = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}|\u20e3/u;

export type EmojiContext = {
  replyType?: EmojiReplyType;
  userMessage?: string;
  sentimentScore?: number;
  previousAssistant?: string;
  forbidden?: boolean;
  mode?: 'model' | 'template';
  log?: (reason: string) => void;
};

export function emojisIn(text: string): string[] {
  return [...segmenter.segment(text)].map(value => value.segment).filter(value => emojiPattern.test(value));
}

export function stripEmojis(text: string): string {
  return [...segmenter.segment(text)].filter(value => !emojiPattern.test(value.segment)).map(value => value.segment).join('');
}

export function stripAssistantEmojis<Message extends { role: string; content: string }>(history: Message[]): Message[] {
  return history.map(message => message.role === 'assistant' ? { ...message, content: stripEmojis(message.content) } : message);
}

export function emojiForbiddenReason(reply: string, context: EmojiContext): string | null {
  if (context.forbidden) return 'protected_context';
  if ((context.sentimentScore ?? 0) < 0) return 'negative_sentiment';
  if (/\b(?:kshs?|kes|shs|usd|prices?|pricing|costs?|fees?|deposits?|balances?|invoices?|receipts?)\b|[$\u20ac\u00a3]/i.test(reply)) return 'financial';
  if (/\b(?:fail\w*|cancel\w*|refund\w*|complaints?|escalat\w*|sorry|could not|couldn't|unable|not received)\b/i.test(reply)) return 'failure_or_handoff';
  if (/\b(?:team|studio|member of (?:our|the) team)\b[\s\S]{0,80}\b(?:confirm|verify|check|help|pick this up|contact)\b/i.test(reply)) return 'team_confirmation';
  const replyType = context.replyType || 'other';
  if (!emojisIn(context.userMessage || '').length && !['welcome', 'closing', 'paymentConfirmed', 'slotAvailable'].includes(replyType)) return 'formal_tone';
  return null;
}

export function applyEmojiPolicy(reply: string, context: EmojiContext = {}): string {
  const segments = [...segmenter.segment(reply)];
  const found = segments.filter(value => emojiPattern.test(value.segment));
  if (!found.length) return reply;
  const reasons = new Set<string>();
  const forbidden = emojiForbiddenReason(reply, context);
  const maximum = ['welcome', 'closing'].includes(context.replyType || '') ? EMOJI_POLICY.greetingClosingMaximum : EMOJI_POLICY.maximum;
  const previous = new Set(emojisIn(context.previousAssistant || ''));
  let kept = 0;
  const used = new Set<string>();
  const result = segments.map(value => {
    if (!emojiPattern.test(value.segment)) return value.segment;
    let reason = forbidden;
    if (!reason && !EMOJI_WHITELIST.includes(value.segment)) reason = 'not_whitelisted';
    const before = reply.slice(0, value.index).trimEnd();
    const after = reply.slice(value.index + value.segment.length);
    const priorEmoji = emojiPattern.test([...segmenter.segment(before)].at(-1)?.segment || '');
    const lineEnd = /^\s*(?:\n|$)/.test(after) || !stripEmojis(after).trim();
    const sentenceEnd = /[.!?]$/.test(before) && (lineEnd || /^\s+[A-Z]/.test(after));
    if (!reason && (!before || priorEmoji || (!sentenceEnd && !lineEnd))) reason = 'placement';
    if (!reason && (kept >= maximum || used.has(value.segment))) reason = 'maximum';
    if (!reason && previous.has(value.segment)) reason = 'consecutive_repeat';
    if (reason) { reasons.add(reason); return ''; }
    used.add(value.segment); kept++;
    return ` ${value.segment}`;
  }).join('').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  if (result.length > EMOJI_POLICY.maximumReplyLength) {
    reasons.add('length');
    kept = 0;
  }
  for (const reason of reasons) (context.log || (value => console.info(`[AGENT_FLOW] emoji=stripped reason=${value}`)))(reason);
  return kept ? result : stripEmojis(result).replace(/[ \t]{2,}/g, ' ').trim();
}

export function templateEmojiReply(reply: string, replyType: EmojiReplyType, context: EmojiContext = {}): string {
  if (replyType === 'other' || emojiForbiddenReason(reply, { ...context, replyType })) return reply;
  const emoji = REPLY_EMOJI[replyType];
  const sentence = reply.match(/[.!?](?=\s|$)/);
  if (!sentence || sentence.index === undefined) return reply;
  const end = sentence.index + 1;
  return applyEmojiPolicy(`${reply.slice(0, end)} ${emoji}${reply.slice(end)}`, { ...context, replyType, mode: 'template' });
}

export function emojiReplyType(reply: string): EmojiReplyType {
  if (/\b(?:payment received|payment succeeded|deposit has been paid)\b/i.test(reply)) return 'paymentConfirmed';
  if (/\b(?:welcome|hello|hi)\b/i.test(reply)) return 'welcome';
  if (/\b(?:you are welcome|you're welcome|thank you|thanks|looking forward)\b/i.test(reply)) return 'closing';
  if (/\b(?:available|is open)\b/i.test(reply) && /\b(?:am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(reply)) return 'slotAvailable';
  return 'other';
}

export async function enforceEmojiPolicy(customerId: string, platform: string, reply: string, context: EmojiContext): Promise<string> {
  let result = applyEmojiPolicy(reply, context);
  if (!emojisIn(result).length) return result;
  const suppress = (reason: string) => applyEmojiPolicy(result, { ...context, forbidden: true,
    log: () => console.info(`[AGENT_FLOW] emoji=stripped reason=${reason}`) });
  try {
    const session = await prisma.unifiedConversation.findFirst({
      where: { customerId, endedAt: null, OR: [{ primaryChannel: platform }, { channels: { has: platform } }] },
      orderBy: { lastActivityAt: 'desc' }, select: { sessionId: true, startedAt: true },
    });
    const latest = await prisma.message.findFirst({
      where: { customerId, platform, direction: 'outbound', ...(session ? { createdAt: { gte: session.startedAt } } : {}) },
      orderBy: { createdAt: 'desc' }, select: { id: true, content: true },
    });
    result = applyEmojiPolicy(result, { ...context, previousAssistant: latest?.content || context.previousAssistant });
    if (!emojisIn(result).length) return result;
    const prefix = `system:emoji-last:v1:${encodeURIComponent(session?.sessionId || `thread:${platform}`)}:`;
    await prisma.customerMemory.upsert({ where: { customerId }, update: {}, create: { customerId } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const memory = await prisma.customerMemory.findUnique({ where: { customerId }, select: { keyInsights: true } });
      if (!memory) return suppress('state_unavailable');
      const prior = memory.keyInsights.find(value => value.startsWith(prefix));
      if (prior) {
        const state = JSON.parse(prior.slice(prefix.length)) as { priorMessageId: string | null; emojis: string[] };
        if (state.priorMessageId === (latest?.id || null)) {
          result = applyEmojiPolicy(result, { ...context, previousAssistant: state.emojis.join(' ') });
          if (!emojisIn(result).length) return result;
        }
      }
      const marker = prefix + JSON.stringify({ priorMessageId: latest?.id || null, emojis: emojisIn(result) });
      const claimed = await prisma.customerMemory.updateMany({
        where: { customerId, keyInsights: { equals: memory.keyInsights } },
        data: { keyInsights: { set: [...memory.keyInsights.filter(value => !value.startsWith(prefix)), marker] } },
      });
      if (claimed.count === 1) return result;
    }
    return suppress('state_conflict');
  } catch {
    return suppress('state_unavailable');
  }
}
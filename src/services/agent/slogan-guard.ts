import prisma from '../../config/prisma';
import { BRAND_SLOGAN } from './constants';

const sloganStem = BRAND_SLOGAN.replace(/\.$/, '');
const sloganWords = sloganStem.split(/\s+/).join('\\s+');
const sloganPattern = new RegExp(`(?:["'\\u201c\\u201d]\\s*)?${sloganWords}\\.?["'\\u201c\\u201d]*[.,;:!?]*`, 'gi');

export function normalizeSlogan(reply: string): string {
  return reply.replace(sloganPattern, BRAND_SLOGAN).replace(/[ \t]+\n/g, '\n').trim();
}

export function containsSlogan(reply: string): boolean {
  return new RegExp(sloganWords, 'i').test(reply);
}

export function sloganForbidden(reply: string): boolean {
  return /\d|\b(?:kshs?|kes|shs|price|cost|fee|deposit|payment|paid|date|booking|policy|policies|hours|working days|refund|cancel|reschedule|available|availability|edition|package|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|partner|husband|children|poses|privacy|delivery|download|files|makeup|closed)\b/i.test(reply)
    || !/\b(?:welcome|hello|hi|goodbye|thank you|thanks|looking forward|you're welcome)\b/i.test(reply);
}

function withoutSlogan(reply: string): string {
  return reply.replace(sloganPattern, '').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()
    || 'Welcome to Fiesta House Maternity.';
}

export async function enforceSlogan(
  customerId: string,
  platform: string,
  reply: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): Promise<string> {
  if (!containsSlogan(reply)) return reply;
  const normalized = normalizeSlogan(reply);
  if (sloganForbidden(normalized)) return withoutSlogan(normalized);
  try {
    const session = await prisma.unifiedConversation.findFirst({
      where: { customerId, endedAt: null, OR: [{ primaryChannel: platform }, { channels: { has: platform } }] },
      orderBy: { lastActivityAt: 'desc' }, select: { sessionId: true, startedAt: true },
    });
    const marker = `system:brand-slogan-used:v1:${session?.sessionId || `thread:${platform}`}`;
    const alreadyVisible = history.some((entry) => entry.role === 'assistant' && containsSlogan(entry.content));
    const prior = alreadyVisible ? true : await prisma.message.findFirst({
      where: { customerId, platform, direction: 'outbound', content: { contains: sloganStem, mode: 'insensitive' },
        ...(session ? { createdAt: { gte: session.startedAt } } : {}) }, select: { id: true },
    });
    await prisma.customerMemory.upsert({ where: { customerId }, update: {}, create: { customerId } });
    const claim = await prisma.customerMemory.updateMany({
      where: { customerId, NOT: { keyInsights: { has: marker } } }, data: { keyInsights: { push: marker } },
    });
    if (prior || claim.count !== 1) return withoutSlogan(normalized);
    let included = false;
    return normalized.replace(new RegExp(sloganStem.replace(/\.$/, '') + '\\.', 'gi'), () => {
      if (included) return '';
      included = true;
      return BRAND_SLOGAN;
    }).replace(/ {2,}/g, ' ').trim();
  } catch {
    console.warn('[AGENT_FLOW] slogan=suppressed reason=state_unavailable');
    return withoutSlogan(normalized);
  }
}
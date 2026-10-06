import prisma from '../../config/prisma';
import { OFFICIAL_WEBSITE_URLS } from './constants';
import { stripAssistantEmojis } from './emoji-policy';

export type CatalogKind = 'editions' | 'addons';
export const CATALOG_LINK_TTL_MS = 24 * 60 * 60_000;
const markerPrefix = 'system:catalog-link:v1:';

export function explicitCatalogListRequest(message: string): boolean {
  return /\b(?:list|show|send|paste|write)\b.*\b(?:here|in (?:the )?chat|full list)\b|\b(?:link|page|website)\b.*\b(?:not|won't|wont|doesn't|does not|can't|cannot|broken|open|loading|working)\b|\b(?:can't|cannot|unable to)\b.*\b(?:open|access|load)\b/i.test(message);
}

export function catalogLinkFollowUp(message: string, history: { role: string; content: string }[]): boolean {
  history = stripAssistantEmojis(history);
  const previous = [...history].reverse().find(entry => entry.role === 'assistant');
  return Boolean(previous?.content.includes(OFFICIAL_WEBSITE_URLS.packages)) && explicitCatalogListRequest(message);
}

export async function claimCatalogLink(customerId: string, platform: string, kind: CatalogKind, history: { role: string; content: string }[]): Promise<boolean> {
  try {
    const session = await prisma.unifiedConversation.findFirst({
      where: { customerId, endedAt: null, OR: [{ primaryChannel: platform }, { channels: { has: platform } }] },
      orderBy: { lastActivityAt: 'desc' }, select: { sessionId: true },
    });
    const scope = `${markerPrefix}${encodeURIComponent(session?.sessionId || `thread:${platform}`)}:${kind}:`;
    await prisma.customerMemory.upsert({ where: { customerId }, update: {}, create: { customerId } });
    for (let attempt = 0; attempt < 3; attempt++) {
      const memory = await prisma.customerMemory.findUnique({ where: { customerId }, select: { keyInsights: true } });
      if (!memory) return true;
      const now = Date.now();
      const current = memory.keyInsights;
      if (current.some(marker => marker.startsWith(scope) && Number(marker.slice(scope.length)) > now)) return false;
      const retained = current.filter(marker => !marker.startsWith(markerPrefix) || Number(marker.split(':').at(-1)) > now);
      const claimed = await prisma.customerMemory.updateMany({
        where: { customerId, keyInsights: { equals: current } },
        data: { keyInsights: { set: [...retained, `${scope}${now + CATALOG_LINK_TTL_MS}`] } },
      });
      if (claimed.count === 1) return true;
    }
  } catch {
    console.warn('[AGENT_FLOW] catalog_link_state=unavailable');
  }
  return !history.some(entry => entry.role === 'assistant' && entry.content.includes(OFFICIAL_WEBSITE_URLS.packages)
    && (kind === 'addons' ? /extras|add-ons/i.test(entry.content) : /editions/i.test(entry.content)));
}
export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export class ConversationFlowMatcher {
  isPackageCatalogRequest(message: string): boolean {
    return /(what\s+packages|which\s+packages|package\s+list|list\s+of\s+services|services\s+do\s+you\s+offer|what\s+services\s+do\s+you\s+offer|show\s+me\s+packages|tell\s+me\s+about\s+(the\s+)?(packages|services)|packages?\s+(or|and)\s+services)/.test(message.toLowerCase());
  }

  isPackageAdviceRequest(message: string): boolean {
    const text = message.toLowerCase();
    const namesPackage = /(standard|economy|executive|gold|platinum|vvip|vip)\s+(package)?/.test(text);
    const asksForAdvice = /(recommend|which\s+(one|package)|best\s+package|should\s+i\s+(get|choose)|why.*over|compare|difference\s+between)/.test(text);
    return namesPackage && asksForAdvice || /(recommend|which\s+one|best\s+package|should\s+i\s+(get|choose))/.test(text);
  }

  isPackageSelection(message: string): boolean {
    return /(i\s+(like|want|choose|will take|would like)|i(?:'ll|\s+will)\s+(go with|take)|let'?s\s+(go with|do))\s+(the\s+)?(standard|economy|executive|gold|platinum|vip|vvip)(\s+package)?\b/.test(message.toLowerCase());
  }

  isSameBookingSlotRequest(message: string): boolean {
    return /\b(same|that)\s+(date\s+and\s+time|day\s+and\s+time|date|day|time)\b/.test(message.toLowerCase());
  }

  isTimeOnlyRescheduleRequest(message: string): boolean {
    const text = message.toLowerCase();
    return /(reschedule|change|move|shift)\s+(the\s+)?(time|appointment time|session time)|\bchange\s+my\s+time\b/.test(text)
      && !/(date|day|tomorrow|next\s+week|\d{4}-\d{2}-\d{2})/.test(text);
  }

  parseTimeOnly(message: string): string | null {
    const match = message.trim().toLowerCase().match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2] || '0');
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (match[3] === 'pm' && hour !== 12) hour += 12;
    if (match[3] === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  isTimeOnlyRescheduleSelection(message: string, history: ConversationMessage[]): boolean {
    if (!this.parseTimeOnly(message)) return false;
    const previousAssistantMessage = [...history].reverse().find((entry) => entry.role === 'assistant')?.content.toLowerCase() || '';
    return /what time.*work better|what new time|time would you like/.test(previousAssistantMessage);
  }

  isWeekdayRequest(message: string): boolean {
    return /(what|which)\s+day\s+of\s+(the\s+)?week.*\b\d{1,2}(st|nd|rd|th)?\b|what\s+day.*\b\d{1,2}(st|nd|rd|th)?\b/.test(message.toLowerCase());
  }

  isBusinessIntroductionRequest(message: string): boolean {
    return /(tell\s+me\s+about\s+(the\s+)?business|what\s+(is|does)\s+fiesta|about\s+fiesta\s+(house|attire)|who\s+are\s+you|what\s+(exactly\s+)?do\s+(you|you\s+people)\s+do|what\s+do\s+you\s+people\s+do)/.test(message.toLowerCase());
  }

  isWebsiteRequest(message: string): boolean {
    return /(what(?:'s|\s+is)\s+your\s+website|website.*(?:reach|find|visit|see)|(?:reach|find|visit|see).*website|your\s+site|web\s*site)/.test(message.toLowerCase());
  }

  isContactDetailsRequest(message: string): boolean {
    return /(contact\s+details|how\s+can\s+i\s+(contact|reach)\s+you|where\s+(are|is)\s+your\s+(studio|location)|your\s+(location|address)|address.*contact|contact.*(?:location|address))/.test(message.toLowerCase());
  }

  isPortfolioRequest(message: string): boolean {
    return /(portfolio|gallery|recent\s+shoots|sample\s+photos|see\s+your\s+work)/.test(message.toLowerCase());
  }
}

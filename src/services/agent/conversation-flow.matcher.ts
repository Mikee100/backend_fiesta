import { PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { EDITION_CATALOG_HEADER, EDITION_TERM_PATTERN } from './constants';

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const EDITION_WORDS = 'bloom|muse|icon|legend|queen|empress|goddess';
const SELECTION_VERB = /\b(?:give\s+me|i\s+want|i\s+would\s+(?:like|want)|i['’]?d\s+like|i\s+(?:choose|pick|select)|i(?:['’]ll|\s+will)\s+(?:take|have|go\s+with|choose|pick)|let['’]?s\s+(?:go\s+with|do|book)|go\s+with|take|choose|pick|select|book|interested\s+in)\b/i;
const BARE_EDITION = new RegExp(`^(?:(?:ok(?:ay)?|so|then|yes|please)[, ]+)?(?:the\\s+)?(?:${EDITION_WORDS})(?:\\s+(?:package|edition))?(?:[, ]+(?:please|pls|then))?[.! ]*$`, 'i');

/** Returns the edition when the message chooses exactly one edition; questions, detail requests and negations return null. */
export function selectedEdition(message: string): string | null {
  const text = message.trim();
  const named = PACKAGE_NAMES_FOR_EXTRACTION.filter((name) => new RegExp(`\\b${name.replace(/^THE /, '')}\\b`, 'i').test(text));
  if (named.length !== 1) return null;
  if (/\?|^\s*(?:what|which|how|why|can|could|do|does|is|are)\b/i.test(text)) return null;
  if (/\b(?:include[sd]?|inclusions?|details?|tell\s+me\s+about|compare|difference|vs|versus|recommend|price|cost|how\s+much|not|don['’]?t|dont|never|instead)\b/i.test(text)) return null;
  return SELECTION_VERB.test(text) || BARE_EDITION.test(text) ? named[0] : null;
}

export function isPlainGreeting(message: string): boolean {
  return /^\s*(?:hi+|hello+|hey+|hiya|helo|good\s+(?:morning|afternoon|evening|day)|habari(?:\s+yako)?|niaje|mambo|greetings)(?:\s+(?:there|team|fiesta(?:\s+house)?))?[\s!.,]*$/i.test(message);
}

export class ConversationFlowMatcher {
  isPackageCatalogRequest(message: string, history: ConversationMessage[] = []): boolean {
    const text = message.toLowerCase().trim();
    const namesEdition = PACKAGE_NAMES_FOR_EXTRACTION.some((name) => new RegExp(`\\b${name.replace(/^THE /, '')}\\b`, 'i').test(text));
    const editionQuestion = new RegExp(`\\b(?:what|which|share|show|list|tell)\\b.*\\b${EDITION_TERM_PATTERN}\\b|\\byour\\s+${EDITION_TERM_PATTERN}\\b`, 'i');
    const requestedDetail = namesEdition && /\b(?:include|includes|inclusions|come with|tell me about|details|how much|price|cost)\b/i.test(text);
    const editionNameOnly = PACKAGE_NAMES_FOR_EXTRACTION.some((name) => [name.toLowerCase(), name.replace(/^THE /, '').toLowerCase()].includes(text.replace(/[.!?]+$/, '')));
    const choosesFromOverview = editionNameOnly
      && history.some((entry) => entry.role === 'assistant' && entry.content.includes(EDITION_CATALOG_HEADER));
    if ((editionQuestion.test(text) && !this.isPackageAdviceRequest(message)) || requestedDetail || choosesFromOverview) return true;
    const explicitCatalogRequest = /(what\s+packages|which\s+packages|package\s+list|list\s+of\s+services|services\s+do\s+you\s+offer|what\s+services\s+do\s+you\s+offer|show\s+me\s+packages|tell\s+me\s+about\s+(the\s+)?(packages|services)|packages?\s+(or|and)\s+services|what\s+does\s+each\s+(package|edition)\s+(include|come\s+with))/i.test(text);
    const shareCatalogRequest = /\bshare\s+(?:the\s+)?packages\b|\bwhat\s+do\s+you\s+offer\b|\byour\s+editions\b/i.test(text);
    if (explicitCatalogRequest || shareCatalogRequest || this.isPackageInclusionFollowUp(message, history)) return true;

    const contextualFollowUp = /^(?:tell\s+me\s+about\s+(?:them|those)|what\s+about\s+(?:them|those)|can\s+you\s+tell\s+me\s+about\s+(?:them|those))\s*[?.!]*$/.test(text);
    if (!contextualFollowUp) return false;

    const recentAssistantMessages = history
      .filter((entry) => entry.role === 'assistant')
      .slice(-3);
    return recentAssistantMessages.some((entry) => /\bpackages?\b|\bservices?\b|\beditions\b/i.test(entry.content));
  }

  isPackageInclusionFollowUp(message: string, history: ConversationMessage[] = []): boolean {
    const text = message.toLowerCase().trim();
    const asksWhatEachIncludes = /^(?:so\s+)?what\s+(?:does|do)\s+each(?:\s+one)?\s+(?:come\s+with|include|includes)\s*[?.!]*$|^what\s+comes\s+with\s+each\s*[?.!]*$|^what(?:'s|\s+is)\s+included\s+(?:in|with)\s+each\s*[?.!]*$/.test(text);
    if (!asksWhatEachIncludes) return false;

    const recentAssistantMessages = history
      .filter((entry) => entry.role === 'assistant')
      .slice(-3)
      .map((entry) => entry.content.toLowerCase());
    const packageNamesMentioned = PACKAGE_NAMES_FOR_EXTRACTION
      .filter((name) => recentAssistantMessages.some((content) => content.includes(name.toLowerCase())));

    return packageNamesMentioned.length >= 2
      || recentAssistantMessages.some((content) => content.includes(EDITION_CATALOG_HEADER.toLowerCase()))
      || recentAssistantMessages.some((content) => /all (?:the )?(?:current )?(?:packages|editions)/.test(content));
  }

  isPackageAdviceRequest(message: string): boolean {
    const text = message.toLowerCase();
    const namesPackage = /(bloom|muse|icon|legend|queen|empress|goddess|standard|economy|executive|gold|platinum|vvip|vip)\s+(package|edition)?/.test(text);
    const asksForAdvice = /(recommend|which\s+(one|package|edition)|best\s+(package|edition)|should\s+i\s+(get|choose)|why.*over|compare|difference\s+between)/.test(text);
    return namesPackage && asksForAdvice || /(recommend|which\s+one|best\s+(package|edition)|should\s+i\s+(get|choose))/.test(text);
  }

  isPackageSelection(message: string): boolean {
    if (selectedEdition(message)) return true;
    return /(i\s+(like|want|choose|will take|would like|would want)|i(?:'ll|\s+will)\s+(go with|take)|let'?s\s+(go with|do))\s+(the\s+)?(bloom|muse|icon|legend|queen|empress|goddess|standard|economy|executive|gold|platinum|vip|vvip)(\s+(package|edition))?\b/.test(message.toLowerCase());
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

  /** The last assistant turn asked for a new date/time for an existing booking. */
  isRescheduleQuestion(history: ConversationMessage[]): boolean {
    const previousAssistantMessage = [...history].reverse().find((entry) => entry.role === 'assistant')?.content.toLowerCase() || '';
    return /what time.*work better|what new time|share your preferred date and time|what (?:new )?(?:date and time|date or time|day and time) would you like|(?:move|reschedule|push) your (?:session|booking|appointment|shoot) to|when would you like to (?:move|reschedule)/.test(previousAssistantMessage);
  }

  /** Accepts "5pm", "from 5:30 pm", "17:00" anywhere in the message. */
  parseCustomerTime(message: string): string | null {
    const text = message.toLowerCase();
    const meridiem = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (meridiem) return this.parseTimeOnly(`${meridiem[1]}${meridiem[2] ? `:${meridiem[2]}` : ''}${meridiem[3]}`);
    const clock = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    return clock ? `${clock[1].padStart(2, '0')}:${clock[2]}` : null;
  }

  isRescheduleSelection(message: string, history: ConversationMessage[]): boolean {
    return this.isRescheduleQuestion(history) && this.hasRescheduleSlotSignal(message);
  }

  hasRescheduleSlotSignal(message: string): boolean {
    if (this.parseCustomerTime(message)) return true;
    return /\b(?:same|that)\s+(?:day|date)\b|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(message);
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

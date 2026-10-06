import { ADDON_CATALOG, type AddonCatalogItem } from '../../config/constants';
import { SEED_EDITION_INCLUSIONS } from '../../config/edition-inclusions';
import { ADDON_MAKEUP_CLARIFICATION, ADDON_MULTI_CLARIFICATION, ADDON_QUOTED_PRICE_LABEL } from './constants';
import { normalizeQuotes } from './regex';
import { stripAssistantEmojis } from './emoji-policy';

type Message = { role: 'user' | 'assistant'; content: string };

const SHORT_ADDON_NAMES: Record<string, RegExp> = {
  extra_outfit: /\boutfits?\b/i,
  wig_hire: /\bwigs?\b/i,
  extra_makeup: /\bmake[-\s]?up\b/i,
  extra_edited_photo: /\bphotos?\b/i,
};

function declined(clause: string): boolean {
  return /\b(?:don't|do not|don't need|no|skip|without|remove|cancel|not)\b/i.test(clause);
}

function choiceClauses(message: string): string[] {
  return message.toLowerCase().replace(/’/g, "'").split(/[,;]|\band\b|\bplus\b|\bbut\b|(?=\b(?:just|instead)\b)/).filter((clause) => clause.trim() && !declined(clause));
}

function mentionedAddons(clause: string, allowShort: boolean): AddonCatalogItem[] {
  const matches = ADDON_CATALOG.filter((item) => item.match.test(clause));
  return matches.length || !allowShort ? matches
    : ADDON_CATALOG.filter((item) => SHORT_ADDON_NAMES[item.sku]?.test(clause));
}

export function isAddonInquiry(message: string): boolean {
  return /\?|\b(?:what if|can i|could i|how much|do you have|is it possible|would it|what does|what is)\b|\b(?:want|would like)\s+to\s+(?:know|ask|see|learn|understand)\b/i.test(message);
}

export function selectedAddons(message: string, history: Message[] = []): AddonCatalogItem[] {
  history = stripAssistantEmojis(history);
  if (isAddonInquiry(message)) return [];
  const text = message.toLowerCase().replace(/styles?\s+wig/g, 'styled wig');
  const lastAssistant = [...history].reverse().find((entry) => entry.role === 'assistant')?.content || '';
  if (!declined(text) && lastAssistant.includes(ADDON_MAKEUP_CLARIFICATION) && addonRecipient(text, 'extra_makeup')) {
    return ADDON_CATALOG.filter((item) => item.sku === 'extra_makeup');
  }
  const clauses = choiceClauses(text);
  const choosing = clauses.some((clause) => /\b(?:want|would like|add|include|choose|go with|take|prefer|just|instead|another|one more|additional|second)\b/.test(clause));
  const allowShort = /\b(?:just|instead|another|one more|additional|second)\b/.test(text)
    || /\b\d+\s+(?:outfits?|wigs?)\b/.test(text)
    || ADDON_CATALOG.some((item) => item.match.test(text));
  const matches = Array.from(new Map(clauses.flatMap((clause) => mentionedAddons(clause, allowShort)).map((item) => [item.sku, item])).values());
  if (choosing && matches.length) return matches;
  if (clauses.length === 0 || declined(text)) return [];
  const discussed = ADDON_CATALOG.filter((item) => item.match.test(lastAssistant));
  if (choosing && /\b(?:it|them|that|those|this|one|ones)\b/.test(text) && discussed.length === 1) return discussed;
  const affirmative = /^(?:yes+|yeah+|yep+|yup|sure|okay|ok)(?:\s*,?\s*(?:that's|that is|thats)\s+(?:what\s+i\s+want|what\s+i'd\s+like))?[.! ]*$/i.test(text.trim());
  const offered = /\b(?:would you like|shall (?:i|we))\b.*\b(?:add|include)\b|\bif\s+you(?:'|’)d\s+like\b[\s\S]{0,160}\b(?:we|i)\s+can\s+(?:add|include)\b/i.test(lastAssistant);
  return affirmative && offered && discussed.length === 1 ? discussed : [];
}

export function addonRecipient(message: string, sku: string): string | null {
  const addon = ADDON_CATALOG.find((item) => item.sku === sku);
  const clause = choiceClauses(message).find((text) => addon?.match.test(text)) || message;
  return clause.match(/\bfor\s+(?:my\s+)?(?:another person|sister|brother|mother|father|partner|husband|wife|friend)\b/i)?.[0] || null;
}

/** "No, it's for me" after the extra-makeup question: makeup is already part of the customer's own session. */
export function isMakeupForSelf(message: string, history: Message[] = []): boolean {
  history = stripAssistantEmojis(history);
  const lastAssistant = [...history].reverse().find((entry) => entry.role === 'assistant')?.content || '';
  if (!lastAssistant.includes(ADDON_MAKEUP_CLARIFICATION) || addonRecipient(message, 'extra_makeup')) return false;
  return /^\s*(?:no+|nope|nah)\b|\bfor me\b|\bmyself\b|\bjust me\b|\bit'?s mine\b/i.test(normalizeQuotes(message));
}

export function makeupIncludedReply(service: string | null | undefined, editionName: string | null): string {
  const extra = 'Extra makeup is for another person, such as your sister.';
  if (service && !SEED_EDITION_INCLUSIONS[service]?.makeup) return `The team will confirm the makeup included in your ${editionName} session. ${extra}`;
  return `Professional makeup is already included in your ${editionName ? `${editionName} ` : ''}session, so there's nothing to add for you. ${extra}`;
}

/** "Show me the add ons": a request to see the extras, not a choice of one. */
export function isAddonListRequest(message: string): boolean {
  const text = normalizeQuotes(message).toLowerCase().replace(/\badd\s+ons?\b/g, 'add-ons');
  return /\b(?:show|see|send|share|list|view|what are|which are|what)\b[^.?!]{0,30}\b(?:add-?ons?|extras|optional extras)\b/.test(text)
    && !ADDON_CATALOG.some((item) => item.match.test(text));
}

export function addonSelectionClarification(message: string, history: Message[] = []): string | null {
  history = stripAssistantEmojis(history);
  if (isAddonInquiry(message)) return null;
  const choices = selectedAddons(message, history);
  if (choices.some((item) => item.sku === 'extra_makeup') && !addonRecipient(message, 'extra_makeup')) return ADDON_MAKEUP_CLARIFICATION;
  const lastAssistant = [...history].reverse().find((entry) => entry.role === 'assistant')?.content || '';
  if (/^(?:yes+|yeah|yep|sure|ok|okay)[.! ]*$/i.test(message.trim())
    && ADDON_CATALOG.filter((item) => item.match.test(lastAssistant)).length > 1) return ADDON_MULTI_CLARIFICATION;
  return null;
}

export function addonQuantity(message: string, addon: AddonCatalogItem): number {
  if (!addon.quantityFromNote) return 1;
  const clauses = choiceClauses(message);
  const clause = clauses.find((text) => addon.match.test(text) || SHORT_ADDON_NAMES[addon.sku]?.test(text)) || message.toLowerCase();
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, both: 2, couple: 2 };
  const mention = clause.match(addon.match) || (SHORT_ADDON_NAMES[addon.sku] ? clause.match(SHORT_ADDON_NAMES[addon.sku]) : null);
  const prefix = mention?.index === undefined ? clause : clause.slice(0, mention.index);
  const amount = prefix.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|both|couple)\s*(?:x\s*)?$/)?.[1]
    || (!mention ? clause.match(/\b(\d+(?:\.\d+)?|one|two|three|four|five|six|both|couple)\s+(?:of\s+)?(?:them|those|ones|it)\b/)?.[1] : undefined);
  if (!amount) return 1;
  const quantity = words[amount] || Number(amount);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Choose an add-on quantity from 1 to 20.');
  return quantity;
}

export function addonInquiryReply(message: string): string | null {
  if (!isAddonInquiry(message)) return null;
  const addons = ADDON_CATALOG.filter((item) => item.match.test(message));
  if (!addons.length) return null;
  const details = addons.map((item) => `${item.name}: ${item.unitPrice > 0 ? `Ksh ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}` : ADDON_QUOTED_PRICE_LABEL}.`).join('\n');
  return `${details}\n${addons.length === 1 ? 'Would you like to add it to your session?' : 'Which of these would you like to add to your session?'}`;
}

export function isAdditionalAddonRequest(message: string, sku: string): boolean {
  const addon = ADDON_CATALOG.find((item) => item.sku === sku);
  if (!addon || isAddonInquiry(message)) return false;
  const clause = choiceClauses(message).find((text) => addon.match.test(text) || SHORT_ADDON_NAMES[sku]?.test(text));
  if (!clause) return /\b(?:another|one more|additional|second)\s+(?:one|ones|it|them)\b/i.test(message) && !declined(message);
  const mention = clause.match(addon.match) || (SHORT_ADDON_NAMES[sku] ? clause.match(SHORT_ADDON_NAMES[sku]) : null);
  return /\b(?:another|one more|additional|second)\b/i.test(clause.slice(0, mention?.index ?? 0));
}
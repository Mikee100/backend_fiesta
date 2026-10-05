import { PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { EARLY_SLOT_STEP } from './slot-memory';

export function editionInText(name: string): string {
  const canonical = PACKAGE_NAMES_FOR_EXTRACTION.find((edition) => edition.toLowerCase() === name.trim().toLowerCase());
  if (!canonical) return name;
  const label = canonical.replace(/^THE /, '').toLowerCase();
  return `the ${label[0].toUpperCase()}${label.slice(1)} edition`;
}

export function repeatedCollectionQuestion(
  reply: string,
  draft: { step: string; name?: string | null; service?: string | null; date?: string | null; time?: string | null } | null,
  customerName?: string | null,
  userMessage = '',
): string | null {
  if (draft?.step !== EARLY_SLOT_STEP || !reply.includes('?') || /\b(?:change|different|recommend|compare|instead|correct)\b/i.test(userMessage)) return null;
  const name = draft.name || (customerName && !/^(?:Unknown|WhatsApp User)$/i.test(customerName) ? customerName : null);
  const repeatsName = name && /\b(?:what(?:'s| is)|give me|tell me|may i have)\b[^?]{0,40}\b(?:your|the)\s+name\b/i.test(reply);
  const repeatsEdition = draft.service && /\b(?:which|what)\s+(?:package|edition)\b/i.test(reply);
  if (!repeatsName && !repeatsEdition) return null;
  if (!draft.service) return 'Which edition would you like to consider?';
  if (!draft.date) return 'What date would suit you?';
  if (!draft.time) return 'What time would suit you?';
  return 'Your session details are noted. Would you like to go ahead?';
}

export function needsUnchangedReassurance(message: string): boolean {
  return /\b(?:did|does|will|would|have|has)\b.*\b(?:change|changed|affect)\b.*\b(?:booking|edition|package|date)\b/i.test(message);
}
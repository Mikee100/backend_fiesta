import { ADDON_CATALOG } from '../../config/constants';

export function buildAdditionsReply(deposit: number | null): string {
  const pricedLines = ADDON_CATALOG
    .filter((item) => item.unitPrice > 0)
    .map((item) => `${item.name}: Ksh ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}`);
  const quotedLines = ADDON_CATALOG.filter((item) => item.unitPrice === 0)
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

function normalizeHyphens(value: string): string {
  return value.replace(/[\u2010-\u2015\u2212]/g, '-');
}

export function isAddonListFollowUp(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const text = normalizeHyphens(userMessage).trim().toLowerCase().replace(/[.!?]+$/, '');
  const affirmative = /^(show(\s+me)?(\s+the)?(\s+(full\s+)?(list|options|extras|add-?ons))?|see\s+them|list\s+them|list\s+the\s+(extras|add-?ons)|what\s+(are\s+they|else)|yes(\s+please)?|yeah|yep|sure|ok(ay)?|please)$/.test(text);
  if (!affirmative) return false;

  const lastAssistant = [...history].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant) return false;
  return /(available extras|add-?ons?\b|optional additions|extra services|extra outfit|styled wig)/i.test(
    normalizeHyphens(lastAssistant.content)
  );
}

export function buildBookingProposalConfirmation(service: string, date: string, time: string, deposit: number): string {
  return `Great, I can hold ${service} for ${date} at ${time}. The deposit is KSH ${deposit}. If that works for you, just reply yes and I'll send the M-Pesa prompt.`;
}

export function buildRescheduleProposalConfirmation(service: string, date: string, time: string): string {
  return `Great, I can move your ${service} session to ${date} at ${time}. If that works for you, just reply yes and I'll confirm it.`;
}

export function buildTimeOnlyRescheduleProposal(service: string, date: string, time: string): string {
  return `I can move your ${service} session to ${date} at ${time}. Would you like me to confirm that change?`;
}

export function buildPackageDepositProposal(
  service: string,
  date: string,
  time: string,
  deposit: number
): string {
  return `${service} works for ${date} at ${time}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
}

export function buildCancellationProposal(service: string, session: string, refundPosition: string): string {
  return `You asked to cancel your ${session}. ${refundPosition} If you want me to cancel this booking, reply yes to confirm.`;
}

export function previousMessageRequestsConfirmation(
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content.toLowerCase() || '';
  return /(?:reply\s+["“”']?yes["“”']?|if\s+that\s+works\s+for\s+you.*reply\s+["“”']?yes["“”']?|would\s+you\s+like\s+me\s+to\s+confirm|confirm\s+that\s+change|confirm\s+the\s+change|shall\s+i\s+confirm|reply\W{0,3}yes\b|if\s+you\s+want\s+me\s+to\s+cancel\s+this\s+booking,?\s+reply\s+yes\s+to\s+confirm)/.test(previousAssistantMessage);
}
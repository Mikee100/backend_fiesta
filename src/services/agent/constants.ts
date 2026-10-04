export const MAX_AGENT_COMPLETION_TOKENS = Math.min(2_500, Math.max(200, Number(process.env.AI_MAX_COMPLETION_TOKENS) || 1500));
export const MAX_RAG_CONTEXT_CHUNKS = 3;
export const MAX_HISTORY_MESSAGES = 6;
export const CANCELLATION_PROPOSAL_TTL_MS = 60 * 60 * 1000;
export const OFFICIAL_WEBSITE_URLS = {
  home: 'https://www.fiestahousematernity.com/',
  reviews: 'https://www.fiestahousematernity.com/reviews',
  suspendingConcept: 'https://www.fiestahousematernity.com/gallery/suspending-concept',
} as const;
export const PACKAGE_PRICING_FALLBACK = 'The Editions are THE BLOOM: Ksh 15,000, THE MUSE: Ksh 25,000, THE ICON: Ksh 35,000, THE LEGEND: Ksh 45,000, THE QUEEN: Ksh 55,000, THE EMPRESS: Ksh 70,000 (Most Loved / Signature), and THE GODDESS: Ksh 120,000 (Flagship).';
export const PAYMENT_CONFIRMATION_REQUIRED_REPLY = 'Before I send the M-Pesa deposit prompt, please reply yes to confirm the booking.';
export const PAYMENT_PROMPT_UNRECORDED = 'PAYMENT_PROMPT_UNRECORDED';
export const PAYMENT_PROMPT_UNRECORDED_REPLY = 'Please check your phone for an M-Pesa prompt before trying again. If nothing arrives in a few minutes, the studio team can help.';
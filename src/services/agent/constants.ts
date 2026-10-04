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
export const EDITION_TERM_PATTERN = '(?:packages?|editions?)';
export const EDITION_CATALOG_HEADER = 'Fiesta House Maternity - Rate Card 2026';
export const EDITION_CATALOG_INTRO = 'Here are our maternity editions:';
export const EDITION_CATALOG_FOLLOW_UP = "Tell me which edition you're considering and I'll share its inclusions and anything the team still needs to confirm.";
export const ADDON_NOTED_PREFIX = 'Noted for your session:';
export const ADDON_UNCHANGED_REPLY = 'I have not changed your package or date.';
export const ADDON_BALANCE_REPLY = 'Extras go to the session balance, not the deposit.';
export const ADDON_QUOTED_PRICE_LABEL = 'quoted by package tier';
export const ADDON_MAKEUP_CLARIFICATION = 'Is the extra makeup for another person?';
export const ADDON_MULTI_CLARIFICATION = 'Which add-on would you like to add to your session?';
export const ADDON_ADDITIONS_HEADER = 'Yes, these optional additions are available:';
export const BUDGET_HANDOFF_REPLY = 'Thank you for your patience. A member of our team will pick this up with you shortly.';
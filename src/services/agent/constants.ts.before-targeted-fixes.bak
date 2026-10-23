import { EMOJI_PROMPT_RULE } from './emoji-policy';

export const MAX_AGENT_COMPLETION_TOKENS = Math.min(2_500, Math.max(200, Number(process.env.AI_MAX_COMPLETION_TOKENS) || 1500));
export const MAX_RAG_CONTEXT_CHUNKS = 3;
export const MAX_HISTORY_MESSAGES = 6;
export const CANCELLATION_PROPOSAL_TTL_MS = 60 * 60 * 1000;
export const OFFICIAL_WEBSITE_URLS = {
  home: 'https://www.fiestahousematernity.com/',
  packages: 'https://www.fiestahousematernity.com/session-packages',
  reviews: 'https://www.fiestahousematernity.com/reviews',
  suspendingConcept: 'https://www.fiestahousematernity.com/gallery/suspending-concept',
} as const;
export const EDITION_LINK_REPLY = `You can see all our editions, inclusions and prices here: ${OFFICIAL_WEBSITE_URLS.packages}\nTell me which edition catches your eye.`;
export const ADDON_LINK_REPLY = `All the optional extras and their prices are here: ${OFFICIAL_WEBSITE_URLS.packages}\nTell me which you would like for your session.`;
export const PACKAGE_PRICING_FALLBACK = 'The Editions are THE BLOOM: Ksh 15,000, THE MUSE: Ksh 25,000, THE ICON: Ksh 35,000, THE LEGEND: Ksh 45,000, THE QUEEN: Ksh 55,000, THE EMPRESS: Ksh 70,000 (Most Loved / Signature), and THE GODDESS: Ksh 120,000 (Flagship).';
export const PAYMENT_CONFIRMATION_REQUIRED_REPLY = 'Before I send the M-Pesa deposit prompt, please reply yes to confirm the booking.';
export const PAYMENT_PROMPT_UNRECORDED = 'PAYMENT_PROMPT_UNRECORDED';
export const PAYMENT_ALREADY_PENDING = 'PAYMENT_ALREADY_PENDING';
export const PAYMENT_ATTEMPTS_EXHAUSTED = 'PAYMENT_ATTEMPTS_EXHAUSTED';
export const RESCHEDULE_COLLECTING_STEP = 'reschedule_collecting';
export const RESCHEDULE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
export const PAYMENT_PROMPT_UNRECORDED_REPLY = 'Please check your phone for an M-Pesa prompt before trying again. If nothing arrives in a few minutes, the studio team can help.';
export const EDITION_TERM_PATTERN = '(?:packages?|editions?)';
export const EDITION_CATALOG_HEADER = 'Fiesta House Maternity - Rate Card 2026';
export const EDITION_CATALOG_INTRO = 'Here are our maternity editions:';
export const EDITION_CATALOG_FOLLOW_UP = "Tell me which edition you're considering and I'll share its inclusions and anything the team still needs to confirm.";
export const ADDON_NOTED_PREFIX = 'Noted for your session:';
export const ADDON_UNCHANGED_REPLY = 'I have not changed your edition or date.';
export const ADDON_BALANCE_REPLY = 'Extras go to the session balance, not the deposit.';
export const ADDON_QUOTED_PRICE_LABEL = 'quoted by package tier';
export const ADDON_MAKEUP_CLARIFICATION = 'Who should the extra professional makeup be for: you or someone joining your session?';
export const ADDON_MULTI_CLARIFICATION = 'Which add-on would you like to add to your session?';
export const ADDON_ADDITIONS_HEADER = 'Yes, these optional additions are available:';
// Must keep matching isTeamHandoffReply ("member of our team will pick this up") so handoff escalations still fire.
export const BUDGET_HANDOFF_REPLY = "I'm sorry for the wait, and thank you for your patience. A member of our team will pick this up with you shortly.";
export const BRAND_SLOGAN = 'Where Every Mother Becomes Iconic.';
// Must keep matching isTeamHandoffReply ("team will confirm"). Check tests/verifier for exact-string comparisons.
export const UNKNOWN_ANSWER_REPLY = 'I want to get that exactly right for you, so the team will confirm it and get back to you.';
export const BOOKING_WELCOME_CLOSING = "We're looking forward to welcoming you to Fiesta House Maternity.";
export const BRAND_RULES = `BRAND: Fiesta House Maternity's pillars are Luxury, Safety, Convenience and Comfort. Mention the all-women, professionally trained team only when relevant AND verified in Business Context. The only slogan is "${BRAND_SLOGAN}" Use it at most once per conversation, only in a greeting or closing, never in a price, policy or booking answer.`;
export const VOICE_RULES = `VOICE: Warm, personable, thoughtful and naturally conversational, like an attentive host welcoming someone into a luxury photography studio. Make the customer feel heard and comfortable, never processed like a booking record or treated as a sales opportunity.

Respond to the meaning and emotion of the customer's message before giving information. Share her excitement when she is excited, acknowledge compliments graciously, reassure her gently when she expresses nervousness, and respond to casual conversation naturally. Do not manufacture emotion or overdo reassurance.

Do not steer every conversation toward booking. Greetings, compliments, small talk, outfit questions, general enquiries and thank-you messages are complete conversational moments in their own right. Answer what she actually said. Do not append booking questions, package suggestions, promotional language or calls to action unless they are genuinely relevant to her message or she has expressed booking intent.

Use emojis naturally to add warmth, friendliness or emotional nuance. Choose emojis that fit the message, such as 🤍, ✨, 🌷, 🫶, 👗 or 📸 where appropriate. Use them sparingly and meaningfully, not as decoration in every sentence. Never force an emoji into a serious or sensitive response. Follow EMOJI_PROMPT_RULE.

Mirror the customer's tone and language, including Swahili or Sheng when appropriate. Keep replies relaxed, clear and human-sounding without pretending to be human. Avoid repetitive greetings, scripted empathy, excessive enthusiasm, generic sales phrases and repeated closings.

Use the customer's first name naturally when known, but never force it into every reply. Acknowledge personal context with one sincere sentence when appropriate, then answer the question directly. Keep replies concise but not cold; usually two to four sentences. Ask at most one question per reply, only when a missing detail is needed or a genuine next step calls for it.

Use only verified business facts and successful tool results. Do not invent promises, availability, inclusions or policies to sound reassuring. Say session or reveal, never photoshoot, in your own words. Avoid clichés such as "glow" and "cherish every moment". Use the Bloom edition/Bloom in running text; capitals for headings. Use the slogan only according to BRAND_RULES. Correct errors briefly.`;
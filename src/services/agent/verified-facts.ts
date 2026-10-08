import { ADDON_CATALOG } from '../../config/constants';
import { stripAssistantEmojis } from './emoji-policy';

export interface VerifiedFactResult {
  reply: string;
  category: string;
}

/**
 * Verified Facts Table
 * Provides deterministic, approved answers for common questions about:
 * - Makeup (coverage, lashes, extra makeup)
 * - Hair & Wigs (styling included, wig hire, wig styling only, bringing own hair)
 * - Outfits & Gowns (studio wardrobe selection, extra outfit fee, bringing own outfit, sharing gowns in chat)
 * - Partner & Family Styling follow-ups
 * - Power Suit details and pricing
 * - Follow-up acknowledgements after a team handoff (avoids repeating canned fallbacks)
 */
export function resolveVerifiedFact(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  context?: { draftService?: string | null }
): string | null {
  const text = userMessage.trim().toLowerCase();
  const cleanHistory = stripAssistantEmojis(history);
  const lastAssistant = cleanHistory.slice().reverse().find((m) => m.role === 'assistant')?.content || '';

  // 1. Acknowledging previous handoff / "waiting for response" (avoids repeating "I'd rather not guess")
  const isWaitingStatement = /^(?:(?:i\s+will|i'll)\s+(?:be\s+)?wait(?:ing)?(?:\s+for\s+(?:your\s+)?(?:response|reply))?|wait(?:ing)?(?:\s+for\s+(?:your\s+)?(?:response|reply))?|okay\s+i\s+(?:will|'ll)\s+wait|i\s+will\s+wait|i'll\s+wait)[.!]?$/i.test(text);
  const recentTeamHandoff = /passed your question to the studio team|member of our team will pick this up|team will confirm/i.test(lastAssistant);
  if (isWaitingStatement || (recentTeamHandoff && /^(?:okay|ok|alright|noted|waiting)[.!]?$/i.test(text))) {
    return "I've passed that on, and the studio team will reply here shortly.";
  }

  // 2. Makeup questions: "is makeup for one person", "is makeup included for partner"
  const makeupTerms = /\b(?:make[-\s]?up|makeup)\b/i;
  const singlePersonQuery = /\b(?:one\s+person|single\s+person|only\s+me|just\s+me|for\s+me\s+alone|how\s+many\s+people|who\s+is\s+it\s+for|for\s+both|for\s+(?:my\s+)?(?:partner|husband|sister))\b/i;
  if (makeupTerms.test(text) && singlePersonQuery.test(text)) {
    return 'Professional makeup is included for the expecting mother with every session. If you would like extra professional makeup for a partner, sister, or someone joining you, it is available for Ksh 3,500. Lashes are included with all our makeup services.';
  }

  // 3. Hair & Wigs: "do I have to come with my own hair", "bring my own hair", "can I bring my own wig"
  const hairTerms = /\b(?:hair|hairstyling|hair\s*styling|wig|wigs)\b/i;
  const ownHairQuery = /\b(?:come\s+with\s+(?:my\s+)?own\s+hair|bring\s+(?:my\s+)?own\s+hair|with\s+my\s+own\s+hair|my\s+own\s+hair|bring\s+(?:my\s+)?own\s+wig|come\s+with\s+(?:my\s+)?own|bring\s+(?:my\s+)?own)\b/i;
  if (hairTerms.test(text) && ownHairQuery.test(text)) {
    return 'Sessions include styling of your own hair. You are welcome to come with your hair ready for styling. If you would like a styled wig, styled wig hire is Ksh 4,000 and wig styling only is Ksh 3,000 (booked in advance). For specific hair preparation details, the studio team will confirm with you.';
  }

  // 4. Outfits - How to choose gowns / outfits
  const chooseTerms = /\b(?:how\s+(?:can|do)\s+i\s+(?:choose|chose|pick|select)|where\s+do\s+i\s+(?:choose|chose|pick|select)|how\s+are\s+(?:the\s+)?(?:outfits?|gowns?)\s+(?:chosen|selected|picked))\b/i;
  const outfitTerms = /\b(?:outfits?|gowns?|dresses?|wardrobe)\b/i;
  if (chooseTerms.test(text) && outfitTerms.test(text)) {
    return 'You select your gowns and outfits from our studio wardrobe during your session, where our team assists with styling and fit. You may also bring personal sentimental outfits if you wish.';
  }

  // 5. Outfits - Customer offering to share gowns in chat
  const sharingGowns = /\b(?:i\s+will|i'll|let\s+me)\s+(?:share|send)\b.{0,40}\b(?:my\s+)?(?:gowns?|outfits?|dresses?|photos?)\b/i.test(text)
    || /\b(?:share|send)\b.{0,30}\b(?:my\s+gowns|my\s+outfits|my\s+dresses)\b/i.test(text);
  if (sharingGowns) {
    const nextGuide = context?.draftService ? ' What date would suit you for your session?' : '';
    return `Sounds wonderful! The studio team will review your gown choices with you, or you can bring them along to your session.${nextGuide}`;
  }

  // 6. Outfits - Adding extra outfit of own / swapping outfits
  const extraOwnOutfit = /\b(?:add|bring|wear|include)\b.{0,60}\boutfit\b.{0,40}\b(?:of\s+my\s+own|my\s+own|extra|one\s+more)\b/i.test(text)
    || /\b(?:add|bring)\s+(?:an?\s+)?(?:extra|one\s+more)\s+outfit\b/i.test(text)
    || /\b(?:can\s+i\s+bring|can\s+i\s+add)\b.{0,40}\b(?:my\s+own\s+outfit|extra\s+outfit)\b/i.test(text);
  if (extraOwnOutfit) {
    const nextGuide = context?.draftService ? ' What date would suit you for your session?' : '';
    return `Extra outfits beyond your package are Ksh 4,000 each. For bringing your own outfit or swapping one with the studio wardrobe, the studio team will confirm details with you.${nextGuide}`;
  }

  // 7. Partner / Husband Outfits follow-up: "do you have outfits for both me and my partner"
  const partnerOutfitTerms = /\b(?:outfits?\s+(?:for\s+both|for\s+my\s+partner|for\s+my\s+husband)|do\s+you\s+have\s+outfits\s+for\s+(?:my\s+)?(?:partner|husband))\b/i;
  if (partnerOutfitTerms.test(text)) {
    return 'Our studio wardrobe is primarily tailored for the expecting mother. Your partner and children are very welcome to join the session, and the studio team will confirm styling recommendations for them.';
  }

  // 8. Power Suit: "what is the power suit", "how much is the power suit"
  const powerSuitQuery = /\b(?:what\s+is\s+(?:the\s+)?power\s+suit|tell\s+me\s+about\s+(?:the\s+)?power\s+suit|power\s+suit\s+details|how\s+much\s+is\s+(?:the\s+)?power\s+suit)\b/i;
  if (powerSuitQuery.test(text)) {
    return 'The Fiesta House Power Suit is an iconic, tailored maternity statement suit. It is available as an add-on for Ksh 10,000, and is included with The Empress and The Goddess editions.';
  }

  return null;
}

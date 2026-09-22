
import OpenAI from 'openai';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { bookingService } from '../booking/booking.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION, PACKAGE_NAME_PATTERN, PACKAGE_NAMES_FOR_EXTRACTION, ADDON_CATALOG } from '../../config/constants';
import { mpesaService } from '../payment/mpesa.service';
import { circuitBreaker, scoreSentiment, DAILY_TOKEN_CAP, FALLBACK_MESSAGE, shouldNotifyOutage, isProviderRateLimitError } from './resilience.service';
import { notifyAdmin } from '../notifications/notification.service';
import { businessDay, inBusinessTimezone, nowInBusinessTimezone } from '../../utils/time';
import { ConversationFlowMatcher } from './conversation-flow.matcher';
import { ConversationFlowHandler } from './conversation-flow.handler';
import { customerReplyTemplates, formatCustomerReply } from '../messaging/customer-reply.templates';
import { bookingAddonService } from '../booking/booking-addon.service';

// Groq's API is OpenAI-compatible, so the 'openai' SDK works unmodified against its endpoint.
// Ensure you have GROQ_API_KEY in your .env
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'llama-3.1-8b-instant';

// --- Hybrid Booking Extractor ---
type BookingDetails = {
  name?: string | null;
  service?: string | null;
  date?: string | null;
  time?: string | null;
};

export class BookingExtractor {
  // 🧼 STEP 1: Clean Input
  private clean(text: string): string {
    return text
      .replace(/[^ 0-\w\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ⚡ STEP 2: Regex Extraction
  private regexExtract(text: string): BookingDetails {
    const cleanText = this.clean(text);

    // Don't extract names from short greetings
    if (cleanText.length < 10) return { name: null, service: null, date: null, time: null };

    // Look for patterns like "my name is..." or "this is..."
    const nameMatch = cleanText.match(/my name is ([a-z]{2,})/i) || 
                      cleanText.match(/this is ([a-z]{2,})/i) ||
                      cleanText.match(/i am ([a-z]{2,})/i);
    
    const serviceMatch = cleanText.match(
      new RegExp(`(?:the\\s+)?(${PACKAGE_NAME_PATTERN})(?:\\s+(?:package|edition))?`, 'i')
    );
    const dateMatch = cleanText.match(/(\d{1,2})(st|nd|rd|th)?/i);
    const timeMatch = cleanText.match(/(\d{1,2})(:|\s*)(\d{2})?\s*(am|pm)/i);

    let date;
    let time = null;

    if (timeMatch) {
      time = timeMatch[0].toLowerCase().replace(/\s/g, '');
    }
    if (dateMatch) {
      const day = dateMatch[1];
      const parsed = nowInBusinessTimezone().date(Number(day));
      if (parsed.isValid()) {
        date = parsed.format('YYYY-MM-DD');
      }
    }

    return {
      name: nameMatch?.[1] || null,
      service: serviceMatch?.[1] || null,
      date: date || null,
      time: time || null
    };
  }

  // 🤖 STEP 3: AI Extraction (STRICT JSON)
  private async aiExtract(message: string): Promise<{ details: BookingDetails; tokensUsed: number }> {
    const now = nowInBusinessTimezone().format('dddd, MMMM D, YYYY h:mm A');
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `Current Date/Time: ${now}\n\nExtract booking details from the user message.\n\nReturn ONLY valid JSON. No text.\n\nFormat:\n{\n  "name": string | null,\n  "service": string | null,\n  "date": string | null,\n  "time": string | null\n}\n\nRules:\n- Name must be full name if possible
- Service must be one of the 2026 Editions: ${PACKAGE_NAMES_FOR_EXTRACTION.join(', ')} (or legacy: standard, economy, executive, gold, platinum, vip, vvip if the customer still uses those names)
- Prefer Edition names like "THE EMPRESS" over legacy names
- Convert date into YYYY-MM-DD
- Convert time into 24h format (HH:mm)
- If missing, return null
`
        },
        { role: 'user', content: message }
      ],
      temperature: 0
    });
    let details: BookingDetails = {};
    try {
      details = JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      details = {};
    }
    return { details, tokensUsed: response.usage?.total_tokens || 0 };
  }

  // 🔥 FINAL HYBRID METHOD
  async extract(message: string): Promise<{ details: BookingDetails; tokensUsed: number }> {
    const regex = this.regexExtract(message);
    console.log('Regex result:', regex);
    if (regex.name && regex.service && regex.date && regex.time) {
      return { details: regex, tokensUsed: 0 };
    }
    const { details: ai, tokensUsed } = await this.aiExtract(message);
    console.log('AI result:', ai);
    return {
      details: {
        name: regex.name || ai.name,
        service: regex.service || ai.service,
        date: regex.date || ai.date,
        time: regex.time || ai.time
      },
      tokensUsed
    };
  }
}


export class AgentService {
  private readonly naturalAssistantMode = String(process.env.AI_ASSISTANT_NATURAL_MODE || 'false').toLowerCase() === 'true';
  private readonly conversationFlows = new ConversationFlowMatcher();
  private readonly conversationFlowHandler = new ConversationFlowHandler(this.conversationFlows);

  private isNaturalAssistantModeEnabled(): boolean {
    return this.naturalAssistantMode;
  }

  private formatCustomerReply(reply: string): string {
    return formatCustomerReply(reply);
  }

  private normalizeToolName(rawName: string): string {
    return String(rawName || '').split('<|')[0].trim();
  }

  private isToolNameValidationError(error: any): boolean {
    const message = String(error?.error?.message || error?.message || '');
    return (
      error?.status === 400 &&
      error?.code === 'tool_use_failed' &&
      message.includes('attempted to call tool')
    );
  }

  private async createCompletionWithToolNameGuard(params: any, allowedToolNames: string[]) {
    try {
      return await openai.chat.completions.create(params);
    } catch (error: any) {
      if (!this.isToolNameValidationError(error)) {
        throw error;
      }

      // Some providers occasionally append transport/control tokens to tool
      // names, which fails request.tools validation. Retry once with an
      // explicit hard rule and lower temperature.
      let attemptedRawName: string | undefined;
      try {
        const failedGeneration = error?.error?.failed_generation;
        if (failedGeneration) {
          const parsed = JSON.parse(failedGeneration);
          attemptedRawName = parsed?.name;
        }
      } catch {
        // Best-effort parse only; keep retrying even if parsing fails.
      }

      const attemptedNormalized = this.normalizeToolName(attemptedRawName || '');
      console.warn('Retrying completion after malformed tool name:', {
        attemptedRawName,
        attemptedNormalized,
      });

      const retryMessages = [
        ...params.messages,
        {
          role: 'system',
          content: `CRITICAL TOOL RULE: If you call a tool, the function name must be EXACTLY one of: ${allowedToolNames.join(', ')}. Do not add any extra suffixes, prefixes, tags, or channel markers.`
        }
      ];

      return await openai.chat.completions.create({
        ...params,
        messages: retryMessages,
        temperature: 0,
      });
    }
  }

  private inferIntent(userMessage: string): { intent: string; confidence: number; rule: string } {
    const text = userMessage.toLowerCase();

    if (/(reschedule|change|move|postpone)/.test(text)) return { intent: 'reschedule', confidence: 0.92, rule: 'reschedule_keywords' };
    if (/(book|booking|appointment|session)/.test(text)) return { intent: 'booking', confidence: 0.88, rule: 'booking_keywords' };
    if (/(pay|paid|payment|mpesa|deposit|receipt|balance)/.test(text)) return { intent: 'payment', confidence: 0.9, rule: 'payment_keywords' };
    if (/(price|cost|package|rate|services|service list)/.test(text)) return { intent: 'pricing', confidence: 0.86, rule: 'pricing_keywords' };
    if (/(where|location|located|address)/.test(text)) return { intent: 'location', confidence: 0.9, rule: 'location_keywords' };
    if (/(time|hours|open|close|availability|available|how long|duration)/.test(text)) return { intent: 'availability', confidence: 0.82, rule: 'availability_keywords' };

    return { intent: 'general_inquiry', confidence: 0.35, rule: 'fallback_default' };
  }

  private inferOutcome(aiResponse: string, isFallback: boolean): string {
    if (isFallback) return 'escalated';

    const text = aiResponse.toLowerCase();
    if (text.includes('m-pesa') && text.includes('deposit')) return 'booked';
    if (text.includes('rescheduled')) return 'resolved';
    if (text.includes('team member') || text.includes('follow up')) return 'escalated';

    return 'resolved';
  }

  private getWeekdayReply(
    userMessage: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): string | null {
    const match = userMessage.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (!match) return null;

    const day = Number(match[1]);
    if (day < 1 || day > 31) return null;

    const recentDateMention = [...history]
      .reverse()
      .map((message) => message.content.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i))
      .find((dateMatch) => dateMatch && Number(dateMatch[1]) === day);

    if (recentDateMention) {
      const contextualDate = dayjs(`${recentDateMention[1]} ${recentDateMention[2]} ${recentDateMention[3]}`, 'D MMMM YYYY');
      if (contextualDate.isValid()) {
        return `${contextualDate.format('MMMM D, YYYY')} is a ${contextualDate.format('dddd')}.`;
      }
    }

    const current = nowInBusinessTimezone();
    let date = current.date(day);
    if (date.isBefore(current, 'day')) date = date.add(1, 'month');

    return `${date.format('MMMM D, YYYY')} is a ${date.format('dddd')}.`;
  }

  private getBusinessIntroductionReply(): string {
    return 'Fiesta House is a photography studio in Parklands, Nairobi, specialising in maternity, newborn and family sessions. We help plan the look of the shoot, guide you through posing, handle the photography, and deliver your edited photos afterwards. For maternity sessions, we can also help with makeup, styling and outfit choices so you feel comfortable in front of the camera. Is there one part of the experience you want to know more about?';
  }

  private shouldUseBookingProcessReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(process\s+of\s+booking|booking\s+process|how\s+to\s+book|how\s+does\s+booking\s+work|what\s+does\s+booking\s+entail|steps\s+to\s+book|explain\s+booking)/.test(text);
  }

  private shouldUsePostShootProcessReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(after\s+the\s+shoot|what\s+happens\s+after\s+the\s+shoot|post\s*shoot\s*process|after\s+session|after\s+my\s+shoot)/.test(text);
  }

  private shouldUseEarliestImageDeliveryReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(when\s+(can|will)\s+i\s+get\s+(the\s+)?(images|photos)|earliest\s+i\s+can\s+get\s+(the\s+)?(images|photos)|how\s+soon\s+can\s+i\s+get\s+(the\s+)?(images|photos)|when\s+are\s+(the\s+)?(images|photos)\s+ready|delivery\s+date\s+for\s+(images|photos))/.test(text);
  }

  private shouldUseRawFilesReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(raw\s+file|raw\s+files|unedited\s+photos|original\s+files|can\s+i\s+get\s+raw)/.test(text);
  }

  private shouldUseAdditionsReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(additions|add-ons|add-on|extras|extra\s+services|extra\s+photo|extra\s+outfit|extra\s+makeup|digital\s+art|power\s+suit|wig\s+hire|suspending\s+concept|sculpture\s+set|reel\s+pricing|what\s+extras)/.test(text);
  }

  private shouldUseBespokeReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(bespoke|custom\s+experience|custom\s+shoot|custom\s+package|tailored\s+session|tailored\s+experience|vision\s+does\s+not\s+fit)/.test(text);
  }

  private shouldUseTravellingMothersReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(travelling\s+mother|traveling\s+mother|from\s+outside\s+nairobi|from\s+abroad|airport\s+transfer|hotel\s+booking|concierge|soft\s+landing|journeying\s+to\s+us)/.test(text);
  }

  private shouldUseSocialMediaReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(social\s+media|instagram|facebook|website|where\s+can\s+i\s+find\s+you\s+online)/.test(text);
  }

  private shouldHandleResendRequest(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(resend|send\s+again|retry|repeat|send\s+it\s+again)/.test(text);
  }

  private shouldUseMultiPersonBookingReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    const mentionsAnotherPerson = /(my\s+sister|my\s+brother|my\s+friend|my\s+husband|my\s+wife|my\s+partner|my\s+family|also\s+coming|come\s+with\s+her|come\s+with\s+him|joining\s+the\s+shoot|join\s+the\s+shoot)/.test(text);
    const bookingContext = /(book|booking|photoshoot|shoot|session|appointment|ready\s+to\s+book)/.test(text);
    return mentionsAnotherPerson && bookingContext;
  }

  private shouldUseBookingStatusReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(have you done it|did you do it|is it done|is it confirmed|did it go through|have you confirmed|did you confirm|is my booking confirmed|is my session confirmed)/.test(text);
  }

  private shouldUseUpcomingAppointmentTimeReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /\b(when does|what time does|when is|what time is|what time will)\b.*\b(start|begin|session|appointment|booking)\b|\b(start|begin)\b.*\b(when|what time)\b/.test(text);
  }

  private async getUpcomingAppointmentTimeReply(customerId: string): Promise<string | null> {
    const upcomingBooking = await prisma.booking.findFirst({
      where: {
        customerId,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
      orderBy: { dateTime: 'asc' },
      select: { service: true, dateTime: true },
    });

    if (!upcomingBooking) return null;

    return `Your ${upcomingBooking.service} session starts on ${inBusinessTimezone(upcomingBooking.dateTime).format('dddd, MMMM D, YYYY')} at ${inBusinessTimezone(upcomingBooking.dateTime).format('h:mm A')}. Please arrive about 30 minutes early.`;
  }

    private shouldUsePastAppointmentReply(userMessage: string): boolean {
      const text = userMessage.toLowerCase();
      return /(that|the|my)\s+(date|day|appointment|booking|session).*(already\s+)?(passed|past)|already\s+passed|that\s+was\s+in\s+the\s+past/.test(text);
    }

      private isPastAppointmentFollowUp(
        userMessage: string,
        history: { role: 'user' | 'assistant', content: string }[]
      ): boolean {
        const text = userMessage.toLowerCase().trim();
        const isFollowUp = /^(say|tell|repeat)\s+(that|it|again)\b|^(so\s+)?(how|what)\b|what\s+(do|should)\s+i\s+do|which\s+(one|option)|(?:do|choose|pick|i(?:'ll| will) take)\s+(?:number\s+)?[12]\b/.test(text);
        const recentAssistantMessages = history
          .filter((message) => message.role === 'assistant')
          .slice(-3)
          .map((message) => message.content.toLowerCase());
        const invalidPastAppointmentMenu = recentAssistantMessages.some((message) => {
          const describesPastAppointment = /(date|day|appointment|booking|session).*(already\s+)?(passed|past)|already\s+passed/.test(message);
          return describesPastAppointment && /reschedule/.test(message) && /cancel/.test(message);
        });

        return isFollowUp && invalidPastAppointmentMenu;
      }

  private buildPackageCard(pkg: {
    name: string;
    price: number;
    duration: string;
    images: number;
    makeup: boolean;
    outfits: number;
    photobook: boolean;
    photobookSize: string | null;
    mount: boolean;
    balloonBackdrop: boolean;
    wig: boolean;
    notes: string | null;
  }): string {
    const lowerName = pkg.name.toLowerCase();

    let badge = '';
    if (lowerName.includes('empress')) {
      badge = ' ✨ *(Signature Edition — Most Loved)*';
    } else if (lowerName.includes('goddess')) {
      badge = ' 👑 *(Flagship Edition)*';
    }

    const items: string[] = [];
    if (pkg.duration) items.push(`⏱️ ${pkg.duration}`);
    if (pkg.images > 0) items.push(`📸 ${pkg.images} final edited photos`);
    if (pkg.makeup) items.push('💄 Professional makeup');

    if (pkg.outfits > 0) {
      if (lowerName.includes('empress') || lowerName.includes('goddess')) {
        items.push(`👗 ${pkg.outfits} studio outfits + styling (incl. Power Suit)`);
      } else {
        items.push(`👗 ${pkg.outfits} studio outfit${pkg.outfits > 1 ? 's' : ''} + styling`);
      }
    }

    if (pkg.wig) {
      if (lowerName.includes('empress') || lowerName.includes('goddess')) {
        items.push('💇‍♀️ 2 styled wigs');
      } else {
        items.push('💇‍♀️ 1 styled wig');
      }
    }

    if (pkg.balloonBackdrop) {
      if (lowerName.includes('goddess')) {
        items.push('🎈 Custom balloon backdrop or Goddess Sculpture Set');
      } else {
        items.push('🎈 Custom balloon backdrop with flowers');
      }
    }

    if (lowerName.includes('goddess')) {
      items.push('🎬 1 professionally produced Reel');
    }

    if (pkg.photobook) {
      const size = pkg.photobookSize ? ` (${pkg.photobookSize})` : '';
      items.push(`📚 Photobook hardcover${size}`);
    }

    if (pkg.mount) {
      if (lowerName.includes('goddess')) {
        items.push('🖼️ 1 A2 fine art mount');
      } else {
        items.push('🖼️ 1 A3 fine art mount');
      }
    }

    return `🌸 *${pkg.name}* — *Ksh ${pkg.price.toLocaleString()}*${badge}\n${items.map((item) => `  • ${item}`).join('\n')}`;
  }

  private async getPackageCatalogReply(): Promise<string | null> {
    try {
      const packages = await prisma.package.findMany({
        orderBy: [{ price: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          price: true,
          duration: true,
          images: true,
          makeup: true,
          outfits: true,
          photobook: true,
          photobookSize: true,
          mount: true,
          balloonBackdrop: true,
          wig: true,
          notes: true,
        }
      });

      if (!packages.length) return null;

      const cards = packages.map((pkg) => this.buildPackageCard(pkg));
      return `✨ *Fiesta House Maternity — Rate Card 2026* ✨\n\nHere are our maternity packages:\n\n${cards.join('\n\n')}\n\nIf one catches your eye, let me know! I can share more details or help check available shoot dates for you. 💖`;
    } catch (err) {
      console.error('Failed to build package catalog reply:', err);
      return null;
    }
  }

  private async getPackageAdviceReply(userMessage: string): Promise<string | null> {
    const packages = await prisma.package.findMany({
      orderBy: [{ price: 'asc' }, { name: 'asc' }],
      select: {
        name: true,
        price: true,
        duration: true,
        images: true,
        makeup: true,
        outfits: true,
        photobook: true,
        photobookSize: true,
        mount: true,
        balloonBackdrop: true,
        wig: true,
        notes: true,
      },
    });

    const text = userMessage.toLowerCase();
    const mentionedPackages = packages.filter((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
    if (mentionedPackages.length >= 2) {
      const [first, second] = mentionedPackages;
      const differences: string[] = [];
      if (first.price !== second.price) differences.push(`${first.name} is Ksh ${first.price.toLocaleString()}, while ${second.name} is Ksh ${second.price.toLocaleString()}`);
      if (first.images !== second.images) differences.push(`${first.name} includes ${first.images} edited images and ${second.name} includes ${second.images}`);
      if (first.duration !== second.duration) differences.push(`${first.name} is ${first.duration}, while ${second.name} is ${second.duration}`);
      if (first.photobook !== second.photobook) differences.push(second.photobook ? `${second.name} includes an ${second.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook') : `${first.name} includes an ${first.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook'));
      if (first.mount !== second.mount) differences.push(first.mount ? `${first.name} includes an A3 mount` : `${second.name} includes an A3 mount`);

      const higherValuePackage = first.price >= second.price ? first : second;
      const lowerCostPackage = higherValuePackage === first ? second : first;
      return `${differences.join('. ')}. ${higherValuePackage.name} makes sense if its extra inclusions matter to you; ${lowerCostPackage.name} is the lower-cost option. Will your older child be joining you in the shoot?`;
    }

    const higherValue = packages.find((pkg) => ['the empress', 'the goddess', 'the queen', 'the legend'].includes(pkg.name.toLowerCase())) || packages[packages.length - 1];
    const lowerCost = packages.find((pkg) => ['the icon', 'the muse', 'the bloom'].includes(pkg.name.toLowerCase())) || packages[0];
    if (!higherValue || !lowerCost) return null;

    const higherPhotobookInfo = higherValue.photobook ? ` and a photobook` : '';
    return `Congratulations on your pregnancy! I would lean toward ${higherValue.name} if you would enjoy more variety: it includes ${higherValue.images} edited images${higherPhotobookInfo} for Ksh ${higherValue.price.toLocaleString()}. ${lowerCost.name} is Ksh ${lowerCost.price.toLocaleString()} and includes ${lowerCost.images} edited images, so it is a lovely option as well. Will your partner or family be joining you in the shoot?`;
  }

  private async getPackageSelectionReply(customerId: string, userMessage: string): Promise<string | null> {
    const text = userMessage.toLowerCase();
    const packages = await prisma.package.findMany({ select: { name: true } });
    const selectedPackage = packages.find((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
    if (!selectedPackage) return null;

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (draft?.step === 'awaiting_confirmation' && draft.date && draft.time && draft.dateTimeIso) {
      const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => selectedPackage.name.toLowerCase().includes(key));
      const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
      const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);

      if (!Array.isArray(slotsResult)) {
        return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
      }

      if (!slotsResult.includes(draft.time)) {
        const alternatives = slotsResult.slice(0, 3).join(', ');
        return `${selectedPackage.name} needs a different amount of time, and ${draft.time} is not free on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
      }

      const selectedPackageDetails = await prisma.package.findUnique({
        where: { name: selectedPackage.name },
        select: { deposit: true },
      });
      const deposit = selectedPackageDetails?.deposit || 2000;
      await prisma.bookingDraft.update({
        where: { customerId },
        data: { service: selectedPackage.name, step: 'awaiting_confirmation' },
      });

      return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
    }

    return `${selectedPackage.name} is a lovely choice. What date are you considering? Once you have a day in mind, I can check the available times for you.`;
  }

  private async getSameBookingSlotReply(
    customerId: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (draft?.step !== 'awaiting_confirmation' || !draft.date || !draft.time || !draft.dateTimeIso || !draft.service) {
      return null;
    }

    const packages = await prisma.package.findMany({ select: { name: true, deposit: true } });
    const selectedPackage = history
      .filter((message) => message.role === 'user')
      .reverse()
      .map((message) => packages.find((pkg) => message.content.toLowerCase().includes(pkg.name.replace(/ package$/i, '').toLowerCase())))
      .find((pkg): pkg is { name: string; deposit: number } => Boolean(pkg));
    const packageToUse = selectedPackage || packages.find((pkg) => pkg.name === draft.service);
    if (!packageToUse) return null;

    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => packageToUse.name.toLowerCase().includes(key));
    const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
    const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);
    if (!Array.isArray(slotsResult)) {
      return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
    }
    if (!slotsResult.includes(draft.time)) {
      const alternatives = slotsResult.slice(0, 3).join(', ');
      return `${packageToUse.name} is not available at ${draft.time} on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
    }

    await prisma.bookingDraft.update({
      where: { customerId },
      data: { service: packageToUse.name, step: 'awaiting_confirmation' },
    });

    return `${packageToUse.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${packageToUse.deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
  }

  private async getRescheduleTimeReply(customerId: string): Promise<string | null> {
    const booking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
      select: { service: true, dateTime: true },
    });
    if (!booking) return null;

    return `Of course. Your ${booking.service} session is currently on ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')} at ${inBusinessTimezone(booking.dateTime).format('h:mm A')}. What time would work better for you that day?`;
  }

  private async getRescheduleTimeProposalReply(customerId: string, userMessage: string): Promise<string | null> {
    const newTime = this.conversationFlows.parseTimeOnly(userMessage);
    if (!newTime) return null;

    const booking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' },
      select: { id: true, service: true, dateTime: true },
    });
    if (!booking) return null;

    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => booking.service.toLowerCase().includes(key)) || 'standard';
    const bookingDay = inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD');
    const slotsResult = await bookingService.getAvailableSlots(
      bookingDay,
      SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION,
      booking.id
    );
    const availableSlots = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(newTime)) {
      const alternatives = availableSlots.slice(0, 3).map((time) => dayjs(`2000-01-01T${time}`).format('h:mm A')).join(', ');
      return `${dayjs(`2000-01-01T${newTime}`).format('h:mm A')} is not free on ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would work for you?`;
    }

    const result = await this.executeProposeRescheduleTool(customerId, bookingDay, newTime);
    await this.notifyRescheduleAdmin({
      customerId,
      event: 'proposed',
      service: result.service,
      oldDateTime: result.oldDateTime,
      newDate: bookingDay,
      newTime,
    });

    return `I can move your ${result.service} session to ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')} at ${dayjs(`2000-01-01T${newTime}`).format('h:mm A')}. Would you like me to confirm that change?`;
  }

  private async getBookingProcessReply(): Promise<string> {
    let startingDeposit = 2000;
    let location = '4th Avenue Parklands, Diamond Plaza Annex, 2nd Floor, Nairobi';

    try {
      const [lowestDepositPackage, studioInfo] = await Promise.all([
        prisma.package.findFirst({
          orderBy: { deposit: 'asc' },
          select: { deposit: true },
        }),
        prisma.studioInfo.findFirst({
          orderBy: { createdAt: 'desc' },
          select: { location: true },
        }),
      ]);

      if (lowestDepositPackage?.deposit && lowestDepositPackage.deposit > 0) {
        startingDeposit = lowestDepositPackage.deposit;
      }
      if (studioInfo?.location?.trim()) {
        location = studioInfo.location.trim();
      }
    } catch (err) {
      console.error('Failed to resolve booking process context:', err);
    }

    return [
      'Great question. Booking is simple:',
      '1) Choose your package.',
      '2) Share your preferred date and time (we are closed on Mondays).',
      '3) Choose any optional add-ons if you wish (extra outfit, wig hire, extra photos, etc. — completely optional!).',
      `4) We confirm availability and send an M-Pesa deposit prompt (starting from Ksh ${startingDeposit.toLocaleString()}).`,
      '5) Once deposit is received, your booking is confirmed and reminders are scheduled.',
      `6) Come for your session at ${location}.`,
      '7) Pay the remaining balance after the shoot (M-Pesa or cash).',
      '',
      "If you're ready, tell me your package and preferred date/time and I'll check slots now."
    ].join('\n');
  }

  private getPostShootProcessReply(): string {
    return [
      'After the shoot:',
      '1) Any remaining balance is cleared as per your package terms (M-Pesa or cash).',
      '2) Edited photos are ready within 10 working days.',
      '3) Edited photos are delivered as a secure download link only.',
      '4) We can share that link via WhatsApp or email, based on your preference.',
      '5) Express delivery is available at an extra fee if you need them sooner.',
      '6) Raw files are available at an extra fee if requested.',
      '',
      "Tell me your preferred delivery method and I'll save it now."
    ].join('\n');
  }

  private addWorkingDays(from: dayjs.Dayjs, days: number): dayjs.Dayjs {
    let cursor = from;
    let remaining = days;

    while (remaining > 0) {
      cursor = cursor.add(1, 'day');
      const day = cursor.day(); // 0=Sun, 6=Sat
      if (day !== 0 && day !== 6) {
        remaining -= 1;
      }
    }

    return cursor;
  }

  private async getEarliestImageDeliveryReply(customerId: string): Promise<string> {
    const upcomingConfirmed = await prisma.booking.findFirst({
      where: {
        customerId,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
      orderBy: { dateTime: 'asc' },
      select: { dateTime: true },
    });

    if (!upcomingConfirmed) {
      return [
        'Edited photos are ready 10 working days after the shoot.',
        'If you share your booked date, I can give you the exact earliest delivery date.',
        'Express delivery is available at an extra fee if you need them sooner.'
      ].join('\n');
    }

    const shootDate = inBusinessTimezone(upcomingConfirmed.dateTime);
    const earliest = this.addWorkingDays(shootDate, 10);

    return [
      'Edited photos are ready 10 working days after the shoot.',
      `Since your session is on ${shootDate.format('dddd, MMMM D, YYYY')}, the earliest delivery date is ${earliest.format('dddd, MMMM D, YYYY')}.`,
      'If you need them sooner, we offer express delivery at an extra fee.'
    ].join('\n');
  }

  private getRawFilesReply(): string {
    return [
      'Raw files are quoted by package tier.',
      'They are shared as a secure download link.',
      'If you let me know which package tier you are interested in, our team can confirm the exact quote for raw files.'
    ].join('\n');
  }

  private getAdditionsReply(): string {
    const lines = ADDON_CATALOG.map((item) => {
      const price = item.unitPrice > 0
        ? `KSH ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}`
        : 'Quoted by package tier';
      return `• *${item.name}:* ${price}`;
    });
    return [
      '✨ *Fiesta House Maternity — Additions & Extra Services* ✨',
      '',
      ...lines,
      '',
      '_Add-ons are optional and settle with your balance after the shoot (not included in the KSH 2,000 deposit)._',
      '',
      'Would you like to include any of these with your session?'
    ].join('\n');
  }

  private getBespokeReply(): string {
    return [
      '✨ *Bespoke Experiences* ✨',
      '',
      'For the mother whose vision does not fit inside a package, we design custom experiences by consultation.',
      '',
      'Reach out to our team to begin the conversation, and we will craft a session around your unique story. 💖'
    ].join('\n');
  }

  private getTravellingMothersReply(): string {
    return [
      '✈️ *For Our Travelling Mothers* 🌸',
      '',
      'For mothers journeying to us from beyond Nairobi, we curate the full arrival.',
      '',
      'Airport transfers, hotel bookings, and a soft landing arranged by our concierge — so all you carry with you is your presence.',
      '',
      'Available on request! Let us know your travel dates and we will be delighted to coordinate for you. 💖'
    ].join('\n');
  }

  private getSocialMediaReply(): string {
    return [
      'Instagram: @fiestahousematernity',
      'https://www.instagram.com/fiestahousematernity',
      '',
      'Facebook: Fiesta House Attire',
      'https://www.facebook.com/fiestahouseattire/',
      '',
      'Website: https://www.fiestahousematernity.com/',
      '',
      'We only share client photos with consent.'
    ].join('\n');
  }

  private getPortfolioReply(): string {
    return 'You can see our maternity, newborn and family sessions in the portfolio here: https://www.fiestahousematernity.com/. Have a look and tell me which style feels most like you.';
  }

  private getWebsiteReply(): string {
    return 'You can find us here: https://www.fiestahousematernity.com/. It has our portfolio, current packages and more about the studio.';
  }

  private getContactDetailsReply(): string {
    return 'We are at Diamond Plaza Annex, 2nd Floor, on 4th Avenue in Parklands, Nairobi. You can reach us on 0720 111928 or at info@fiestahouseattire.com. Our website is https://www.fiestahousematernity.com/.';
  }

  private getMultiPersonBookingReply(): string {
    return [
      'Great question, and yes, we can plan that.',
      'Do you want:',
      '1) one joint session together, or',
      '2) separate bookings for each of you?',
      '',
      "I've noted that another person may join.",
      "Once you confirm option 1 or 2, share your package, date, and preferred time and I'll check availability."
    ].join('\n');
  }

  private async captureMultiPersonBookingNote(customerId: string, userMessage: string): Promise<void> {
    const lower = userMessage.toLowerCase();
    const relation =
      lower.includes('sister') ? 'sister' :
      lower.includes('brother') ? 'brother' :
      lower.includes('friend') ? 'friend' :
      lower.includes('husband') ? 'husband' :
      lower.includes('wife') ? 'wife' :
      lower.includes('partner') ? 'partner' :
      lower.includes('family') ? 'family member' :
      'another person';

    await this.executeAddNoteTool(
      customerId,
      '',
      `Customer mentioned ${relation} may join the shoot; confirm if this is a joint session or separate bookings before finalizing package/price.`,
      'special_request'
    );
  }

  private async getBookingStatusReply(customerId: string): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });

    if (draft?.step === 'reschedule_confirm') {
      return customerReplyTemplates.rescheduleAwaitingConfirmation();
    }

    if (draft?.step === 'awaiting_confirmation') {
      return customerReplyTemplates.bookingAwaitingConfirmation();
    }

    if (draft?.step === 'payment_pending') {
      const pendingPayment = await prisma.payment.findFirst({
        where: { bookingDraftId: draft.id, status: 'pending' },
        orderBy: { updatedAt: 'desc' },
      });

      if (pendingPayment) {
        return customerReplyTemplates.paymentPending();
      }
    }

    const upcomingConfirmed = await prisma.booking.findFirst({
      where: {
        customerId,
        status: 'confirmed',
        dateTime: { gte: new Date() },
      },
      orderBy: { dateTime: 'asc' },
      select: { service: true, dateTime: true },
    });

    if (upcomingConfirmed) {
      return `Yes, it's done. Your ${upcomingConfirmed.service} session is confirmed for ${inBusinessTimezone(upcomingConfirmed.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}.`;
    }

    return null;
  }

  private async getPastAppointmentReply(customerId: string): Promise<string | null> {
    const pastBooking = await prisma.booking.findFirst({
      where: {
        customerId,
        status: { not: 'cancelled' },
        dateTime: { lt: new Date() },
      },
      orderBy: { dateTime: 'desc' },
      select: { service: true, dateTime: true },
    });

    if (!pastBooking) return null;

    return `You're right - that ${pastBooking.service} appointment was on ${inBusinessTimezone(pastBooking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}. Did the session happen, or did you miss it? We can't change or cancel a past appointment, but I can help arrange a new session.`;
  }

  private async logConversationLearning(params: {
    customerId: string;
    userMessage: string;
    aiResponse: string;
    platform: string;
    latencyMs: number;
    wasSuccessful: boolean;
    isFallback: boolean;
  }): Promise<void> {
    try {
      const { score, sentiment, confidence: toneConfidence } = scoreSentiment(params.userMessage);
      const inferred = this.inferIntent(params.userMessage);
      const conversationLength = Math.max(1, params.userMessage.split('\n').filter(Boolean).length);

      await prisma.conversationLearning.create({
        data: {
          customerId: params.customerId,
          userMessage: params.userMessage,
          aiResponse: params.aiResponse,
          extractedIntent: inferred.intent,
          detectedEmotionalTone: sentiment,
          wasSuccessful: params.wasSuccessful,
          conversationOutcome: this.inferOutcome(params.aiResponse, params.isFallback),
          conversationLength,
          timeToResolution: Math.max(1, Math.round(params.latencyMs / 1000)),
          metadata: {
            platform: params.platform,
            isFallback: params.isFallback,
            sentimentScore: score,
            toneConfidence,
            intentConfidence: inferred.confidence,
            intentRule: inferred.rule,
            classifierVersion: 'v2',
          },
        },
      });
    } catch (err) {
      console.error('Failed to log conversation learning:', err);
    }
  }

  private getSystemPrompt(businessContext: string, platform: string): string {
    const now = nowInBusinessTimezone().format('dddd, MMMM D, YYYY h:mm A');
    return `Current Date/Time: ${now}
You are the official AI assistant for Fiesta House Attire & Maternity.
Your goal is to answer customer questions accurately and help them make bookings.

Business Context and Customer History:
${businessContext}

Instructions:
1. Be friendly, empathetic, and professional.
2. If you know the customer's name, greet them by name. If the name is "Unknown", you MUST ask for their real full name before proposing any booking - never invent or reuse a placeholder name.
3. If the customer asks about their upcoming appointment, its date/time, or its details (e.g. "tell me about my appointment", "when is my session", "what are its details") - this is an INFO REQUEST, NOT a reschedule request. Just answer directly using the "Upcoming Booking" / "Past Bookings" information already provided above. Do NOT call propose_reschedule, get_available_slots, or ask them for a new date/time unless they explicitly say they want to reschedule, change, move, postpone, or cancel it.
4. If a customer asks a question, answer it using ONLY the provided Business Context.
5. PLATFORM RESTRICTIONS: You are currently talking to the user on "${platform}". If the platform is "instagram" or "facebook", YOU CANNOT MAKE BOOKINGS. If a user wants to book, politely tell them that bookings are only accepted via WhatsApp, and instruct them to click the WhatsApp link/button on our profile to continue.
6. If the platform IS "whatsapp" or "web", and they want to book, guide them through it. Gather their real Name, the Service they want, a Date, and a Time.
7. RESCHEDULING IS TWO STEPS, NEVER SKIP OR COMBINE THEM: if they want to reschedule, but haven't given a specific new date/time in their message, DO NOT call any tool - ask them what date/time they want first. NEVER invent or guess a date/time yourself. Once they've stated a specific new date/time, call 'propose_reschedule' (this only tells them the proposed new date/time - it changes nothing yet), then STOP and wait. Only call 'confirm_reschedule' after they explicitly reply yes/confirm on their OWN later message - never in the same turn as propose_reschedule.
8. CANCELLATIONS MUST BE REAL, NOT TEXT-ONLY: if the customer asks to cancel their appointment, call 'cancel_booking' before telling them it is cancelled. Never claim a cancellation succeeded unless this tool returns success.
9. PHOTO DELIVERY PREFERENCES MUST BE CAPTURED: if a customer asks about receiving edited photos, clarify that delivery is always via a secure download link, then capture their preferred channel (email/WhatsApp/download link) using 'save_delivery_preference'. If they requested email but have not provided the exact email address (and it isn't already known), ask for the email first before calling the tool.
10. If the customer mentions a specific detail about their session (e.g. "I'm bringing my family", "I want a blue backdrop"), use the 'add_session_note' tool to save it.
11. IMPORTANT: Never assume or make up a time. If the user doesn't provide a time, YOU MUST ASK for it.
12. Before proposing, ALWAYS call 'get_available_slots' for the specific date and service to see which times are free.
13. If the user's preferred time is taken, suggest the closest available slots from the list returned by 'get_available_slots'.
13b. OPTIONAL ADD-ONS DURING BOOKING: During the booking process (when gathering or confirming their package, date, and time, or right before proposing the booking), ask the customer if they would like to include any optional add-ons or extra services (e.g. "Would you like to include any optional add-ons with your shoot, such as an extra outfit, styled wig hire, or extra edited photos? It's completely optional!"). Emphasize that add-ons are strictly optional and not mandatory. If the customer requests or accepts an add-on, save it using the 'add_session_note' tool. If the customer declines ("no", "none", "skip") or has already decided, proceed directly with the booking.
14. BOOKING IS TWO STEPS, NEVER SKIP OR COMBINE THEM:
    a) Once you have their real Name, Service, Date, and a confirmed-free Time, call 'propose_booking'. This only tells the customer the deposit amount - it does NOT charge anything or send any payment prompt.
    b) STOP THERE and wait. Only after the customer explicitly replies yes/confirm/go ahead in their OWN next message do you call 'confirm_booking', which is what actually sends the M-Pesa payment prompt.
    NEVER call propose_booking and confirm_booking in the same turn, even if the customer's message sounds enthusiastic - the deposit prompt must never appear without the customer explicitly agreeing to it first, in its own message.
15. PAYMENT: Once 'confirm_booking' runs, the system sends an M-Pesa STK Push to the customer's phone. Inform the customer that they will receive a prompt on their phone to enter their M-Pesa PIN for the deposit.
16. Explain that the booking is only "provisional" until the deposit is paid, and they will receive a confirmation message once the payment is successful.
17. We are CLOSED on Mondays. Do NOT allow any bookings on Mondays.
18. If the context doesn't answer their question, politely let them know you'll have a human team member follow up.
19. KEEP RESPONSES CONCISE: Messages on some platforms have length limits. Do not send walls of text. Keep your responses under 800 characters if possible.
20. When confirming a saved delivery email, use plain text (no markdown asterisks around the email). Say clearly that the email has been saved and remind them edited photos are delivered within 10 working days.
20a. MEDIA POLICY: Do NOT offer to send, share, or forward videos, photos, or any media files directly in this chat. If a customer asks to see photos, videos, or a studio tour, direct them to our Instagram (@fiestahousematernity), Facebook, or website instead. Keep the conversation focused on their booking and questions - media sharing happens on those platforms only.
21. VOICE: You are a thoughtful, capable studio assistant having a real conversation, not a chatbot reading a script. Many customers are expectant mothers planning an important photo session: be warm, calm, and personally attentive without being overly familiar or assuming anything they have not said. Start by responding directly to what the customer just said. Use plain, everyday language and contractions. Prefer one or two short sentences; ask one clear question only when you genuinely need an answer. Do not use canned openers such as "Sure thing", "Absolutely", "No worries", or "I understand" unless they add genuine meaning. Do not restate the customer's message, narrate obvious steps, or repeat options they have already seen.
22. FORMAT: Write messages as natural WhatsApp text. Do not use markdown, numbered lists, headings, or menus unless the customer explicitly asks for a list or needs to choose between more than two genuinely valid options. Never offer a menu of actions merely because one was mentioned earlier; answer the current message in context.
23. OWN ERRORS: If a previous reply gave incorrect or impossible guidance, correct it plainly and briefly. Do not defend, repeat, or ask the customer to follow an invalid option.
24. POST-APPOINTMENT: Never offer to reschedule or cancel an appointment whose date/time has already passed. Acknowledge that it has passed, ask whether the session took place or was missed, and offer to make a new booking if appropriate.
25. EXAMPLE: For "Tell me about the business first", do not send a brochure or a package list. Say something like: "Fiesta House creates maternity, newborn and family photo sessions in Parklands, Nairobi. We handle the styling, makeup and photography so you can feel comfortable and enjoy the experience. Are you mainly looking into a maternity session?" Use this as a style example only; facts must still come from the Business Context.
26. RATE CARD 2026 & ACTIVE OFFERINGS: Our active packages are "THE EDITIONS" (THE BLOOM: Ksh 15,000, THE MUSE: Ksh 25,000, THE ICON: Ksh 35,000, THE LEGEND: Ksh 45,000, THE QUEEN: Ksh 55,000, THE EMPRESS: Ksh 70,000 - Most Loved / Signature, THE GODDESS: Ksh 120,000 - Flagship). Legacy names like Standard, Economy, Executive, Gold, Platinum, VIP, VVIP are retired/deprecated. If asked "anything new in the business" or about our offerings, proudly present our Rate Card 2026 Editions, Additions & Extra Services (extra photos, extra makeup, Power Suit, wig hire, Suspending Concept, Sculpture set, Reels), Bespoke Experiences, or Concierge Services for Travelling Mothers. NEVER state that legacy packages are our current lineup.`;
  }

  /**
   * Runs the actual RAG + tool-calling pipeline. Can throw (provider errors,
   * DB errors, etc.) - callers should go through handleMessage, which wraps
   * this with the circuit breaker, rate limiting, and a safe fallback.
   */
  private async runAgent(customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<{ content: string; tokensUsed: number }> {
    // 1. Fetch Customer and Booking History for Memory
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: { bookings: { orderBy: { dateTime: 'desc' }, take: 5 } }
    });

    const customerName = customer?.name && customer.name !== 'WhatsApp User' ? customer.name : 'Unknown';
    const now2 = dayjs();
    const upcomingBooking = customer?.bookings.find(b => dayjs(b.dateTime).isAfter(now2) && b.status !== 'cancelled');
    const upcomingBookingSummary = upcomingBooking
      ? `${upcomingBooking.service} on ${inBusinessTimezone(upcomingBooking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')} (status: ${upcomingBooking.status})`
      : 'None';
    const pastBookings = customer?.bookings.map(b =>
      `${b.service} on ${inBusinessTimezone(b.dateTime).format('YYYY-MM-DD')} (${b.status})`
    ).join(', ') || 'No past bookings';

    // Snapshot the booking draft's step as it stood BEFORE this turn's tool calls
    // run. confirm_booking checks against this snapshot, not the live value, so
    // a propose_booking call made earlier in this same turn can never satisfy it -
    // confirmation is only valid if it was already pending from a PRIOR message.
    const draftBeforeThisTurn = await prisma.bookingDraft.findUnique({ where: { customerId } });
    const initialDraftStep = draftBeforeThisTurn?.step;

    // 1b. Long-term memory beyond the last 10 messages of raw history
    const memory = await prisma.customerMemory.findUnique({ where: { customerId } });
    const memorySummary = memory
      ? `Relationship Stage: ${memory.relationshipStage}. Total Past Bookings: ${memory.totalBookings}.`
        + (memory.preferredPackages.length ? ` Preferred Packages: ${memory.preferredPackages.join(', ')}.` : '')
        + (memory.lastInteractionSummary ? ` Last Interaction Summary: "${memory.lastInteractionSummary}"` : '')
      : 'No prior interaction history - this looks like a new customer.';

    // 2. Retrieve RAG Context
    const relevantKnowledge = await knowledgeRetrieval.search(userMessage, 10);
    const contextString = relevantKnowledge.map(k => k.content).join('\n---\n');

    const fullContext = `Customer Phone: ${customerId}
Customer Name: ${customerName}
Upcoming Booking (their next appointment, if any): ${upcomingBookingSummary}
Past Bookings: ${pastBookings}
Customer Memory: ${memorySummary}

Business Context:
${contextString}`;

    // 3. Build conversation history
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.getSystemPrompt(fullContext, platform) },
      ...history,
      { role: 'user', content: userMessage }
    ];

    // 3. Hybrid Extraction (for logging/debug, we'll let LLM handle the tool calls)
    const extractor = new BookingExtractor();
    const { details: extracted, tokensUsed: extractorTokens } = await extractor.extract(userMessage);
    console.log('Extracted details:', extracted);

    // 4. Define the tools the AI can use
    const allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'add_session_note',
          description: 'Saves a note about a specific request or detail for a booking (e.g. "bringing husband", "special backdrop request").',
          parameters: {
            type: 'object',
            properties: {
              bookingDate: { type: 'string', description: 'The date of the booking this note applies to (YYYY-MM-DD)' },
              note: { type: 'string', description: 'The specific detail to save' },
              type: { type: 'string', enum: ['external_people', 'external_items', 'special_request', 'other'], description: 'Category of the note' }
            },
            required: ['bookingDate', 'note', 'type']
          }
        }
      }
    ];

    if (platform === 'whatsapp' || platform === 'web') {
      allTools.push(
        {
          type: 'function',
          function: {
            name: 'propose_booking',
            description: 'Prepares a booking and tells the customer the exact deposit amount, once you have their real name, service, date, and a confirmed-free time. Does NOT charge anything or send any payment prompt yet - it only proposes. You must get an explicit yes/confirm from the customer on a LATER message before calling confirm_booking.',
            parameters: {
              type: 'object',
              properties: {
                customerName: { type: 'string', description: "The customer's real full name - never pass 'Unknown' or leave this as a placeholder, ask them for it first if you don't have it" },
                service: { type: 'string', description: 'The photography or attire service requested' },
                date: { type: 'string', description: 'The date for the booking (YYYY-MM-DD)' },
                time: { type: 'string', description: 'The time for the booking (HH:mm)' }
              },
              required: ['customerName', 'service', 'date', 'time']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'confirm_booking',
            description: "Sends the actual M-Pesa deposit payment prompt to the customer's phone. Only call this after propose_booking has already told them the deposit amount AND the customer has explicitly replied yes/confirm/go ahead in their OWN message - never call this in the same turn as propose_booking.",
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_reschedule',
            description: "Proposes moving the customer's upcoming booking to a new date/time they just told you. Only call this if the customer EXPLICITLY asked to reschedule/change/move/postpone their booking - merely asking about their appointment or its details (e.g. 'tell me about my appointment') is NOT a reschedule request, do not call this tool for that. NEVER invent or guess a date/time yourself - only call this with a date/time the customer actually stated in their own message. If they asked to reschedule without giving a new date/time, do not call this at all - ask them what date/time they want instead. Does NOT change anything yet - you must get an explicit yes/confirm from the customer on a LATER message before calling confirm_reschedule.",
            parameters: {
              type: 'object',
              properties: {
                newDate: { type: 'string', description: 'The new date, exactly as the customer stated it (YYYY-MM-DD)' },
                newTime: { type: 'string', description: 'The new time, exactly as the customer stated it (HH:mm)' }
              },
              required: ['newDate', 'newTime']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'confirm_reschedule',
            description: 'Actually applies the reschedule. Only call this after propose_reschedule already told the customer the new date/time AND they explicitly replied yes/confirm on their OWN later message - never call this in the same turn as propose_reschedule.',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_available_slots',
            description: 'Check available time slots for a specific date and service duration',
            parameters: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'The date to check (YYYY-MM-DD)' },
                service: { type: 'string', description: 'The service name (to determine duration)' }
              },
              required: ['date', 'service']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'cancel_booking',
            description: 'Cancels the customer\'s next upcoming confirmed appointment. Use this only when they explicitly ask to cancel. This actually updates the booking status and removes the Google Calendar event when present.',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'save_delivery_preference',
            description: 'Saves how the customer wants to receive the secure download link for edited photos (especially email delivery). If email delivery is requested, include the exact email address when known.',
            parameters: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['email', 'download_link', 'whatsapp'], description: 'Preferred channel for receiving the secure download link for edited photos' },
                email: { type: 'string', description: 'Customer email address if method is email (optional only when already known and previously confirmed)' },
                whatsappNumber: { type: 'string', description: 'WhatsApp number to receive the download link when method is whatsapp (optional if same as customer number on file)' },
                note: { type: 'string', description: 'Any extra delivery preference details (e.g. express requested)' }
              },
              required: ['method']
            }
          }
        }
      );
    }

    const allowedToolNames = allTools
      .map((tool) => tool.type === 'function' ? tool.function.name : '')
      .filter((name): name is string => !!name);

    // 5. Call LLM. Booking a slot is naturally multi-step (check availability,
    // then book), so the model can legitimately want to chain more than one
    // tool call in a single turn - loop until it returns plain text instead of
    // assuming a single round. A hard cap prevents a runaway loop.
    let tokensUsed = extractorTokens;
    const MAX_TOOL_ROUNDS = 5;
    let currentResponse = await this.createCompletionWithToolNameGuard({
      model: CHAT_MODEL,
      messages,
      tools: allTools,
      tool_choice: 'auto',
      temperature: 0.3
    }, allowedToolNames);
    tokensUsed += currentResponse.usage?.total_tokens || 0;

    let rounds = 0;
    let proposedThisTurn = false; // blocks confirm_booking if propose_booking (even a re-propose with changed details) ran earlier in this same turn
    let confirmedActionThisTurn = false; // once a booking/reschedule is confirmed, blocks ALL further booking tool calls this turn - the model has looped and re-proposed unasked-for changes after a successful confirm before
    while (currentResponse.choices[0].message.tool_calls && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const responseMessage = currentResponse.choices[0].message;
      messages.push(responseMessage); // Add assistant message to history once

      for (const toolCall of responseMessage.tool_calls!) {
        if (toolCall.type === 'function') {
          const functionName = toolCall.function.name;
          let args: any = {};
          let toolResponse: string;

          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            toolResponse = `ERROR: Invalid arguments for tool ${functionName}. Ask the customer for the missing details again and then retry the correct tool.`;
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResponse
            });
            continue;
          }

          console.log(`Tool Called: ${functionName} with args:`, args);

          try {
            if (['propose_booking', 'confirm_booking', 'propose_reschedule', 'confirm_reschedule', 'cancel_booking'].includes(functionName) && confirmedActionThisTurn) {
              toolResponse = `ERROR: A booking/reschedule was already confirmed earlier in this same turn. The task is done - stop calling booking tools and just tell the customer it's confirmed.`;
            }
            else if (functionName === 'propose_booking') {
              const result = await this.executeProposeBookingTool(customerId, args.customerName, args.service, `${args.date}T${args.time}`);
              proposedThisTurn = true;
              toolResponse = `PROPOSED (not yet charged): ${args.service} on ${args.date} at ${args.time}, deposit KSH ${result.depositAmount}. Use this exact customer-facing confirmation: "Great, I can hold ${args.service} for ${args.date} at ${args.time}. The deposit is KSH ${result.depositAmount}. If that works for you, just reply yes and I'll send the M-Pesa prompt." Do NOT call confirm_booking in this same turn.`;
            }
            else if (functionName === 'confirm_booking') {
              if (proposedThisTurn) {
                toolResponse = `ERROR: You already called propose_booking earlier in this same turn - possibly with different details than what the customer last saw and agreed to. You must stop here and wait for the customer's own separate message explicitly confirming before calling confirm_booking.`;
              } else {
                const result = await this.executeConfirmBookingTool(customerId, initialDraftStep);
                confirmedActionThisTurn = true;
                toolResponse = `I've initiated a deposit payment request of KSH ${result.depositAmount} to your phone. Once you enter your M-Pesa PIN and the payment is successful, your booking for ${result.service} on ${result.date} at ${result.time} will be officially confirmed. This is DONE - do not call any more booking tools this turn.`;
              }
            }
            else if (functionName === 'propose_reschedule') {
              if (!extracted.date || !extracted.time) {
                toolResponse = `ERROR: The customer has not actually stated a specific new date and time in their message. Do NOT invent one - ask them what date and time they'd like to reschedule to.`;
              } else {
                const result = await this.executeProposeRescheduleTool(customerId, args.newDate, args.newTime);
                await this.notifyRescheduleAdmin({
                  customerId,
                  event: 'proposed',
                  service: result.service,
                  oldDateTime: result.oldDateTime,
                  newDate: args.newDate,
                  newTime: args.newTime,
                });
                proposedThisTurn = true;
                toolResponse = `PROPOSED (not yet applied): reschedule ${result.service} to ${args.newDate} at ${args.newTime}. Use this exact customer-facing confirmation: "Great, I can move your ${result.service} session to ${args.newDate} at ${args.newTime}. If that works for you, just reply yes and I'll confirm it." Do NOT call confirm_reschedule in this same turn.`;
              }
            }
            else if (functionName === 'confirm_reschedule') {
              if (proposedThisTurn) {
                toolResponse = `ERROR: You already called propose_reschedule earlier in this same turn - possibly with different details than what the customer last saw and agreed to. You must stop here and wait for the customer's own separate message explicitly confirming before calling confirm_reschedule.`;
              } else {
                const result = await this.executeConfirmRescheduleTool(customerId, initialDraftStep);
                await this.notifyRescheduleAdmin({
                  customerId,
                  event: 'confirmed',
                  service: result.service,
                  oldDateTime: result.oldDateTime,
                  newDateTime: result.newDateTime,
                });
                confirmedActionThisTurn = true;
                toolResponse = `SUCCESS: Booking for ${result.service} rescheduled to ${dayjs(result.newDateTime).format('YYYY-MM-DD HH:mm')}. This is DONE - do not call any more booking tools this turn.`;
              }
            }
            else if (functionName === 'cancel_booking') {
              const result = await this.executeCancelBookingTool(customerId);
              confirmedActionThisTurn = true;
              toolResponse = `SUCCESS: Cancelled ${result.service} on ${dayjs(result.dateTime).format('YYYY-MM-DD HH:mm')}. Refund policy: ${result.refundEligible ? 'Eligible for refund (more than 72 hours before appointment).' : 'Not eligible for automatic refund (within 72 hours).'} This is DONE - do not call any more booking tools this turn.`;
            }
            else if (functionName === 'save_delivery_preference') {
              const result = await this.executeSaveDeliveryPreferenceTool(customerId, args.method, args.email, args.whatsappNumber, args.note, platform);
              if (result.method === 'email' && result.email) {
                toolResponse = `SUCCESS: Delivery preference saved. Use this exact customer-facing confirmation: "Perfect, I've saved ${result.email} as your delivery email. We'll share your secure download link within 10 working days after the shoot."`;
              } else if (result.method === 'whatsapp' && result.whatsappNumber) {
                toolResponse = `SUCCESS: Delivery preference saved. Use this exact customer-facing confirmation: "Perfect, I've saved WhatsApp delivery to ${result.whatsappNumber}. We'll share your secure download link within 10 working days after the shoot."`;
              } else {
                toolResponse = `SUCCESS: Delivery preference saved as ${result.method}. Use this exact customer-facing confirmation: "Perfect, I've saved your delivery preference. We'll share your secure download link within 10 working days after the shoot."`;
              }
            }
            else if (functionName === 'add_session_note') {
              const noteResult = await this.executeAddNoteTool(customerId, args.bookingDate, args.note, args.type);
              if (noteResult.created) {
                toolResponse = `SUCCESS: Note added to session as ${noteResult.type}.`;
              } else {
                toolResponse = `INFO: Note not queued (${noteResult.reason || 'non-actionable'}).`;
              }
            }
            else if (functionName === 'get_available_slots') {
              const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => args.service.toLowerCase().includes(k));
              if (!serviceKey) {
                toolResponse = `ERROR: "${args.service}" isn't one of our packages. Valid packages are: ${Object.keys(SERVICE_DURATIONS).join(', ')}. Ask the customer to pick one of these.`;
              } else {
                const duration = SERVICE_DURATIONS[serviceKey];
                const result: any = await bookingService.getAvailableSlots(args.date, duration);
                // Spell out the weekday so the model never has to infer it from the raw ISO date.
                const dateLabel = `${dayjs(args.date).format('dddd, MMMM D, YYYY')} (${args.date})`;

                if (result.status === 'closed') {
                  toolResponse = `The business is CLOSED on ${dateLabel} because: ${result.reason}.`;
                } else {
                  const slots = Array.isArray(result) ? result : [];
                  toolResponse = `Available slots for ${args.service} on ${dateLabel}: ${slots.length > 0 ? slots.join(', ') : 'None'}. When referring to this date with the customer, use exactly this weekday - do not guess it.`;
                }
              }
            } else {
              toolResponse = `ERROR: Tool ${functionName} not found.`;
            }
          } catch (e: any) {
            console.error(`Tool execution error (${functionName}):`, e);
            if (functionName === 'propose_reschedule' || functionName === 'confirm_reschedule') {
              await this.notifyRescheduleAdmin({
                customerId,
                event: 'failed',
                newDate: args?.newDate,
                newTime: args?.newTime,
                reason: e?.message,
              });
            }
            if (functionName === 'cancel_booking') {
              await notifyAdmin(
                'booking',
                `Cancellation failed for ${customerId}`,
                `Cancellation tool failed: ${e?.message || 'Unknown error'}`,
                { customerId, event: 'cancel_failed', reason: e?.message }
              );
            }
            toolResponse = `ERROR: ${e.message}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResponse
          });
        }
      }

      currentResponse = await this.createCompletionWithToolNameGuard({
        model: CHAT_MODEL,
        messages,
        tools: allTools,
        tool_choice: 'auto',
        temperature: 0.3
      }, allowedToolNames);
      tokensUsed += currentResponse.usage?.total_tokens || 0;
    }

    return {
      content: this.formatCustomerReply(currentResponse.choices[0].message.content || "I'm sorry, I couldn't process that."),
      tokensUsed,
    };
  }

  /**
   * Handles an incoming message from a customer, with conversation history.
   * Wraps runAgent with a circuit breaker, per-customer daily token budget,
   * best-effort frustration detection, and AI job metrics. Never throws -
   * always resolves to a string that's safe to send to the customer.
   */
  async handleMessage(customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<string> {
    const startedAt = Date.now();
    const naturalAssistantMode = this.isNaturalAssistantModeEnabled();

    console.log('[AGENT_FLOW] handleMessage start:', JSON.stringify({
      customerId,
      platform,
      messagePreview: userMessage.slice(0, 200),
      historyLength: history.length,
      naturalAssistantMode
    }));

    // Best-effort frustration flagging - keyword heuristic, no extra AI call/cost.
    this.trackSentiment(customerId, userMessage).catch(err => console.error('Sentiment tracking failed:', err));

    if (circuitBreaker.isOpen()) {
      console.log('[AGENT_FLOW] Circuit breaker is open; returning fallback reply.');
      const fallbackReply = FALLBACK_MESSAGE;
      await this.logAiJobMetric({
        customerId, platform, success: false, isFallback: true,
        failureReason: 'circuit_open', circuitBreakerTrip: true,
        circuitBreakerReason: 'Reply pipeline failing repeatedly, cooling down',
        latencyMs: Date.now() - startedAt
      });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: fallbackReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: false,
        isFallback: true,
      });
      // Rate-limited to one admin alert per cooldown window - the circuit
      // stays open across many incoming messages while tripped, and without
      // this guard each one would raise its own duplicate escalation.
      if (shouldNotifyOutage()) {
        await this.escalate(customerId, 'error', 'AI circuit breaker is open due to repeated failures - customers are getting the canned fallback message.');
      }
      return fallbackReply;
    }

    const withinBudget = await this.checkTokenBudget(customerId);
    console.log('[AGENT_FLOW] Budget check result:', { customerId, withinBudget });
    if (!withinBudget) {
      console.log('[AGENT_FLOW] Daily token budget exceeded; returning fallback reply.', {
        customerId,
        dailyTokenCap: DAILY_TOKEN_CAP,
        platform
      });
      const fallbackReply = FALLBACK_MESSAGE;
      await this.logAiJobMetric({
        customerId, platform, success: false, isFallback: true,
        failureReason: 'daily_token_limit_exceeded', latencyMs: Date.now() - startedAt
      });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: fallbackReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: false,
        isFallback: true,
      });
      await this.escalate(
        customerId,
        'quota',
        `Customer hit the daily AI token budget (cap: ${DAILY_TOKEN_CAP}). The bot sent the quota fallback instead of continuing the conversation.`
      );
      return fallbackReply;
    }

    // Deterministic status reply to prevent contradictions after booking or
    // reschedule confirmations when the customer asks if it's done.
    const bookingStatusReply = this.shouldUseBookingStatusReply(userMessage);
    console.log('[AGENT_FLOW] Booking status route check:', { customerId, bookingStatusReply, naturalAssistantMode });
    if (bookingStatusReply) {
      const statusReply = await this.getBookingStatusReply(customerId);
      if (statusReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: statusReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return statusReply;
      }
    }

    if (this.shouldUseUpcomingAppointmentTimeReply(userMessage)) {
      const appointmentTimeReply = await this.getUpcomingAppointmentTimeReply(customerId);
      if (appointmentTimeReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: appointmentTimeReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return appointmentTimeReply;
      }
    }

      if (this.shouldUsePastAppointmentReply(userMessage) || this.isPastAppointmentFollowUp(userMessage, history)) {
        const pastAppointmentReply = await this.getPastAppointmentReply(customerId);
        if (pastAppointmentReply) {
          await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
          await this.logConversationLearning({
            customerId,
            userMessage,
            aiResponse: pastAppointmentReply,
            platform,
            latencyMs: Date.now() - startedAt,
            wasSuccessful: true,
            isFallback: false,
          });
          return pastAppointmentReply;
        }
      }

    // Deterministic multi-person booking clarification to avoid pricing/
    // scheduling ambiguity before booking confirmation.
    if (this.shouldUseMultiPersonBookingReply(userMessage)) {
      await this.captureMultiPersonBookingNote(customerId, userMessage).catch((err) => {
        console.error('Failed to capture multi-person booking note:', err);
      });

      const multiPersonReply = this.getMultiPersonBookingReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: multiPersonReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return multiPersonReply;
    }

    // Deterministic resend handling: only resend payment prompts when there's
    // an actual pending payment; never offer resend after successful payment.
    if (this.shouldHandleResendRequest(userMessage)) {
      const resendReply = await this.tryHandlePaymentResend(customerId);
      if (resendReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: resendReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return resendReply;
      }
    }

    // In natural assistant mode, keep critical guardrails deterministic but
    // let low-risk informational replies be generated naturally by the LLM.
    const allowDeterministicInfoReplies = !naturalAssistantMode;
    const informationalFlow = this.conversationFlowHandler.resolveInformationalFlow(userMessage, history);

    if (informationalFlow === 'business_introduction') {
      const businessIntroductionReply = this.getBusinessIntroductionReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: businessIntroductionReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return businessIntroductionReply;
    }

    if (informationalFlow === 'weekday') {
      const weekdayReply = this.getWeekdayReply(userMessage, history);
      if (weekdayReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: weekdayReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return weekdayReply;
      }
    }

    if (informationalFlow === 'website') {
      const websiteReply = this.getWebsiteReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: websiteReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return websiteReply;
    }

    if (informationalFlow === 'contact_details') {
      const contactDetailsReply = this.getContactDetailsReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: contactDetailsReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return contactDetailsReply;
    }

    if (informationalFlow === 'portfolio') {
      const portfolioReply = this.getPortfolioReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: portfolioReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return portfolioReply;
    }

    // Deterministic social media response for concise, consistent links.
    if (allowDeterministicInfoReplies && this.shouldUseSocialMediaReply(userMessage)) {
      const socialReply = this.getSocialMediaReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: socialReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return socialReply;
    }

    // Deterministic raw-files policy response for direct, accurate answers.
    if (allowDeterministicInfoReplies && this.shouldUseRawFilesReply(userMessage)) {
      const rawFilesReply = this.getRawFilesReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: rawFilesReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return rawFilesReply;
    }

    // Deterministic additions & extra services response.
    if (allowDeterministicInfoReplies && this.shouldUseAdditionsReply(userMessage)) {
      const additionsReply = this.getAdditionsReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: additionsReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return additionsReply;
    }

    // Deterministic bespoke experiences response.
    if (allowDeterministicInfoReplies && this.shouldUseBespokeReply(userMessage)) {
      const bespokeReply = this.getBespokeReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: bespokeReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return bespokeReply;
    }

    // Deterministic travelling mothers response.
    if (allowDeterministicInfoReplies && this.shouldUseTravellingMothersReply(userMessage)) {
      const travellingReply = this.getTravellingMothersReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: travellingReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return travellingReply;
    }

    // Deterministic earliest-delivery-date response with plain-text formatting.
    if (allowDeterministicInfoReplies && this.shouldUseEarliestImageDeliveryReply(userMessage)) {
      const deliveryReply = await this.getEarliestImageDeliveryReply(customerId);
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: deliveryReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return deliveryReply;
    }

    // Deterministic post-shoot process response for consistent expectations
    // and delivery-preference capture CTA.
    if (allowDeterministicInfoReplies && this.shouldUsePostShootProcessReply(userMessage)) {
      const postShootReply = this.getPostShootProcessReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: postShootReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return postShootReply;
    }

    // Deterministic booking process response for consistent policy wording.
    if (allowDeterministicInfoReplies && this.shouldUseBookingProcessReply(userMessage)) {
      const processReply = await this.getBookingProcessReply();
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: processReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      return processReply;
    }

    // Deterministic catalog response to avoid unreadable markdown tables and
    // keep package replies consistent across chat channels.
    if (this.conversationFlows.isTimeOnlyRescheduleSelection(userMessage, history)) {
      const rescheduleProposalReply = await this.getRescheduleTimeProposalReply(customerId, userMessage);
      if (rescheduleProposalReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: rescheduleProposalReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return rescheduleProposalReply;
      }
    }

    if (this.conversationFlows.isTimeOnlyRescheduleRequest(userMessage)) {
      const rescheduleTimeReply = await this.getRescheduleTimeReply(customerId);
      if (rescheduleTimeReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: rescheduleTimeReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return rescheduleTimeReply;
      }
    }

    if (this.conversationFlows.isSameBookingSlotRequest(userMessage)) {
      const sameSlotReply = await this.getSameBookingSlotReply(customerId, history);
      if (sameSlotReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: sameSlotReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return sameSlotReply;
      }
    }

    if (this.conversationFlows.isPackageSelection(userMessage)) {
      const selectionReply = await this.getPackageSelectionReply(customerId, userMessage);
      if (selectionReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: selectionReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return selectionReply;
      }
    }

    if (this.conversationFlows.isPackageAdviceRequest(userMessage)) {
      const adviceReply = await this.getPackageAdviceReply(userMessage);
      if (adviceReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: adviceReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return adviceReply;
      }
    }

    if (this.conversationFlows.isPackageCatalogRequest(userMessage)) {
      const catalogReply = await this.getPackageCatalogReply();
      if (catalogReply) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: catalogReply,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return catalogReply;
      }
    }

    // A short "yes" only confirms a proposal that the customer saw in the
    // immediately preceding assistant message. This prevents stale drafts
    // from being applied when the assistant was actually asking for details.
    if (
      (platform === 'whatsapp' || platform === 'web') &&
      this.isExplicitConfirmation(userMessage) &&
      this.previousMessageRequestsConfirmation(history)
    ) {
      const immediate = await this.tryImmediateConfirmation(customerId);
      if (immediate) {
        await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
        await this.logConversationLearning({
          customerId,
          userMessage,
          aiResponse: immediate,
          platform,
          latencyMs: Date.now() - startedAt,
          wasSuccessful: true,
          isFallback: false,
        });
        return immediate;
      }
    }

    try {
      console.log('[AGENT_FLOW] No deterministic early exit matched; invoking runAgent()');
      const { content, tokensUsed } = await this.runAgent(customerId, userMessage, history, platform);
      console.log('[AGENT_FLOW] runAgent() completed successfully:', JSON.stringify({
        customerId,
        tokensUsed,
        replyPreview: content.slice(0, 200)
      }));
      circuitBreaker.recordSuccess();
      await this.recordTokenUsage(customerId, tokensUsed);
      await this.logAiJobMetric({ customerId, platform, success: true, latencyMs: Date.now() - startedAt });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: content,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: true,
        isFallback: false,
      });
      this.touchCustomerMemory(customerId, userMessage, platform).catch(err => console.error('Customer memory update failed:', err));
      return content;
    } catch (error: any) {
      console.error('[AGENT_FLOW] Agent reply pipeline failed:', error);
      console.log('[AGENT_FLOW] Failure classification:', JSON.stringify({
        customerId,
        errorName: error?.name,
        errorMessage: error?.message,
        status: error?.status,
        code: error?.code,
        isRateLimit: isProviderRateLimitError(error)
      }));
      const justTripped = circuitBreaker.recordFailure();
      const isOutage = isProviderRateLimitError(error);
      const fallbackReply = FALLBACK_MESSAGE;
      await this.logAiJobMetric({
        customerId, platform, success: false, isFallback: true,
        failureReason: isOutage ? 'groq_daily_token_cap_reached' : String(error.message || error).slice(0, 200),
        circuitBreakerTrip: justTripped,
        circuitBreakerReason: justTripped ? 'Repeated failures in the reply pipeline' : undefined,
        latencyMs: Date.now() - startedAt
      });
      await this.logConversationLearning({
        customerId,
        userMessage,
        aiResponse: fallbackReply,
        platform,
        latencyMs: Date.now() - startedAt,
        wasSuccessful: false,
        isFallback: true,
      });
      // The Groq account-wide daily cap is a total outage affecting every
      // customer, not this one - flag it distinctly (and rate-limited) so it
      // doesn't get buried among normal per-customer escalations.
      if (isOutage && shouldNotifyOutage()) {
        await this.escalate(customerId, 'error', `AI PROVIDER OUTAGE: Groq's daily token limit has been reached - ALL customers are currently getting the fallback message, not just this one. It resets on its own; check console.groq.com/settings/billing if this keeps recurring. Original error: ${error.message}`);
      } else if (justTripped && !isOutage) {
        await this.escalate(customerId, 'error', `Circuit breaker just tripped: ${error.message}`);
      }
      return fallbackReply;
    }
  }

  private isExplicitConfirmation(userMessage: string): boolean {
    const normalized = userMessage
      .trim()
      .toLowerCase()
      .replace(/[!?.,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized || normalized.length > 40) return false;

    // Guard against ambiguous/negative replies that should not auto-confirm.
    if (/\b(no|not|don't|dont|cancel|wait|hold)\b/.test(normalized)) return false;

    const confirmations = new Set([
      'yes', 'y', 'yep', 'yeah', 'yess', 'yesss',
      'ok', 'okay', 'confirm', 'confirmed',
      'go ahead', 'go-ahead', 'proceed', 'continue',
      'that works', 'works for me', 'that one', 'same one', 'lets do that', "let's do that", 'let us do that',
      'sawa', 'ndio'
    ]);

    if (confirmations.has(normalized)) return true;

    // Accept short natural affirmations like "yes that works for me" or
    // "yess that one" for pending booking/reschedule drafts.
    return [
      /^yes+s?\b/,
      /^yep\b/,
      /^yeah\b/,
      /^ok(ay)?\b/,
      /^confirm(ed)?\b/,
      /^go[\s-]?ahead\b/,
      /^that works\b/,
      /^works for me\b/,
      /^that one\b/,
      /^same one\b/,
      /^let'?s do that\b/,
      /^let us do that\b/
    ].some((pattern) => pattern.test(normalized));
  }

  private previousMessageRequestsConfirmation(history: { role: 'user' | 'assistant', content: string }[]): boolean {
    const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content.toLowerCase() || '';
    return /(?:reply\s+["“”']?yes["“”']?|if\s+that\s+works\s+for\s+you.*reply\s+["“”']?yes["“”']?|would\s+you\s+like\s+me\s+to\s+confirm|confirm\s+that\s+change|confirm\s+the\s+change|shall\s+i\s+confirm)/.test(previousAssistantMessage);
  }

  private async tryImmediateConfirmation(customerId: string): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (!draft?.step) return null;

    if (draft.step === 'payment_pending') {
      return `I’ve already sent the M-Pesa deposit prompt to your phone for ${draft.service || 'your booking'}. Please complete the payment there and I’ll confirm the booking as soon as it succeeds.`;
    }

    if (draft.step === 'awaiting_confirmation') {
      const result = await this.executeConfirmBookingTool(customerId, 'awaiting_confirmation');
      return `I've sent the M-Pesa deposit prompt of KSH ${result.depositAmount} to your phone. Enter your PIN to complete it, and I'll confirm your ${result.service} session once the payment goes through.`;
    }

    if (draft.step === 'reschedule_confirm') {
      const result = await this.executeConfirmRescheduleTool(customerId, 'reschedule_confirm');
      await this.notifyRescheduleAdmin({
        customerId,
        event: 'confirmed',
        service: result.service,
        oldDateTime: result.oldDateTime,
        newDateTime: result.newDateTime,
      });
      return customerReplyTemplates.rescheduleConfirmed(result.service, dayjs(result.newDateTime).format('dddd, MMMM D, YYYY [at] h:mm A'));
    }

    return null;
  }

  private async tryHandlePaymentResend(customerId: string): Promise<string | null> {
    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });

    // Valid resend path: customer has a pending payment draft.
    if (draft?.step === 'payment_pending') {
      const payment = await prisma.payment.findFirst({
        where: { bookingDraftId: draft.id, status: { in: ['pending', 'failed'] } },
        orderBy: { updatedAt: 'desc' },
      });

      if (!payment) {
        return 'I cannot find an active payment request to resend right now. Please say "book" and I will re-open the booking payment step for you.';
      }

      try {
        const mpesaResponse = await mpesaService.initiateStkPush(customerId, payment.amount, draft.id);
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'pending',
            checkoutRequestId: mpesaResponse.CheckoutRequestID,
            updatedAt: new Date(),
          }
        });

        return `Done - I've resent the M-Pesa deposit prompt of KSH ${payment.amount} to your phone. Please enter your PIN to complete payment.`;
      } catch (error: any) {
        console.error('Failed to resend M-Pesa STK push:', error);
        return `I couldn't resend the payment prompt right now. Please try again in a minute, or I can have the team assist immediately.`;
      }
    }

    // If a successful payment already exists for an upcoming confirmed booking,
    // never offer to resend payment.
    const confirmedPaidBooking = await prisma.payment.findFirst({
      where: {
        status: 'success',
        booking: {
          customerId,
          status: 'confirmed',
          dateTime: { gte: new Date() },
        }
      },
      include: { booking: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (confirmedPaidBooking?.booking) {
      return `Your payment is already successful and your booking is confirmed for ${confirmedPaidBooking.booking.service} on ${dayjs(confirmedPaidBooking.booking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}. No resend is needed.`;
    }

    return null;
  }

  /**
   * Keyword-based frustration check, run on every inbound message. Cheap
   * enough to never skip - no LLM call involved. Best-effort: failures here
   * must never break the actual reply.
   */
  private async trackSentiment(customerId: string, userMessage: string): Promise<void> {
    const { score, sentiment, confidence } = scoreSentiment(userMessage);

    await prisma.sentimentScore.create({
      data: { customerId, score, sentiment, confidence, triggeredAlert: score <= -0.6 }
    });

    if (score <= -0.6) {
      await this.escalate(customerId, 'frustration', `Customer message scored ${score.toFixed(2)} (${sentiment}) on the frustration heuristic.`, score);
    }
  }

  /**
   * Keeps CustomerMemory current with cheap, directly-derivable facts (no
   * extra LLM call - deeper summarization is a separate feature to build
   * later if wanted). Best-effort: failures here must never break the reply.
   */
  private async touchCustomerMemory(customerId: string, userMessage: string, platform: string): Promise<void> {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return; // customer doesn't exist yet (e.g. first-ever web chat message)

    const summary = userMessage.length > 200 ? userMessage.slice(0, 200) + '…' : userMessage;
    const existing = await prisma.customerMemory.findUnique({ where: { customerId } });

    await prisma.customerMemory.upsert({
      where: { customerId },
      update: {
        relationshipStage: existing?.relationshipStage === 'new' || !existing ? 'interested' : existing.relationshipStage,
        lastInteractionSummary: summary,
        preferredChannel: platform
      },
      create: {
        customerId,
        relationshipStage: 'interested',
        lastInteractionSummary: summary,
        preferredChannel: platform
      }
    });
  }

  /**
   * Creates an escalation row so a human knows to follow up. Best-effort -
   * a failure here must never break the actual customer-facing reply.
   */
  private async escalate(customerId: string, escalationType: string, description: string, sentimentScore?: number): Promise<void> {
    try {
      await prisma.escalation.create({
        data: { customerId, escalationType, description, status: 'OPEN', sentimentScore }
      });
      await notifyAdmin(
        'escalation',
        `Customer ${customerId} needs attention`,
        description,
        { customerId, escalationType, sentimentScore }
      );
    } catch (err) {
      console.error('Failed to create escalation:', err);
    }
  }

  /**
   * Emits operational notifications for reschedule milestones/failures
   * without automatically creating escalations.
   */
  private async notifyRescheduleAdmin(params: {
    customerId: string;
    event: 'proposed' | 'confirmed' | 'failed';
    service?: string;
    oldDateTime?: Date;
    newDate?: string;
    newTime?: string;
    newDateTime?: Date;
    reason?: string;
  }): Promise<void> {
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: params.customerId },
        select: { name: true, phone: true }
      });

      const actor = customer?.name && customer.name !== 'WhatsApp User'
        ? `${customer.name} (${customer.phone || params.customerId})`
        : customer?.phone || params.customerId;

      if (params.event === 'proposed') {
        await notifyAdmin(
          'reschedule',
          `Reschedule proposed: ${actor}`,
          `${params.service || 'Session'} proposed from ${params.oldDateTime ? dayjs(params.oldDateTime).format('YYYY-MM-DD HH:mm') : 'current slot'} to ${params.newDate} ${params.newTime}. Awaiting customer confirmation.`,
          {
            customerId: params.customerId,
            event: params.event,
            service: params.service,
            oldDateTime: params.oldDateTime?.toISOString(),
            newDate: params.newDate,
            newTime: params.newTime,
          }
        );
        return;
      }

      if (params.event === 'confirmed') {
        await notifyAdmin(
          'reschedule',
          `Reschedule confirmed: ${actor}`,
          `${params.service || 'Session'} moved from ${params.oldDateTime ? dayjs(params.oldDateTime).format('YYYY-MM-DD HH:mm') : 'previous slot'} to ${params.newDateTime ? dayjs(params.newDateTime).format('YYYY-MM-DD HH:mm') : `${params.newDate} ${params.newTime}`}.`,
          {
            customerId: params.customerId,
            event: params.event,
            service: params.service,
            oldDateTime: params.oldDateTime?.toISOString(),
            newDateTime: params.newDateTime?.toISOString(),
          }
        );
        return;
      }

      await notifyAdmin(
        'reschedule',
        `Reschedule failed: ${actor}`,
        `Reschedule attempt failed: ${params.reason || 'Unknown reason'}`,
        {
          customerId: params.customerId,
          event: params.event,
          service: params.service,
          newDate: params.newDate,
          newTime: params.newTime,
          reason: params.reason,
        }
      );
    } catch (err) {
      console.error('Failed to emit reschedule admin notification:', err);
    }
  }

  private async logAiJobMetric(data: {
    customerId: string; platform: string; success: boolean; latencyMs: number;
    failureReason?: string; isFallback?: boolean; circuitBreakerTrip?: boolean; circuitBreakerReason?: string;
  }): Promise<void> {
    try {
      await prisma.aiJobMetric.create({ data });
    } catch (err) {
      console.error('Failed to log AI job metric:', err);
    }
  }

  /**
   * Resets and checks a customer's rolling daily token budget. Missing customer
   * = allow (nothing to enforce yet). Only enforced in production - during
   * development a single person's own testing traffic blows past a budget
   * meant to catch runaway/abusive customers long before real usage would.
   */
  private async checkTokenBudget(customerId: string): Promise<boolean> {
    if (process.env.NODE_ENV !== 'production') return true;

    // Optional: allow exempting tester or admin phone numbers via comma-separated list
    const exemptNumbers = (process.env.EXEMPT_TOKEN_CAP_NUMBERS || '')
      .split(',')
      .map(n => n.trim().replace(/\D/g, ''))
      .filter(Boolean);
    const cleanId = customerId.replace(/\D/g, '');
    if (cleanId && exemptNumbers.includes(cleanId)) {
      return true;
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { dailyTokenUsage: true, tokenResetDate: true }
    });
    if (!customer) return true;

    const isNewDay = !customer.tokenResetDate || customer.tokenResetDate.toDateString() !== new Date().toDateString();
    const currentUsage = isNewDay ? 0 : customer.dailyTokenUsage;
    return currentUsage < DAILY_TOKEN_CAP;
  }

  /** Records token usage after a successful reply, resetting the daily counter if a new day has started. */
  private async recordTokenUsage(customerId: string, tokensUsed: number): Promise<void> {
    if (tokensUsed <= 0) return;
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { dailyTokenUsage: true, tokenResetDate: true }
      });
      if (!customer) return; // customer created later in the flow (e.g. at booking time) - nothing to update yet

      const isNewDay = !customer.tokenResetDate || customer.tokenResetDate.toDateString() !== new Date().toDateString();
      await prisma.customer.update({
        where: { id: customerId },
        data: {
          dailyTokenUsage: isNewDay ? tokensUsed : { increment: tokensUsed },
          tokenResetDate: new Date(),
          totalTokensUsed: { increment: tokensUsed }
        }
      });
    } catch (err) {
      console.error('Failed to record token usage:', err);
    }
  }

  /**
   * Step 1 of 2: validates the package/date and saves a BookingDraft in
   * 'awaiting_confirmation' - tells the customer the deposit amount, but never
   * touches M-Pesa. No payment prompt gets sent until confirm_booking runs,
   * which can only happen on a later turn (see initialDraftStep in runAgent).
   */
  private async executeProposeBookingTool(customerId: string, name: string, service: string, date: string) {
    if (!name || name.trim() === '' || name.trim().toLowerCase() === 'unknown') {
      throw new Error('Customer name is required before proposing a booking. Ask the customer for their full name first.');
    }

    let customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
       customer = await prisma.customer.create({
           data: { id: customerId, name: name }
       });
    } else if (customer.name !== name) {
       await prisma.customer.update({ where: { id: customerId }, data: { name }});
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => service.toLowerCase().includes(k));
    if (!serviceKey) {
      throw new Error(`"${service}" isn't one of our packages. Valid packages are: ${Object.keys(SERVICE_DURATIONS).join(', ')}. Ask the customer to pick one of these before booking.`);
    }

    // Fetch package to get deposit amount
    const pkg = await prisma.package.findFirst({
      where: { name: { contains: serviceKey, mode: 'insensitive' } }
    });
    const depositAmount = pkg?.deposit || 2000;

    await bookingDraftService.saveBookingProposal({
      customerId: customer.id,
      service,
      dateTime: date,
      customerName: name,
    });

    return { depositAmount };
  }

  /**
   * Step 2 of 2: actually sends the M-Pesa STK push. Only proceeds if
   * initialDraftStep (captured at the START of this turn, before any tool
   * calls ran) was already 'awaiting_confirmation' - meaning propose_booking
   * happened on a PRIOR message, not earlier in this same turn. This is what
   * guarantees the customer explicitly agreed before any prompt is sent.
   */
  private async executeConfirmBookingTool(customerId: string, initialDraftStep: string | undefined) {
    if (initialDraftStep !== 'awaiting_confirmation') {
      throw new Error('No pending booking proposal from a prior message. Call propose_booking first and wait for the customer to explicitly confirm on their own next message before calling confirm_booking.');
    }

    const draft = await bookingDraftService.get(customerId);
    if (!draft || draft.step !== 'awaiting_confirmation') {
      throw new Error('No pending booking proposal found. Call propose_booking first.');
    }

    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => draft.service?.toLowerCase().includes(k)) || 'standard';
    const pkg = await prisma.package.findFirst({
      where: { name: { contains: serviceKey, mode: 'insensitive' } }
    });
    const depositAmount = pkg?.deposit || 2000;

    await bookingDraftService.markPaymentPending(customerId);

    // Initiate M-Pesa STK Push using draft ID as reference
    try {
      const mpesaResponse = await mpesaService.initiateStkPush(customerId, depositAmount, draft.id);

      // Upsert payment record linked to the draft
      await prisma.payment.upsert({
        where: { bookingDraftId: draft.id },
        update: {
          amount: depositAmount,
          status: 'pending',
          checkoutRequestId: mpesaResponse.CheckoutRequestID,
          updatedAt: new Date()
        },
        create: {
          bookingDraftId: draft.id,
          amount: depositAmount,
          phone: customerId,
          status: 'pending',
          checkoutRequestId: mpesaResponse.CheckoutRequestID
        }
      });

      return {
        success: true,
        draftId: draft.id,
        depositAmount: depositAmount,
        service: draft.service,
        date: draft.date,
        time: draft.time,
        checkoutRequestId: mpesaResponse.CheckoutRequestID
      };
    } catch (error: any) {
      console.error('Failed to initiate M-Pesa STK Push:', error);
      throw new Error(`We couldn't initiate the payment request. Error: ${error.message}`);
    }
  }

  /**
   * Step 1 of 2 for rescheduling: validates there's an upcoming confirmed
   * booking and saves the proposed new date/time on the customer's
   * BookingDraft. Does NOT touch the real booking yet.
   */
  private async executeProposeRescheduleTool(customerId: string, newDate: string, newTime: string) {
    const upcomingBooking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' }
    });

    if (!upcomingBooking) {
      throw new Error('No upcoming confirmed booking found to reschedule.');
    }

    // Verify the proposed new slot is actually free before proposing it - this
    // can't be left to the model remembering to call get_available_slots first.
    const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => upcomingBooking.service.toLowerCase().includes(k)) || 'standard';
    const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;
    const slotsResult: any = await bookingService.getAvailableSlots(newDate, duration, upcomingBooking.id);

    // Spell out the weekday so the model never has to infer it from the raw ISO date.
    const newDateLabel = `${dayjs(newDate).format('dddd, MMMM D, YYYY')} (${newDate})`;

    if (slotsResult.status === 'closed') {
      throw new Error(`We're closed on ${newDateLabel} (${slotsResult.reason}). Ask the customer to pick a different date. Always refer to the date using this exact weekday.`);
    }
    const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
    if (!availableSlots.includes(newTime)) {
      throw new Error(`${newTime} on ${newDateLabel} isn't available. Available times that day: ${availableSlots.length > 0 ? availableSlots.join(', ') : 'none'}. Ask the customer to pick one of these instead. Always refer to the date using this exact weekday - do not guess it.`);
    }

    const newDateTimeIso = `${newDate}T${newTime}`;

    await prisma.bookingDraft.upsert({
      where: { customerId },
      update: {
        bookingId: upcomingBooking.id,
        service: upcomingBooking.service,
        date: newDate,
        time: newTime,
        dateTimeIso: newDateTimeIso,
        step: 'reschedule_confirm'
      },
      create: {
        customerId,
        bookingId: upcomingBooking.id,
        service: upcomingBooking.service,
        date: newDate,
        time: newTime,
        dateTimeIso: newDateTimeIso,
        step: 'reschedule_confirm'
      }
    });

    return {
      service: upcomingBooking.service,
      oldDateTime: upcomingBooking.dateTime,
    };
  }

  /**
   * Step 2 of 2: applies the reschedule for real. Only proceeds if
   * initialDraftStep (captured at the START of this turn) was already
   * 'reschedule_confirm' - meaning propose_reschedule happened on a PRIOR
   * message, not earlier in this same turn.
   */
  private async executeConfirmRescheduleTool(customerId: string, initialDraftStep: string | undefined) {
    if (initialDraftStep !== 'reschedule_confirm') {
      throw new Error('No pending reschedule proposal from a prior message. Call propose_reschedule first and wait for the customer to explicitly confirm on their own next message.');
    }

    const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
    if (!draft || draft.step !== 'reschedule_confirm' || !draft.bookingId || !draft.dateTimeIso) {
      throw new Error('No pending reschedule proposal found. Call propose_reschedule first.');
    }

    const upcomingBooking = await prisma.booking.findUnique({
      where: { id: draft.bookingId },
      include: { customer: true }
    });
    if (!upcomingBooking) {
      throw new Error('The booking being rescheduled no longer exists.');
    }

    const newDateTime = new Date(draft.dateTimeIso);

    await prisma.booking.update({
      where: { id: upcomingBooking.id },
      data: { dateTime: newDateTime }
    });

    if (upcomingBooking.googleEventId) {
      const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => upcomingBooking.service.toLowerCase().includes(k)) || 'standard';
      const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

      await googleCalendarService.updateEvent(upcomingBooking.googleEventId, {
        service: upcomingBooking.service,
        dateTime: newDateTime,
        customerName: upcomingBooking.customer.name,
        durationMinutes: duration
      });
    }

    await prisma.bookingDraft.delete({ where: { customerId } }).catch(err => console.error('Failed to clear reschedule draft:', err));

    return {
      newDateTime,
      oldDateTime: upcomingBooking.dateTime,
      service: upcomingBooking.service,
    };
  }

  /**
   * Cancels the next upcoming confirmed booking and removes its Google
   * Calendar event if linked.
   */
  private async executeCancelBookingTool(customerId: string) {
    const booking = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      orderBy: { dateTime: 'asc' }
    });

    if (!booking) {
      throw new Error('No upcoming confirmed booking found to cancel.');
    }

    if (booking.googleEventId) {
      const deleted = await googleCalendarService.deleteEvent(booking.googleEventId);
      if (!deleted) {
        console.warn('Google Calendar delete failed during cancellation:', booking.googleEventId);
      }
    }

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        googleEventId: null,
      }
    });

    await prisma.bookingDraft.deleteMany({ where: { customerId } });

    const hoursUntil = dayjs(booking.dateTime).diff(dayjs(), 'hour', true);
    const refundEligible = hoursUntil > 72;

    await notifyAdmin(
      'booking',
      `Booking cancelled for ${customerId}`,
      `${booking.service} on ${dayjs(booking.dateTime).format('YYYY-MM-DD HH:mm')} was cancelled via AI assistant.`,
      {
        customerId,
        event: 'cancel_confirmed',
        bookingId: booking.id,
        service: booking.service,
        dateTime: booking.dateTime.toISOString(),
        refundEligible,
      }
    );

    return {
      bookingId: booking.id,
      service: booking.service,
      dateTime: booking.dateTime,
      refundEligible,
    };
  }

  private isPlaceholderContactEmail(email?: string | null): boolean {
    if (!email) return true;
    const value = email.trim().toLowerCase();
    if (!value) return true;
    return value.endsWith('@whatsapp.local') || value.endsWith('@messenger.local') || value.endsWith('@instagram.local');
  }

  /**
   * Saves customer's preferred edited-photo delivery method (especially email)
   * and emits an admin notification so the team can follow through.
   */
  private async executeSaveDeliveryPreferenceTool(
    customerId: string,
    method: 'email' | 'download_link' | 'whatsapp',
    email?: string,
    whatsappNumber?: string,
    note?: string,
    platform?: string,
  ) {
    const normalizedMethod = (method || '').toLowerCase();
    if (!['email', 'download_link', 'whatsapp'].includes(normalizedMethod)) {
      throw new Error('Invalid delivery method. Use email, download_link, or whatsapp.');
    }

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw new Error('Customer not found while saving delivery preference.');
    }

    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedWhatsappNumber = whatsappNumber?.trim();
    const emailFromCustomer = this.isPlaceholderContactEmail(customer.email) ? undefined : customer.email?.trim().toLowerCase();
    const resolvedEmail = normalizedEmail || emailFromCustomer;
    const resolvedWhatsappNumber = normalizedWhatsappNumber || customer.phone || customerId;

    if (normalizedMethod === 'email') {
      if (!resolvedEmail) {
        throw new Error('Email delivery requested but no email address is on file. Ask the customer for their exact email address first.');
      }
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(resolvedEmail)) {
        throw new Error('The provided email format looks invalid. Ask the customer to confirm the exact email address.');
      }

      if (customer.email !== resolvedEmail) {
        await prisma.customer.update({ where: { id: customerId }, data: { email: resolvedEmail } });
      }
    }

    const booking = await prisma.booking.findFirst({
      where: { customerId, dateTime: { gte: new Date() }, status: { not: 'cancelled' } },
      orderBy: { dateTime: 'asc' }
    });

    const description = [
      `Delivery preference: ${normalizedMethod}`,
      normalizedMethod === 'email' && resolvedEmail ? `Email: ${resolvedEmail}` : '',
      normalizedMethod === 'whatsapp' && resolvedWhatsappNumber ? `WhatsApp: ${resolvedWhatsappNumber}` : '',
      note ? `Note: ${note}` : ''
    ].filter(Boolean).join(' | ');

    await prisma.customerSessionNote.create({
      data: {
        customerId,
        bookingId: booking?.id,
        type: 'special_request',
        description,
        status: 'pending',
        platform: platform || 'whatsapp',
        sourceMessage: note?.trim() || undefined,
      }
    });

    await notifyAdmin(
      'booking',
      `Delivery preference captured for ${customerId}`,
      `${customer.name || customerId} prefers ${normalizedMethod}${normalizedMethod === 'email' && resolvedEmail ? ` via ${resolvedEmail}` : ''}${normalizedMethod === 'whatsapp' && resolvedWhatsappNumber ? ` via ${resolvedWhatsappNumber}` : ''}.`,
      {
        customerId,
        bookingId: booking?.id,
        event: 'delivery_preference',
        deliveryMethod: normalizedMethod,
        deliveryEmail: normalizedMethod === 'email' ? resolvedEmail : undefined,
        deliveryPhone: normalizedMethod === 'whatsapp' ? resolvedWhatsappNumber : undefined,
      }
    );

    return {
      method: normalizedMethod,
      email: normalizedMethod === 'email' ? resolvedEmail : undefined,
      whatsappNumber: normalizedMethod === 'whatsapp' ? resolvedWhatsappNumber : undefined,
    };
  }

  /**
   * Logic to save a note for a customer session
   */
  private async executeAddNoteTool(customerId: string, bookingDate: string, note: string, type: string): Promise<{ created: boolean; reason?: string; type?: string }> {
    const rawNote = (note || '').trim();
    if (!rawNote) {
      return { created: false, reason: 'empty_note' };
    }

    const normalized = rawNote.toLowerCase();
    const nonActionablePatterns = [
      /^no special requests? mentioned$/,
      /^no special requests?$/,
      /^no requests?$/,
      /^none$/,
      /^n\/a$/,
    ];
    if (nonActionablePatterns.some((pattern) => pattern.test(normalized))) {
      return { created: false, reason: 'non_actionable_note' };
    }

    let normalizedType = (type || 'other').trim().toLowerCase();
    if (normalizedType === 'other') {
      if (/(list of services|service list|show.*services|send.*services|package list|pricing)/i.test(rawNote)) {
        normalizedType = 'action_request';
      } else if (/(delivery preference|download link|email.*link|whatsapp.*link)/i.test(rawNote)) {
        normalizedType = 'special_request';
      }
    }

    const duplicateWindowStart = dayjs().subtract(24, 'hour').toDate();
    const duplicate = await prisma.customerSessionNote.findFirst({
      where: {
        customerId,
        status: 'pending',
        type: normalizedType,
        description: rawNote,
        createdAt: { gte: duplicateWindowStart },
      },
      select: { id: true },
    });
    if (duplicate) {
      return { created: false, reason: 'duplicate_pending_note', type: normalizedType };
    }

    // Customers often mention session details ("bringing family") before they've
    // confirmed a booking date at all - the AI still calls this tool, but with no
    // real date to work with (empty string, "unknown", etc). new Date() on that
    // silently produces an Invalid Date, which Prisma then throws on. Validate
    // first, and fall back to the nearest upcoming booking when there's no
    // usable date, so the note still lands somewhere instead of crashing the tool call.
    const parsedDate = bookingDate ? dayjs(bookingDate) : null;
    const booking = parsedDate?.isValid()
      ? await prisma.booking.findFirst({
          where: {
            customerId: customerId,
            dateTime: {
              gte: parsedDate.startOf('day').toDate(),
              lte: parsedDate.endOf('day').toDate()
            }
          }
        })
      : await prisma.booking.findFirst({
          where: { customerId, dateTime: { gte: new Date() } },
          orderBy: { dateTime: 'asc' }
        });

    const createdNote = await prisma.customerSessionNote.create({
      data: {
        customerId: customerId,
        bookingId: booking?.id,
        description: rawNote,
        type: normalizedType,
        status: 'pending',
      }
    });

    // Persist matched add-ons as priced line items (not only free-text notes)
    await bookingAddonService.createFromNote({
      customerId,
      bookingId: booking?.id,
      note: rawNote,
      sessionNoteId: createdNote.id,
    });

    if (normalizedType === 'action_request' || normalizedType === 'special_request') {
      await notifyAdmin(
        'booking',
        `Session note requires review for ${customerId}`,
        `${rawNote}${booking ? ` (Booking: ${booking.service} on ${dayjs(booking.dateTime).format('YYYY-MM-DD HH:mm')})` : ''}`,
        {
          customerId,
          bookingId: booking?.id,
          sessionNoteId: createdNote.id,
          noteType: normalizedType,
          event: 'session_note_review_required',
        }
      );
    }

    return { created: true, type: normalizedType };
  }
}

export const agentService = new AgentService();

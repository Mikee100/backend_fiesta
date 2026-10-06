import dayjs from 'dayjs';
import { PACKAGE_NAME_PATTERN, PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { businessDay, bookingDateFacts, nowInBusinessTimezone } from '../../utils/time';
import { CHAT_MODEL, createChatCompletion } from './llm/provider';

const MAX_EXTRACTOR_COMPLETION_TOKENS = 120;

export type BookingDetails = {
  name?: string | null;
  service?: string | null;
  date?: string | null;
  time?: string | null;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  completionCalls: number;
};

export function usageFromCompletion(response: any, completionCalls: number = 1): TokenUsage {
  return {
    inputTokens: response?.usage?.prompt_tokens || 0,
    outputTokens: response?.usage?.completion_tokens || 0,
    totalTokens: response?.usage?.total_tokens || 0,
    completionCalls,
  };
}

export function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.completionCalls += usage.completionCalls;
}

const MONTH_NAME_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO_DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Day-of-month only when written as an ordinal ("3rd"), next to a month name
 * ("3 Oct", "October 3") or inside an ISO date. Bare numbers ("7 months") and
 * hours ("3pm", "15:00") never count. `month` is 0-based when a month name was given.
 */
export function findExplicitDate(message: string): { day: number; month: number | null } | null {
  const text = message.toLowerCase();
  const iso = text.match(ISO_DATE_PATTERN);
  if (iso) return { day: Number(iso[1].slice(8, 10)), month: Number(iso[1].slice(5, 7)) - 1 };

  const dayThenMonth = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_NAME_PATTERN})\\b`));
  const monthThenDay = text.match(new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:am|pm|:\\d|\\.\\d))`));
  const ordinal = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);

  let day: number;
  let monthName: string | null = null;
  if (dayThenMonth) {
    day = Number(dayThenMonth[1]);
    monthName = dayThenMonth[2];
  } else if (monthThenDay) {
    day = Number(monthThenDay[2]);
    monthName = monthThenDay[1];
  } else if (ordinal) {
    day = Number(ordinal[1]);
  } else {
    return null;
  }
  if (day < 1 || day > 31) return null;
  return { day, month: monthName ? MONTH_ABBREVIATIONS.indexOf(monthName.slice(0, 3)) : null };
}

export function findExplicitDayOfMonth(message: string): number | null {
  return findExplicitDate(message)?.day ?? null;
}

export function resolveCalendarDate(message: string): string | null {
  const iso = message.match(ISO_DATE_PATTERN)?.[1];
  if (iso) {
    bookingDateFacts(iso);
    return iso;
  }
  const explicit = findExplicitDate(message);
  const now = nowInBusinessTimezone();
  if (explicit) {
    const year = message.match(/\b((?:19|20)\d{2})\b/)?.[1];
    const month = explicit.month ?? now.month();
    let date = now.date(1).year(year ? Number(year) : now.year()).month(month).date(explicit.day);
    if (!year && date.isBefore(now, 'day')) {
      date = explicit.month === null
        ? now.add(1, 'month').date(1).date(explicit.day)
        : date.add(1, 'year');
    }
    if (date.date() !== explicit.day || (explicit.month !== null && date.month() !== month)) {
      throw new Error('That calendar date is invalid. Please choose a valid date.');
    }
    const resolved = date.format('YYYY-MM-DD');
    bookingDateFacts(resolved);
    return resolved;
  }
  if (/\btomorrow\b/i.test(message)) return now.add(1, 'day').format('YYYY-MM-DD');
  if (/\btoday\b/i.test(message)) return now.format('YYYY-MM-DD');
  const weekday = message.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)?.[1]?.toLowerCase();
  if (!weekday) return null;
  const target = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekday);
  const offset = (target - now.day() + 7) % 7;
  return businessDay(now.add(offset || 7, 'day').format('YYYY-MM-DD')).format('YYYY-MM-DD');
}

export class BookingExtractor {
  private static cleanText(text: string): string {
    return text
      .replace(/[^ 0-\w\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** Public so callers can use BookingExtractor.regexExtract(text) without a cast. */
  public static regexExtract(text: string): BookingDetails {
    const cleanText = BookingExtractor.cleanText(text);

    if (cleanText.length < 10) return { name: null, service: null, date: null, time: null };

    const nameMatch = cleanText.match(/my name is ([a-z]{2,})/i)
      || cleanText.match(/this is ([a-z]{2,})/i)
      || cleanText.match(/i am ([a-z]{2,})/i);

    const serviceMatch = cleanText.match(
      new RegExp(`(?:the\\s+)?(${PACKAGE_NAME_PATTERN})(?:\\s+(?:package|edition))?`, 'i')
    );
    const isoDate = text.match(ISO_DATE_PATTERN)?.[1];
    const explicitDate = isoDate ? null : findExplicitDate(text);
    const timeMatch = cleanText.match(/(\d{1,2})(:|\s*)(\d{2})?\s*(am|pm)/i);

    let date;
    let time = null;

    if (timeMatch) {
      time = timeMatch[0].toLowerCase().replace(/\s/g, '');
    }
    if (isoDate && dayjs(isoDate).isValid()) {
      date = isoDate;
    } else if (explicitDate && explicitDate.month !== null) {
      const now = nowInBusinessTimezone();
      let parsed = now.month(explicitDate.month).date(explicitDate.day);
      if (parsed.isBefore(now, 'day')) parsed = parsed.add(1, 'year');
      if (parsed.month() === explicitDate.month && parsed.date() === explicitDate.day) {
        date = parsed.format('YYYY-MM-DD');
      }
    } else if (explicitDate) {
      const day = explicitDate.day;
      const now = nowInBusinessTimezone();
      let parsed = now.date(day);
      if (parsed.isValid() && parsed.isBefore(now, 'day')) {
        parsed = now.add(1, 'month').date(day);
      }
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

  private async aiExtract(message: string): Promise<{ details: BookingDetails; usage: TokenUsage }> {
    const now = nowInBusinessTimezone().format('dddd, MMMM D, YYYY h:mm A');
    const { response } = await createChatCompletion({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `Current Date/Time: ${now}\n\nExtract booking details from the user message.\n\nReturn ONLY valid JSON. No text.\n\nFormat:\n{\n  "name": string | null,\n  "service": string | null,\n  "date": string | null,\n  "time": string | null\n}\n\nRules:\n- Name must be full name if possible\n- Service must be one of the 2026 Editions: ${PACKAGE_NAMES_FOR_EXTRACTION.join(', ')} (or legacy: standard, economy, executive, gold, platinum, vip, vvip if the customer still uses those names)\n- Prefer Edition names like "THE EMPRESS" over legacy names\n- Convert date into YYYY-MM-DD\n- Convert time into 24h format (HH:mm)\n- If missing, return null\n`
        },
        { role: 'user', content: message }
      ],
      temperature: 0,
      max_completion_tokens: MAX_EXTRACTOR_COMPLETION_TOKENS,
    });
    let details: BookingDetails = {};
    try {
      details = JSON.parse(response.choices[0].message.content || '{}');
    } catch {
      details = {};
    }
    return { details, usage: usageFromCompletion(response) };
  }

  private hasBookingSignals(message: string): boolean {
    const text = message.toLowerCase();
    return /\b(\d{1,2})(st|nd|rd|th)?\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week)\b|\b(am|pm)\b|\bbook|\bschedule|\bappointment|\bsession|\bpackage|\bbloom|\bmuse|\bicon|\blegend|\bqueen|\bempress|\bgoddess|\bresched|\bcancel|\bdeposit|\bmpesa|\bpay/i.test(text);
  }

  private needsAiExtraction(message: string): boolean {
    const text = message.toLowerCase();
    const rescheduleSignal = /\b(reschedule|change|move|postpone)\b/.test(text);
    const hasDateSignal = /\b\d{1,2}(st|nd|rd|th)?\b|\b\d{4}-\d{2}-\d{2}\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+week)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(text);
    const hasTimeSignal = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{2}:\d{2}\b/.test(text);
    return rescheduleSignal && hasDateSignal && hasTimeSignal;
  }

  async extract(message: string): Promise<{ details: BookingDetails; usage: TokenUsage }> {
    const regex = BookingExtractor.regexExtract(message);
    console.log('Regex result:', regex);
    if (regex.name && regex.service && regex.date && regex.time) {
      return { details: regex, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, completionCalls: 0 } };
    }
    if (!this.needsAiExtraction(message)) {
      console.log('No reschedule date/time extraction needed - skipping AI extractor call.');
      return { details: regex, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, completionCalls: 0 } };
    }
    const { details: ai, usage } = await this.aiExtract(message);
    console.log('AI result:', ai);
    return {
      details: {
        name: regex.name || ai.name,
        service: regex.service || ai.service,
        date: regex.date || ai.date,
        time: regex.time || ai.time
      },
      usage
    };
  }
}
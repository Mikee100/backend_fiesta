
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

export function findExplicitDate(message: string): { day: number; month: number | null } | null {
  const text = message.toLowerCase();
  const iso = text.match(ISO_DATE_PATTERN);

  if (iso) {
    return {
      day: Number(iso[1].slice(8, 10)),
      month: Number(iso[1].slice(5, 7)) - 1,
    };
  }

  const dayThenMonth = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_NAME_PATTERN})\\b`)
  );

  const monthThenDay = text.match(
    new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:am|pm|:\\d|\\.\\d))`)
  );

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

  return {
    day,
    month: monthName ? MONTH_ABBREVIATIONS.indexOf(monthName.slice(0, 3)) : null,
  };
}

export function findExplicitDayOfMonth(message: string): number | null {
  return findExplicitDate(message)?.day ?? null;
}

export class InvalidDateError extends Error {
  constructor(message = 'That calendar date is invalid. Please choose a valid date.') {
    super(message);
    this.name = 'InvalidDateError';
  }
}

export const INVALID_DATE_REPLY =
  "That date doesn't exist on the calendar. Which date would you like for your session?";

export function resolveCalendarDate(message: string): string | null {
  const iso = message.match(ISO_DATE_PATTERN)?.[1];

  if (iso) {
    try {
      bookingDateFacts(iso);
    } catch {
      throw new InvalidDateError();
    }

    return iso;
  }

  const explicit = findExplicitDate(message);
  const now = nowInBusinessTimezone();

  if (explicit) {
    const year = message.match(/\b((?:19|20)\d{2})\b/)?.[1];
    const month = explicit.month ?? now.month();

    let date = now
      .date(1)
      .year(year ? Number(year) : now.year())
      .month(month)
      .date(explicit.day);

    if (!year && date.isBefore(now, 'day')) {
      date = explicit.month === null
        ? now.add(1, 'month').date(1).date(explicit.day)
        : date.add(1, 'year');
    }

    if (
      date.date() !== explicit.day
      || (explicit.month !== null && date.month() !== month)
    ) {
      throw new InvalidDateError();
    }

    const resolved = date.format('YYYY-MM-DD');
    bookingDateFacts(resolved);

    return resolved;
  }

  if (/\btomorrow\b/i.test(message)) {
    return now.add(1, 'day').format('YYYY-MM-DD');
  }

  if (/\btoday\b/i.test(message)) {
    return now.format('YYYY-MM-DD');
  }

  const weekday = message
    .match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)?.[1]
    ?.toLowerCase();

  if (!weekday) return null;

  const target = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ].indexOf(weekday);

  const offset = (target - now.day() + 7) % 7;

  return businessDay(
    now.add(offset || 7, 'day').format('YYYY-MM-DD')
  ).format('YYYY-MM-DD');
}

export class BookingExtractor {
  private static cleanText(text: string): string {
    return text
      .replace(/[^ 0-\w\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Common conversational words that must not be accepted as names.
   * Explicit name introductions are still checked against this list.
   */
  private static readonly NON_NAME_WORDS = new Set([
    'still',
    'early',
    'late',
    'alright',
    'okay',
    'fine',
    'good',
    'great',
    'well',
    'back',
    'here',
    'there',
    'pregnant',
    'looking',
    'interested',
    'wondering',
    'thinking',
    'trying',
    'planning',
    'considering',
    'hoping',
    'waiting',
    'expecting',
    'feeling',
    'ready',
    'not',
    'just',
    'already',
    'currently',
    'actually',
    'really',
    'very',
    'quite',
    'maybe',
    'happy',
    'excited',
    'curious',
    'unsure',
    'sure',
    'confused',
    'tired',
    'busy',
    'available',
    'married',
    'single',
  ]);

  private static isLikelyName(value: string | null | undefined): boolean {
    if (!value) return false;

    const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();

    // Only accept a first name or a two-part name.
    if (normalized.split(' ').length > 2) return false;

    // Support alphabetic names, hyphenated names, and apostrophes.
    if (!/^[a-z]+(?:[-'][a-z]+)?(?:\s[a-z]+(?:[-'][a-z]+)?)?$/i.test(normalized)) {
      return false;
    }

    const words = normalized.split(' ');

    if (words.some(word => BookingExtractor.NON_NAME_WORDS.has(word))) {
      return false;
    }

    return words.every(word => word.length >= 2);
  }

  public static regexExtract(text: string): BookingDetails {
    const cleanText = BookingExtractor.cleanText(text);

    if (cleanText.length < 10) {
      return {
        name: null,
        service: null,
        date: null,
        time: null,
      };
    }

    // Strong name signals only. Do not automatically interpret "I am X" as a name.
    const explicitNameMatch =
      cleanText.match(/\bmy name is ([a-z]{2,}(?:[-'][a-z]{2,})?)\b/i)
      || cleanText.match(/\bthis is ([a-z]{2,}(?:[-'][a-z]{2,})?)\b/i)
      || cleanText.match(/\bcall me ([a-z]{2,}(?:[-'][a-z]{2,})?)\b/i);

    const nameCandidate = explicitNameMatch?.[1] || null;

    const name = BookingExtractor.isLikelyName(nameCandidate)
      ? nameCandidate
      : null;

    const serviceMatch = cleanText.match(
      new RegExp(
        `(?:the\\s+)?(${PACKAGE_NAME_PATTERN})(?:\\s+(?:package|edition))?`,
        'i'
      )
    );

    const isoDate = text.match(ISO_DATE_PATTERN)?.[1];
    const explicitDate = isoDate ? null : findExplicitDate(text);

    // Also recognises period-separator times like "2.30" common on WhatsApp
    const timeMatch = cleanText.match(
      /(\d{1,2})([:.](\d{2}))\s*(am|pm)?|(\d{1,2})\s*(am|pm)/i
    );

    let date: string | undefined;
    let time: string | null = null;

    if (timeMatch) {
      time = timeMatch[0].toLowerCase().replace(/\s/g, '');
    }

    if (isoDate && dayjs(isoDate).isValid()) {
      date = isoDate;
    } else if (explicitDate && explicitDate.month !== null) {
      const now = nowInBusinessTimezone();

      let parsed = now
        .month(explicitDate.month)
        .date(explicitDate.day);

      if (parsed.isBefore(now, 'day')) {
        parsed = parsed.add(1, 'year');
      }

      if (
        parsed.month() === explicitDate.month
        && parsed.date() === explicitDate.day
      ) {
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
      name,
      service: serviceMatch?.[1] || null,
      date: date || null,
      time: time || null,
    };
  }

  private hasBookingSignals(message: string): boolean {
    const text = message.toLowerCase();

    return (
      /\b(\d{1,2})(st|nd|rd|th)?\b/.test(text)
      || /\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week)\b/.test(text)
      || /\b(am|pm)\b/.test(text)
      || /\bbook\b/.test(text)
      || /\bschedule\b/.test(text)
      || /\bappointment\b/.test(text)
      || /\bsession\b/.test(text)
      || /\bpackage\b/.test(text)
      || /\bbloom\b/.test(text)
      || /\bmuse\b/.test(text)
      || /\bicon\b/.test(text)
      || /\blegend\b/.test(text)
      || /\bqueen\b/.test(text)
      || /\bempress\b/.test(text)
      || /\bgoddess\b/.test(text)
      || /\bresched/.test(text)
      || /\bcancel\b/.test(text)
      || /\bdeposit\b/.test(text)
      || /\bmpesa\b/.test(text)
      || /\bpay\b/.test(text)
    );
  }

  private needsAiExtraction(message: string): boolean {
    const text = message.toLowerCase();

    const rescheduleSignal =
      /\b(reschedule|change|move|postpone)\b/.test(text);

    const hasDateSignal =
      /\b\d{1,2}(st|nd|rd|th)?\b/.test(text)
      || /\b\d{4}-\d{2}-\d{2}\b/.test(text)
      || /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+week)\b/.test(text)
      || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(text);

    const hasTimeSignal =
      /\b\d{1,2}(?:[:.\u{FF0E}]\d{2})?\s*(?:am|pm)\b/iu.test(text)
      || /\b\d{1,2}[:.\u{FF0E}]\d{2}\b/iu.test(text);

    // Preserve the existing AI extraction behaviour for rescheduling.
    if (rescheduleSignal && hasDateSignal && hasTimeSignal) {
      return true;
    }

    // Only use AI for ambiguous name introductions, not every casual message.
    const ambiguousNameIntroduction =
      /\bi am\s+[a-z]{2,}\b/i.test(text)
      || /\bi'm\s+[a-z]{2,}\b/i.test(text);

    return ambiguousNameIntroduction;
  }

  async extract(
    message: string
  ): Promise<{ details: BookingDetails; usage: TokenUsage }> {
    const regex = BookingExtractor.regexExtract(message);

    if (process.env.NODE_ENV !== 'production') {
      console.log('Regex result:', regex);
    }

    if (
      regex.name
      && regex.service
      && regex.date
      && regex.time
    ) {
      return {
        details: regex,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          completionCalls: 0,
        },
      };
    }

    if (!this.needsAiExtraction(message)) {
      console.log(
        'No name or reschedule date/time extraction needed - skipping AI extractor call.'
      );

      return {
        details: regex,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          completionCalls: 0,
        },
      };
    }

    const { details: ai, usage } = await this.aiExtract(message);

    if (process.env.NODE_ENV !== 'production') {
      console.log('AI result:', ai);
    }

    const aiName = BookingExtractor.isLikelyName(ai.name)
      ? ai.name
      : null;

    return {
      details: {
        name: regex.name || aiName,
        service: regex.service || ai.service,
        date: regex.date || ai.date,
        time: regex.time || ai.time,
      },
      usage,
    };
  }

  private async aiExtract(
    message: string
  ): Promise<{ details: BookingDetails; usage: TokenUsage }> {
    const now = nowInBusinessTimezone().format(
      'dddd, MMMM D, YYYY h:mm A'
    );

    const { response } = await createChatCompletion({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `Current Date/Time: ${now}

Extract booking details from the user message.

Return ONLY valid JSON. No text.

Format:
{
  "name": string | null,
  "service": string | null,
  "date": string | null,
  "time": string | null
}

Name extraction rules:
- Extract a name only when the customer clearly identifies the word as their personal name.
- "My name is Maryanne" means name: "Maryanne".
- "Call me Maryanne" means name: "Maryanne".
- "This is Maryanne" means name: "Maryanne".
- "I am Maryanne" or "I'm Maryanne" may be a name introduction if the context clearly indicates that Maryanne is a person's name.
- "I am alright", "I am fine", "I am still early", "I am pregnant", and "I am interested" must return name: null.
- Never assume the first word after "I am" or "I'm" is a name.
- If uncertain, return name: null.
- Name must be a person's name, not a descriptive word or sentence fragment.

Service must be one of the 2026 Editions: ${PACKAGE_NAMES_FOR_EXTRACTION.join(', ')} (or legacy: standard, economy, executive, gold, platinum, vip, vvip if the customer still uses those names).
- Prefer Edition names like "THE EMPRESS" over legacy names.
- Convert date into YYYY-MM-DD.
- Convert time into 24h format (HH:mm).
- If a field is missing, return null.
`,
        },
        {
          role: 'user',
          content: message,
        },
      ],
      temperature: 0,
      max_completion_tokens: MAX_EXTRACTOR_COMPLETION_TOKENS,
    });

    let details: BookingDetails = {};

    try {
      details = JSON.parse(
        response.choices[0].message.content || '{}'
      );
    } catch {
      details = {};
    }

    // Final defensive validation before returning the AI result.
    if (
      details.name
      && !BookingExtractor.isLikelyName(details.name)
    ) {
      details.name = null;
    }

    return {
      details,
      usage: usageFromCompletion(response),
    };
  }
}

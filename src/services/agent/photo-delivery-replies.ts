import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { inBusinessTimezone } from '../../utils/time';

export function isEarliestImageDeliveryRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(when\s+(can|will)\s+i\s+get\s+(the\s+)?(images|photos)|earliest\s+i\s+can\s+get\s+(the\s+)?(images|photos)|how\s+soon\s+can\s+i\s+get\s+(the\s+)?(images|photos)|when\s+are\s+(the\s+)?(images|photos)\s+ready|when\s+should\s+i\s+expect\s+(the\s+)?(?:edited\s+)?(?:images|photos)|delivery\s+date\s+for\s+(images|photos)|how\s+long\b.{0,70}\b(?:images|photos)\b.{0,50}\b(?:edit|edited|editing|ready|take|get|receive)|how\s+long\b.{0,70}\b(?:take\s+to\s+get|to\s+get|to\s+receive|to\s+take)\b.{0,50}\b(?:images|photos|pictures)|how\s+long\b.{0,70}\b(?:edit|edited|editing)\b.{0,50}\b(?:images|photos))/.test(text);
}

export function isExpressDeliveryFeeRequest(userMessage: string): boolean {
  return /\b(?:how much|what(?:'s| is) the|fee|cost|charge|pay)\b.{0,80}\b(?:express|deliver(?:ed|y)?|working days)\b|\b(?:express|within\s+\d+\s+working days)\b.{0,80}\b(?:fee|cost|charge|pay)\b/i.test(userMessage);
}

export function buildExpressDeliveryFeeReply(): string {
  return 'The express delivery fee is not listed in the verified rate information I have, so the team will confirm it. Standard edits are ready within 10 working days and shared by secure download link.';
}

export function explicitlySelectedDeliveryMethod(message: string, method: string): boolean {
  const channel = method === 'download_link' ? /\b(?:download\s+link|link)\b/i : new RegExp(`\\b${method}\\b`, 'i');
  const intent = /\b(?:i\s+(?:prefer|want)|i(?:'d| would)\s+(?:prefer|like)|my preference is|please\s+(?:send|deliver|share)|(?:send|deliver|share|receive)\s+(?:it|them|the\s+(?:link|photos?)))\b[\s\S]{0,60}\b(?:by|via|on|to)?\s*(?:email|whatsapp|(?:secure\s+)?download\s+link|link)\b/i;
  return channel.test(message) && intent.test(message);
}

function addWorkingDays(from: dayjs.Dayjs, days: number): dayjs.Dayjs {
  let cursor = from;
  let remaining = days;

  while (remaining > 0) {
    cursor = cursor.add(1, 'day');
    const day = cursor.day();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }

  return cursor;
}

export async function getEarliestImageDeliveryReply(customerId: string): Promise<string> {
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
      'Edited photos are ready 10 working days after your session and shared through a secure download link.',
      'If you share your booked date, I can give you the exact earliest delivery date.',
      'Express delivery is available at an extra fee if you need them sooner.'
    ].join('\n');
  }

  const shootDate = inBusinessTimezone(upcomingConfirmed.dateTime);
  const earliest = addWorkingDays(shootDate, 10);

  return [
    'Edited photos are ready 10 working days after your session and shared through a secure download link.',
    `Since your session is on ${shootDate.format('dddd, MMMM D, YYYY')}, the earliest delivery date is ${earliest.format('dddd, MMMM D, YYYY')}.`,
    'If you need them sooner, we offer express delivery at an extra fee.'
  ].join('\n');
}
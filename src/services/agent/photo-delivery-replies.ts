import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { inBusinessTimezone } from '../../utils/time';

export function isEarliestImageDeliveryRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(when\s+(can|will)\s+i\s+get\s+(the\s+)?(images|photos)|earliest\s+i\s+can\s+get\s+(the\s+)?(images|photos)|how\s+soon\s+can\s+i\s+get\s+(the\s+)?(images|photos)|when\s+are\s+(the\s+)?(images|photos)\s+ready|delivery\s+date\s+for\s+(images|photos))/.test(text);
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
      'Edited photos are ready 10 working days after the shoot.',
      'If you share your booked date, I can give you the exact earliest delivery date.',
      'Express delivery is available at an extra fee if you need them sooner.'
    ].join('\n');
  }

  const shootDate = inBusinessTimezone(upcomingConfirmed.dateTime);
  const earliest = addWorkingDays(shootDate, 10);

  return [
    'Edited photos are ready 10 working days after the shoot.',
    `Since your session is on ${shootDate.format('dddd, MMMM D, YYYY')}, the earliest delivery date is ${earliest.format('dddd, MMMM D, YYYY')}.`,
    'If you need them sooner, we offer express delivery at an extra fee.'
  ].join('\n');
}
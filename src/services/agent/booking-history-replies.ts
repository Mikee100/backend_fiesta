import prisma from '../../config/prisma';
import { inBusinessTimezone } from '../../utils/time';

export function shouldUsePastAppointmentsListReply(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /\b(previous|past|earlier|prior)\s+(appointments|bookings|sessions|shoots)\b/.test(text)
    || /\b(show|list)\b.*\b(previous|past|earlier|prior)\b.*\b(appointments|bookings|sessions|shoots)\b/.test(text)
    || /\bwhat\s+(appointments|bookings|sessions|shoots)\s+have\s+i\s+had\b/.test(text);
}

export async function getPastAppointmentsListReply(customerId: string): Promise<string> {
  const bookings = await prisma.booking.findMany({
    where: {
      customerId,
      status: { not: 'cancelled' },
      dateTime: { lt: new Date() },
    },
    orderBy: { dateTime: 'desc' },
    select: { service: true, dateTime: true, status: true },
  });

  if (bookings.length === 0) return "I don't see any past bookings on record yet.";

  const entries = bookings.map((booking) =>
    `${booking.service} - ${inBusinessTimezone(booking.dateTime).format('dddd, D MMMM YYYY')} (booking status: ${booking.status})`
  );
  return `Here are the past booking records I can see. The booking record doesn't confirm whether each session took place:\n${entries.join('\n')}`;
}
import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { DEFAULT_DURATION } from '../../config/constants';
import { bookingDateFacts, businessDay, inBusinessTimezone } from '../../utils/time';
import { customerReplyTemplates } from '../messaging/customer-reply.templates';
import { buildBookingProposalConfirmation, formatCustomerTime, isBookingProcessRequest, isPostShootProcessRequest } from './replies';
import { editionInText } from './reply-voice';
import { BOOKING_WELCOME_CLOSING } from './constants';

type ConversationMessage = { role: 'user' | 'assistant'; content: string };

export function shouldUseBookingStatusReply(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  if (/\bwhere\s+(?:are|am)\s+(?:we|i)\b|\b(?:booking|session)\s+(?:progress|status)\b/i.test(text)) return true;
  if (/\b(?:have you|did you)\s+book(?:ed)?\s+(?:it|this|that|my\s+(?:session|appointment|booking))\b/i.test(text)) return true;
  return /(have you done it|did you do it|is it done|is it confirmed|did it go through|have you confirmed|did you confirm|is my booking confirmed|is my session confirmed|have i paid|did i pay|is it paid|is my payment (received|confirmed|done|through)|has (my|the) payment been received|did (my|the) payment go through|did you receive (my|the) payment|did you get (my|the) (money|payment)|have you received (my|the) (money|payment))/i.test(text);
}

export function shouldUseUpcomingAppointmentTimeReply(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /\b(when does|what time does|when is|what time is|what time will)\b.*\b(start|begin|session|appointment|booking)\b|\b(start|begin)\b.*\b(when|what time)\b/.test(text);
}

export function shouldUseLastAppointmentDetailsReply(userMessage: string): boolean {
  return /\b(last|previous|most recent)\s+(session|shoot|appointment|booking)\b/i.test(userMessage);
}

export function shouldUseUpcomingAppointmentDetailsReply(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  if (isBookingProcessRequest(userMessage)) return false;
  if (isPostShootProcessRequest(userMessage)) return false;
  if (shouldUseUpcomingAppointmentTimeReply(userMessage)) return false;
  if (shouldUseLastAppointmentDetailsReply(userMessage)) return false;
  if (/\b(show|tell|remind|list)\b.*\b(in|on|for|about|included in|part of)?\s*(my|the|this)\s+(session|shoot|appointment|booking)\b/.test(text)) return true;
  if (/\bwhat(?:'s| is| are)?\b.*\b(included|in|on|booked for)\b.*\b(my|the|this)\s+(session|shoot|appointment|booking)\b/.test(text)) return true;
  return /\b(any|what|more|tell me about)\b.*\b(details?|information|shoot|session|appointment|booking)\b|\b(details?|information)\b.*\b(session|shoot|appointment|booking)\b/.test(text);
}

export function formatBookingDuration(durationMinutes?: number | null): string {
  const minutes = durationMinutes || DEFAULT_DURATION;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder} minutes`;
  if (remainder === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours} hour${hours === 1 ? '' : 's'} ${remainder} minutes`;
}

export function wasUpcomingAppointmentDetailsJustProvided(history: ConversationMessage[]): boolean {
  const previousUserMessage = [...history].reverse().find((message) => message.role === 'user')?.content;
  const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  return Boolean(
    previousUserMessage
    && shouldUseUpcomingAppointmentDetailsReply(previousUserMessage)
    && /\b(session|booking|appointment)\b/i.test(previousAssistantMessage)
  );
}

export async function getUpcomingAppointmentDetailsReply(
  customerId: string,
  history: ConversationMessage[] = []
): Promise<string | null> {
  const booking = await prisma.booking.findFirst({
    where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
    orderBy: { dateTime: 'asc' },
    include: {
      customer: { select: { name: true } },
      bookingAddons: {
        where: { status: { in: ['pending', 'confirmed', 'invoiced'] } },
        orderBy: { createdAt: 'asc' },
        select: { name: true, quantity: true },
      },
    },
  });

  if (!booking) return null;

  const payment = await prisma.payment.findFirst({
    where: { bookingId: booking.id, status: 'success' },
    orderBy: { updatedAt: 'desc' },
    select: { amount: true },
  });
  const localDateTime = inBusinessTimezone(booking.dateTime);
  const bookerName = booking.customer?.name?.trim() || '';
  const recipientName = booking.recipientName?.trim() || '';
  const isSelfBooking = !recipientName || recipientName.toLowerCase() === bookerName.toLowerCase();
  const date = localDateTime.format('dddd, D MMMM YYYY');
  const time = localDateTime.format('h:mm A');
  const recipient = isSelfBooking ? '' : ` for ${recipientName}`;
  const extras = booking.bookingAddons.map((addon) => `${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}`);
  const extrasText = extras.length > 0 ? ` Your saved extras are ${extras.join(' and ')}.` : '';
  const confirmation = payment ? ' It is confirmed, and your deposit has been paid.' : ' Your booking is confirmed.';
  const duration = formatBookingDuration(booking.durationMinutes);

  if (wasUpcomingAppointmentDetailsJustProvided(history)) {
    return `It’s the same session we just discussed: ${booking.service} on ${date} at ${time}${recipient}. It runs for ${duration} at our Parklands studio.${extrasText}${confirmation}`;
  }

  return `Your ${booking.service} session is on ${date} at ${time}${recipient}. It runs for ${duration} at our Parklands studio.${extrasText}${confirmation}`;
}

export async function getLastAppointmentDetailsReply(customerId: string): Promise<string> {
  const booking = await prisma.booking.findFirst({
    where: {
      customerId,
      status: { not: 'cancelled' },
      dateTime: { lt: new Date() },
    },
    orderBy: { dateTime: 'desc' },
    select: {
      service: true,
      dateTime: true,
      durationMinutes: true,
      recipientName: true,
      bookingAddons: {
        where: { status: { in: ['pending', 'confirmed', 'invoiced'] } },
        orderBy: { createdAt: 'asc' },
        select: { name: true, quantity: true },
      },
    },
  });

  if (!booking) return "I don't see a past booking on record yet. Are you asking about your upcoming session?";

  const localDateTime = inBusinessTimezone(booking.dateTime);
  const details = [
    `Date: ${localDateTime.format('dddd, D MMMM YYYY')} at ${localDateTime.format('h:mm A')}`,
    ...(booking.durationMinutes ? [`Duration: ${formatBookingDuration(booking.durationMinutes)}`] : []),
    ...(booking.recipientName ? [`Booked for: ${booking.recipientName}`] : []),
  ];

  if (booking.bookingAddons.length > 0) {
    details.push('Add-ons recorded:');
    details.push(...booking.bookingAddons.map((addon) => `- ${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}`));
  }

  return `The most recent past booking I have on record is ${booking.service}.\n${details.join('\n')}\n\nDoes that sound like the session you mean?`;
}

export async function getUpcomingAppointmentTimeReply(customerId: string): Promise<string | null> {
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

export async function getBookingStatusReply(this: any, customerId: string): Promise<string | null> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  const usableDate = draft?.date && !bookingDateFacts(draft.date).isMonday && !bookingDateFacts(draft.date).isPast;
  const details = draft?.service && usableDate && draft.time
    ? `You chose ${editionInText(draft.service)} for ${businessDay(draft.date!).format('dddd, D MMMM YYYY')} at ${formatCustomerTime(draft.time)}. ` : '';
  if (draft?.step === 'collecting_slots') {
    const missing = [!draft.name && 'your name', !draft.service && 'your edition', !draft.date && 'a date', !draft.time && 'a time'].filter(Boolean);
    return `${details}Your current request is not booked or confirmed yet. ${missing.length ? `I still need ${missing.join(', ')}.` : 'The details still need a deposit proposal and payment.'}`;
  }
  if (draft?.step === 'reschedule_confirm') return customerReplyTemplates.rescheduleAwaitingConfirmation();
  if (draft?.step === 'awaiting_confirmation') {
    if (draft.service && draft.date && draft.time && this?.getPackageForDeposit) {
      try {
        const deposit = this.getDepositForPackage(await this.getPackageForDeposit(draft.service));
        return buildBookingProposalConfirmation(draft.service, draft.date, draft.time, deposit).replace('are ready for', 'are still ready for');
      } catch {
        return `${details}Your booking is not confirmed. The team will verify the deposit before we continue.`;
      }
    }
    return `${details}${customerReplyTemplates.bookingAwaitingConfirmation()}`;
  }
  if (draft?.step === 'payment_pending') return `${details}Your current request is awaiting payment verification. The studio team can confirm its status.`;
  const upcomingConfirmed = await prisma.booking.findFirst({
    where: {
      customerId,
      status: 'confirmed',
      dateTime: { gte: new Date() },
    },
    orderBy: { dateTime: 'asc' },
    select: { id: true, service: true, dateTime: true },
  });

  if (upcomingConfirmed) {
    const successfulPayment = await prisma.payment.findFirst({
      where: { bookingId: upcomingConfirmed.id, status: 'success' },
      orderBy: { updatedAt: 'desc' },
    });
    const receiptNote = successfulPayment?.mpesaReceipt ? ` (M-Pesa receipt: ${successfulPayment.mpesaReceipt})` : '';
    const sessionDetails = `Your session for ${editionInText(upcomingConfirmed.service)} is confirmed for ${inBusinessTimezone(upcomingConfirmed.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')}.`;
    return successfulPayment
      ? `Your payment is received and confirmed${receiptNote}. ${sessionDetails} ${BOOKING_WELCOME_CLOSING}`
      : `${sessionDetails} I can't verify a successful payment from the records I can see; the studio team can confirm the payment status.`;
  }

  return null;
}

export async function getPastAppointmentReply(customerId: string): Promise<string | null> {
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

export function shouldUsePastAppointmentReply(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(that|the|my)\s+(date|day|appointment|booking|session).*(already\s+)?(passed|past)|already\s+passed|that\s+was\s+in\s+the\s+past/.test(text);
}

export function isPastAppointmentFollowUp(userMessage: string, history: ConversationMessage[]): boolean {
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

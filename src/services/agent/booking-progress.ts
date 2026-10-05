import prisma from '../../config/prisma';
import { SERVICE_DURATIONS } from '../../config/constants';
import { bookingService } from '../booking/booking.service';
import { bookingDateFacts } from '../../utils/time';
import { EARLY_SLOT_STEP, earlySlotsExpired } from './slot-memory';
import { buildBookingProposalConfirmation, formatCustomerTime } from './replies';
import { editionInText } from './reply-voice';

export async function bookingProgressReply(this: any, customerId: string, message: string, history: { role: 'user' | 'assistant'; content: string }[], decisionJustSaved = false): Promise<string | null> {
  const declined = this.isDecliningOptionalAddons(message, history)
    || history.some((entry, index) => entry.role === 'user' && this.isDecliningOptionalAddons(entry.content, history.slice(0, index)));
  const relevant = decisionJustSaved || declined || /\b(?:okay|ok|yes+|so|ready|go ahead|that it|full name)\b/i.test(message)
    || this.messageContainsExplicitDateTimeSignal(message)
    || /\bfull name\b/i.test(history.filter((entry) => entry.role === 'assistant').at(-1)?.content || '');
  if (!relevant) return null;
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.step !== EARLY_SLOT_STEP || earlySlotsExpired(draft) || draft.isForSomeoneElse) return null;
  if (!draft.name || !draft.service || !draft.date || !draft.time) return null;
  const facts = bookingDateFacts(draft.date);
  if (facts.isMonday || facts.isPast) return `${facts.date} is ${facts.weekday}. ${facts.isPast ? 'That date is in the past' : 'Closed on Mondays'}. Which other date would work for you?`;
  const key = Object.keys(SERVICE_DURATIONS).find((value) => draft.service!.toLowerCase().includes(value));
  if (!key) return 'The team will confirm that edition before we continue.';
  const slots = await bookingService.getAvailableSlots(draft.date, SERVICE_DURATIONS[key], undefined, draft.id);
  if (!Array.isArray(slots) || !slots.includes(draft.time)) return 'That time is not available for your current request. What other time would suit you?';
  const note = decisionJustSaved || declined ? true : await prisma.customerSessionNote.findFirst({
    where: { customerId, bookingId: null, category: 'addon', status: 'pending', createdAt: { gte: draft.createdAt } }, select: { id: true },
  });
  if (!note) return `For ${editionInText(draft.service)}, ${draft.date} is ${facts.weekday} and ${formatCustomerTime(draft.time)} is available. Would you like any optional add-ons, such as an extra outfit or styled wig hire?`;
  const nameWasRequested = history.some((entry) => entry.role === 'assistant' && /\bfull name\b/i.test(entry.content));
  const repeatedUsableName = nameWasRequested && message.trim().toLowerCase() === draft.name.trim().toLowerCase();
  if (draft.name.trim().split(/\s+/).length < 2 && !repeatedUsableName) return 'May I have your full name to prepare the booking details?';
  try {
    const result = await this.executeProposeBookingTool(customerId, draft.name, draft.service, `${draft.date}T${draft.time}`);
    return buildBookingProposalConfirmation(draft.service, draft.date, draft.time, result.depositAmount);
  } catch {
    return 'The team will help verify these booking details before any payment prompt is sent.';
  }
}
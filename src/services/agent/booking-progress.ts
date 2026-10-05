import prisma from '../../config/prisma';
import { ADDON_CATALOG, PACKAGE_NAMES_FOR_EXTRACTION, SERVICE_DURATIONS } from '../../config/constants';
import { bookingService } from '../booking/booking.service';
import { bookingDateFacts, formatCustomerDate } from '../../utils/time';
import { EARLY_SLOT_STEP, closedDateReply, earlySlotsExpired, extractStatedSlots, isUsableName } from './slot-memory';
import { buildBookingProposalConfirmation, formatCustomerTime } from './replies';
import { editionInText } from './reply-voice';

type Message = { role: 'user' | 'assistant'; content: string };
export type BookingStep = 'need_package' | 'need_date' | 'need_time' | 'need_name' | 'need_addon_decision' | 'ready_to_propose';
export type BookingSlots = { service?: string | null; date?: string | null; time?: string | null; name?: string | null; addonsDecided?: boolean };

/** What a collecting draft still needs, in the order it is asked. A first name satisfies the name step. */
export function nextStep(slots: BookingSlots): BookingStep {
  if (!slots.service) return 'need_package';
  if (!slots.date) return 'need_date';
  if (!slots.time) return 'need_time';
  if (!isUsableName(slots.name)) return 'need_name';
  if (!slots.addonsDecided) return 'need_addon_decision';
  return 'ready_to_propose';
}

export const ADDON_DECISION_QUESTION = 'Would you like any optional add-ons, such as an extra outfit or styled wig hire?';
export const ADDON_OTHER_DECISION_QUESTION = 'Would you like any other optional add-ons, such as an extra outfit or styled wig hire?';
export const STEP_QUESTIONS: Record<Exclude<BookingStep, 'ready_to_propose'>, string> = {
  need_package: 'Which edition would you like?',
  need_date: 'What date would suit you?',
  need_time: 'What time would suit you?',
  need_name: 'May I have your name for the booking details?',
  need_addon_decision: ADDON_DECISION_QUESTION,
};

export function editionShortName(service: string): string {
  const canonical = PACKAGE_NAMES_FOR_EXTRACTION.find((name) => name.toLowerCase() === service.trim().toLowerCase()) || service;
  const word = canonical.replace(/^THE\s+/i, '').toLowerCase();
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

export function addonPickQuestion(service?: string | null): string {
  return `Tell me which you would like${service ? ` for your ${editionShortName(service)} session` : ''}, or say no to skip them.`;
}

function joinTimes(times: string[]): string {
  const labels = times.map(formatCustomerTime);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
}

/** At most four evenly spread times, so a full day is never one long list. */
export function sampleSlots(slots: string[], count = 4): string[] {
  if (slots.length <= count) return slots;
  return Array.from({ length: count }, (_, index) => slots[Math.round(index * (slots.length - 1) / (count - 1))]);
}

function nearestSlots(slots: string[], time: string, count = 3): string[] {
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return [...slots].sort((a, b) => Math.abs(minutes(a) - minutes(time)) - Math.abs(minutes(b) - minutes(time)))
    .slice(0, count).sort((a, b) => minutes(a) - minutes(b));
}

export function openTimesReply(date: string, service: string, slots: string[]): string {
  const shown = sampleSlots(slots);
  const times = shown.length < slots.length ? `Available times include ${joinTimes(shown)}, with others in between.` : `Available times: ${joinTimes(shown)}.`;
  return `${formatCustomerDate(date)} is open for ${editionInText(service)}. ${times} Which time would suit you?`;
}

export function unavailableTimeReply(date: string, time: string, slots: string[]): string {
  const nearest = nearestSlots(slots, time);
  return `${formatCustomerTime(time)} is not available on ${formatCustomerDate(date)}. The nearest open ${nearest.length > 1 ? 'times are' : 'time is'} ${joinTimes(nearest)}. Which would suit you?`;
}

const decisionMarker = (draftId: string) => `system:addons-decided:v1:${draftId}`;

/** Bound to the draft id, so the decision survives the six-message history window but not a new draft. */
export async function recordAddonDecision(customerId: string, draftId: string): Promise<void> {
  try {
    const marker = decisionMarker(draftId);
    await prisma.customerMemory.upsert({ where: { customerId }, update: {}, create: { customerId } });
    await prisma.customerMemory.updateMany({ where: { customerId, NOT: { keyInsights: { has: marker } } }, data: { keyInsights: { push: marker } } });
  } catch {
    console.warn('[AGENT_FLOW] addon_decision_state=unsaved');
  }
}

async function addonsDecided(this: any, customerId: string, draft: { id: string; createdAt: Date }, history: Message[]): Promise<boolean> {
  if (history.some((entry, index) => entry.role === 'user' && this.isDecliningOptionalAddons(entry.content, history.slice(0, index)))) return true;
  try {
    const memory = await prisma.customerMemory.findUnique({ where: { customerId }, select: { keyInsights: true } });
    if (memory?.keyInsights?.includes(decisionMarker(draft.id))) return true;
  } catch {
    console.warn('[AGENT_FLOW] addon_decision_state=unavailable');
  }
  const note = await prisma.customerSessionNote.findFirst({
    where: { customerId, bookingId: null, category: 'addon', status: 'pending', createdAt: { gte: draft.createdAt } }, select: { id: true },
  });
  return Boolean(note);
}

export async function bookingProgressReply(this: any, customerId: string, message: string, history: Message[], decisionJustSaved = false, force = false): Promise<string | null> {
  const stated = extractStatedSlots(message, history);
  const dateTimeTurn = Boolean(stated.date || stated.time);
  const declinedNow = this.isDecliningOptionalAddons(message, history);
  const relevant = force || decisionJustSaved || declinedNow || dateTimeTurn || Boolean(stated.name)
    || /\b(?:okay|ok|yes+|so|ready|go ahead|that it|skip)\b/i.test(message);
  if (!relevant) return null;
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.step !== EARLY_SLOT_STEP || earlySlotsExpired(draft) || draft.isForSomeoneElse || !draft.service) return null;
  if ((!draft.date || !draft.time) && !dateTimeTurn && !force) return null;
  if (draft.date) {
    const facts = bookingDateFacts(draft.date);
    if (facts.isMonday || facts.isPast) return closedDateReply(facts);
  }
  const key = Object.keys(SERVICE_DURATIONS).find((value) => draft.service!.toLowerCase().includes(value));
  if (!key) return 'The team will confirm that edition before we continue.';
  if (!draft.date) return STEP_QUESTIONS.need_date;
  const slots = await bookingService.getAvailableSlots(draft.date, SERVICE_DURATIONS[key], undefined, draft.id);
  const open: string[] = Array.isArray(slots) ? slots : [];
  if (!open.length) return `${formatCustomerDate(draft.date)} is fully booked for ${editionInText(draft.service)}. Which other date would work for you?`;
  if (!draft.time) return openTimesReply(draft.date, draft.service, open);
  if (!open.includes(draft.time)) return unavailableTimeReply(draft.date, draft.time, open);
  const lead = dateTimeTurn ? `${formatCustomerTime(draft.time)} on ${formatCustomerDate(draft.date)} is available for ${editionInText(draft.service)}. ` : '';
  if (!isUsableName(draft.name)) return `${lead}${STEP_QUESTIONS.need_name}`;
  if (declinedNow) await recordAddonDecision(customerId, draft.id);
  if (!decisionJustSaved && !declinedNow && !await addonsDecided.call(this, customerId, draft, history)) {
    const discussed = history.some((entry) => entry.role === 'user' && ADDON_CATALOG.some((item) => item.match.test(entry.content)));
    return `${lead}${discussed ? ADDON_OTHER_DECISION_QUESTION : ADDON_DECISION_QUESTION}`;
  }
  try {
    const result = await this.executeProposeBookingTool(customerId, draft.name, draft.service, `${draft.date}T${draft.time}`);
    return buildBookingProposalConfirmation(draft.service, draft.date, draft.time, result.depositAmount);
  } catch {
    return 'The team will help verify these booking details before any payment prompt is sent.';
  }
}
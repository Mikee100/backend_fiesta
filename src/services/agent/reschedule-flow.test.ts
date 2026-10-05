// Rescheduling mutates the existing confirmed booking; it never restarts the new-booking flow.
import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { inBusinessTimezone, nowInBusinessTimezone } from '../../utils/time';
import { AgentService } from './agent.service';
import { extractStatedSlots, isUsableName } from './slot-memory';

const CUSTOMER = 'synthetic-joan';
type Msg = { role: 'user' | 'assistant'; content: string };

function harness(context: any, daysAhead: number) {
  const restores: (() => void)[] = [];
  const stub = (target: any, method: string, implementation: (...args: any[]) => any) => {
    const original = target[method]; target[method] = implementation; restores.push(() => { target[method] = original; });
  };
  context.after(() => restores.reverse().forEach((restore) => restore()));

  const start = nowInBusinessTimezone().add(daysAhead, 'day').hour(15).minute(0).second(0).millisecond(0);
  const state = {
    booking: { id: 'booking-icon', customerId: CUSTOMER, service: 'THE ICON', dateTime: start.toDate(), status: 'confirmed', googleEventId: 'event-icon', customer: { id: CUSTOMER, name: 'No its Joan' } },
    draft: null as any,
    createdSteps: [] as string[],
    bookingsCreated: 0,
    bookingUpdates: [] as any[],
    calendarUpdates: 0,
    invoiceRefreshes: [] as string[],
    slots: ['10:00', '15:00', '17:00'] as string[] | { status: string; reason: string },
    slotQueries: [] as { date: string; excludeBookingId?: string }[],
    deleted: [] as any[],
  };
  const bookingDay = start.format('YYYY-MM-DD');

  stub(prisma.booking, 'findFirst', async () => ({ ...state.booking }));
  stub(prisma.booking, 'findUnique', async () => ({ ...state.booking }));
  stub(prisma.booking, 'update', async ({ data }: any) => { state.bookingUpdates.push(data); Object.assign(state.booking, data); return { ...state.booking }; });
  stub(prisma.booking, 'create', async () => { state.bookingsCreated++; return {}; });
  stub(prisma.customer, 'findUnique', async () => ({ id: CUSTOMER, name: 'No its Joan' }));
  stub(prisma.bookingDraft, 'findUnique', async () => (state.draft ? { ...state.draft } : null));
  stub(prisma.bookingDraft, 'create', async ({ data }: any) => { state.createdSteps.push(data.step); state.draft = { id: `draft-${state.createdSteps.length}`, ...data }; return state.draft; });
  stub(prisma.bookingDraft, 'updateMany', async ({ where, data }: any) => {
    if (!state.draft || where.id !== state.draft.id || (where.step && where.step !== state.draft.step)) return { count: 0 };
    Object.assign(state.draft, data);
    return { count: 1 };
  });
  stub(prisma.bookingDraft, 'upsert', async ({ update, create }: any) => { state.draft = state.draft ? { ...state.draft, ...update } : { id: 'reschedule-draft', ...create }; return state.draft; });
  stub(prisma.bookingDraft, 'deleteMany', async ({ where }: any) => {
    state.deleted.push(where);
    if (state.draft && where.id === state.draft.id && where.step === state.draft.step) { state.draft = null; return { count: 1 }; }
    return { count: 0 };
  });
  stub(bookingService, 'getAvailableSlots', async (date: string, _duration: number, excludeBookingId?: string) => {
    state.slotQueries.push({ date, excludeBookingId });
    return state.slots;
  });
  stub(googleCalendarService, 'updateEvent', async () => { state.calendarUpdates++; return true; });
  stub(invoiceService, 'createOrRefreshForBooking', async (bookingId: string) => { state.invoiceRefreshes.push(bookingId); return null; });

  const agent = new AgentService() as any;
  Object.assign(agent, {
    getBookingProgressReply: async () => assert.fail('a reschedule reply must not continue the new-booking flow'),
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    escalate: async () => {},
    notifyRescheduleAdmin: async () => {},
    runAgent: async () => assert.fail('the reschedule flow must not reach the model'),
  });
  const history: Msg[] = [];
  const say = async (message: string) => {
    const reply: string = await agent.handleMessage(CUSTOMER, message, history.slice(-6), 'whatsapp');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return reply;
  };
  say.withHistory = async (extra: Msg[], message: string) => {
    history.push(...extra);
    return say(message);
  };
  return { state, say, bookingDay };
}

test('Joan run: same day but from 5pm moves the existing Icon booking without asking name or package', async (context) => {
  const { state, say, bookingDay } = harness(context, 1);

  const ask = await say('Okay can we push it to some other time kindly?');
  assert.match(ask, /within 72 hours.*forfeit your deposit.*share your preferred date and time/s);

  const proposal = await say('same day but from 5pm');
  assert.doesNotMatch(proposal, /your name|which package|No its Joan/i);
  assert.match(proposal, /5:00 PM is available/);
  assert.match(proposal, /Icon edition from 3:00 PM to 5:00 PM/);
  assert.match(proposal, /forfeit your deposit/);
  assert.match(proposal, /confirm the change\?$/);
  assert.deepEqual(state.createdSteps, ['reschedule_collecting'], 'only the reschedule context is stored, never a new-booking draft');
  assert.deepEqual(state.slotQueries.at(-1), { date: bookingDay, excludeBookingId: 'booking-icon' });
  assert.equal(state.draft.step, 'reschedule_confirm');
  assert.equal(state.draft.bookingId, 'booking-icon');
  assert.equal(state.draft.date, bookingDay);
  assert.equal(state.draft.time, '17:00');
  assert.equal(state.draft.service, 'THE ICON');

  const done = await say('yes');
  assert.match(done, /has been moved to/);
  assert.equal(state.bookingsCreated, 0, 'a reschedule never creates a new booking');
  assert.equal(state.bookingUpdates.length, 1);
  assert.equal(inBusinessTimezone(state.bookingUpdates[0].dateTime).format('YYYY-MM-DD HH:mm'), `${bookingDay} 17:00`);
  assert.equal(state.calendarUpdates, 1);
  assert.deepEqual(state.invoiceRefreshes, ['booking-icon'], 'the existing invoice is refreshed, not replaced');
  assert.equal(state.draft, null);
});

test('a booking outside 72 hours proposes the move without a forfeiture warning', async (context) => {
  const { say } = harness(context, 10);
  assert.match(await say('Can I reschedule?'), /What time would work better for you that day\?/);
  const proposal = await say('same day but from 5pm');
  assert.match(proposal, /from 3:00 PM to 5:00 PM/);
  assert.doesNotMatch(proposal, /forfeit/);
  assert.match(proposal, /edition and extras stay the same/);
});

test('an unavailable reschedule time offers alternatives on the existing date and keeps the booking', async (context) => {
  const { state, say } = harness(context, 10);
  state.slots = ['10:00', '11:30'];
  await say('Can I reschedule?');
  const reply = await say('5pm please');
  assert.match(reply, /5:00 PM is not available.*closest available times are 10:00 AM, 11:30 AM/s);
  assert.equal(state.draft.step, 'reschedule_collecting', 'the reschedule context survives an unavailable time');
  assert.equal(state.bookingUpdates.length, 0);
});

test('live run: Icon at 5pm explains the latest start, and a later pick survives a reminder in between', async (context) => {
  const { state, say } = harness(context, 1);
  state.slots = ['09:00', '09:30', '10:00', '15:00', '15:30', '16:00', '16:30'];
  await say('can we push it to some other time?');
  const unavailable = await say('yes proceed...i want it on the same day but at 5pm');
  assert.match(unavailable, /5:00 PM is not available.*runs 2 hours 30 minutes.*latest start that day is 4:30 PM/s);
  assert.match(unavailable, /3:30 PM, 4:00 PM, 4:30 PM/);
  const reminder: Msg = { role: 'assistant', content: 'Hi Joan, your THE ICON session is tomorrow at 3:00 PM. Please arrive about 30 minutes early.' };
  const proposal = await say.withHistory([reminder], "Let's go with 10am");
  assert.doesNotMatch(proposal, /which package|your name/i);
  assert.match(proposal, /from 3:00 PM to 10:00 AM.*confirm the change\?$/s);
  assert.equal(state.draft.step, 'reschedule_confirm');
  assert.equal(state.draft.time, '10:00');
  assert.ok(!state.createdSteps.includes('collecting_slots'));
});

test('an empty draft left by the old slot capture does not block the reschedule', async (context) => {
  const { state, say } = harness(context, 10);
  await say('Can I reschedule?');
  state.draft = { id: 'stale', step: 'collecting_slots', name: 'No its Joan', service: null, date: null, time: '17:00' };
  const proposal = await say('same day but from 5pm');
  assert.match(proposal, /confirm the change\?$/);
  assert.equal(state.deleted[0].id, 'stale');
  assert.equal(state.draft.step, 'reschedule_confirm');
});

test('a corrected name answer stores the name, never the correction phrase', () => {
  const asked: Msg[] = [{ role: 'assistant', content: 'May I have your full name to prepare the booking details?' }];
  assert.equal(extractStatedSlots('No its Joan', asked).name, 'Joan');
  assert.equal(extractStatedSlots("It's Joan Wanjiku", asked).name, 'Joan Wanjiku');
  assert.equal(isUsableName('No its Joan'), false);
  assert.equal(isUsableName('WhatsApp User'), false);
  assert.equal(isUsableName('Yesenia Otieno'), true);
});

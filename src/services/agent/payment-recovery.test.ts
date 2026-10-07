// Payment recovery: replies come from the draft step and latest payment row, never from the model.
import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { bookingAddonService } from '../booking/booking-addon.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { whatsappService } from '../messaging/whatsapp.service';
import { mpesaService } from '../payment/mpesa.service';
import { paymentController } from '../../controllers/payment.controller';
import { AgentService } from './agent.service';
import {
  classifyPaymentMessage,
  describeDarajaResult,
  getPaymentSituation,
  MAX_PAYMENT_ATTEMPTS,
  paymentFailureMessage,
} from './payment-recovery';

const CUSTOMER = '254712345678';
const MINUTE = 60_000;

type State = {
  draft: any;
  payment: any;
  slots: string[] | { status: string };
  stkPushes: number;
  escalations: string[];
  sent: string[];
  bookingsCreated: number;
  calendarEvents: number;
};

function harness(context: any, overrides: { draft?: Record<string, unknown>; payment?: Record<string, unknown> | null } = {}) {
  const restores: (() => void)[] = [];
  const stub = (target: any, method: string, implementation: (...args: any[]) => any) => {
    const original = target[method]; target[method] = implementation; restores.push(() => { target[method] = original; });
  };
  context.after(() => restores.reverse().forEach((restore) => restore()));

  const state: State = {
    draft: {
      id: 'draft-joan', customerId: CUSTOMER, step: 'payment_pending', service: 'THE ICON',
      date: '2026-10-08', time: '15:00', dateTimeIso: '2026-10-08T12:00:00.000Z', name: 'Joan',
      version: 2, createdAt: new Date(Date.now() - 30 * MINUTE), updatedAt: new Date(Date.now() - MINUTE),
      ...overrides.draft,
    },
    payment: overrides.payment === null ? null : {
      id: 'payment-joan', bookingDraftId: 'draft-joan', bookingId: null, amount: 2000, phone: CUSTOMER,
      status: 'pending', mpesaReceipt: null, checkoutRequestId: 'ws_CO_1', createdAt: new Date(Date.now() - MINUTE),
      updatedAt: new Date(Date.now() - MINUTE), ...overrides.payment,
    },
    slots: ['15:00'],
    stkPushes: 0,
    escalations: [],
    sent: [],
    bookingsCreated: 0,
    calendarEvents: 0,
  };

  const matches = (row: any, where: any) => Boolean(row) && Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (value && typeof value === 'object' && 'not' in (value as any)) return row[key] !== (value as any).not;
    return row[key] === value;
  });
  const apply = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in (value as any)) row[key] = (row[key] ?? 1) + (value as any).increment;
      else if (value && typeof value === 'object' && 'decrement' in (value as any)) row[key] = (row[key] ?? 1) - (value as any).decrement;
      else row[key] = value;
    }
    return { ...row };
  };
  const notFound = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

  stub(prisma.bookingDraft, 'findUnique', async () => (state.draft ? { ...state.draft } : null));
  stub(prisma.bookingDraft, 'update', async ({ where, data }: any) => {
    if (!matches(state.draft, where)) throw notFound();
    return apply(state.draft, { ...data, updatedAt: new Date() });
  });
  stub(prisma.bookingDraft, 'delete', async () => { const removed = state.draft; state.draft = null; if (state.payment) state.payment.bookingDraftId = null; return removed; });
  stub(prisma.payment, 'findFirst', async ({ where }: any) => {
    if (!state.payment) return null;
    if (where?.checkoutRequestId && where.checkoutRequestId !== state.payment.checkoutRequestId) return null;
    if (where?.bookingDraftId && where.bookingDraftId !== state.payment.bookingDraftId) return null;
    if (where?.booking) return state.payment.status === 'success' && state.payment.booking ? { ...state.payment } : null;
    const draft = state.payment.bookingDraftId && state.draft ? { ...state.draft, customer: { id: CUSTOMER, name: 'Joan' } } : null;
    return { ...state.payment, bookingDraft: draft, booking: state.payment.booking ?? null };
  });
  stub(prisma.payment, 'update', async ({ data }: any) => apply(state.payment, { ...data, updatedAt: new Date() }));
  stub(prisma.payment, 'updateMany', async ({ where, data }: any) => {
    if (!matches(state.payment, where)) return { count: 0 };
    apply(state.payment, { ...data, updatedAt: new Date() });
    return { count: 1 };
  });
  stub(prisma.package, 'findUnique', async () => ({ name: 'THE ICON', deposit: 2000 }));
  stub(bookingService, 'getAvailableSlots', async () => state.slots);
  stub(mpesaService, 'initiateStkPush', async () => {
    state.stkPushes++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { CheckoutRequestID: `ws_CO_${state.stkPushes + 1}` };
  });
  stub(whatsappService, 'sendMessage', async (_to: string, message: string) => { state.sent.push(message); return {}; });
  stub(whatsappService, 'sendDocument', async (_to: string, _pdf: unknown, _name: string, message: string) => { state.sent.push(message); return {}; });
  stub(require('../notifications/notification.service'), 'notifyAdmin', async () => {});
  stub(prisma.booking, 'create', async ({ data }: any) => {
    state.bookingsCreated++;
    const booking = { id: `booking-${state.bookingsCreated}`, ...data, customer: { id: CUSTOMER, name: 'Joan' } };
    state.payment.booking = booking;
    return booking;
  });
  stub(prisma.booking, 'update', async ({ data }: any) => ({ ...state.payment.booking, ...data }));
  stub(bookingAddonService, 'attachPendingToBooking', async () => {});
  stub(prisma.customerSessionNote, 'updateMany', async () => ({ count: 0 }));
  stub(googleCalendarService, 'createEvent', async () => { state.calendarEvents++; return `event-${state.calendarEvents}`; });
  stub(invoiceService, 'createOrRefreshForBooking', async () => ({ invoiceNumber: 'INV-TEST-1', pdfData: null, balanceDue: 33000 }));
  stub(prisma.customerMemory, 'findUnique', async () => null);
  stub(prisma.customerMemory, 'upsert', async () => ({}));

  const agent = new AgentService() as any;
  Object.assign(agent, {
    rememberBookingSlots: async () => null,
    getBookingProgressReply: async () => null,
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    escalate: async (_customer: string, _type: string, description: string) => { state.escalations.push(description); },
    runAgent: async () => assert.fail('payment recovery messages must never reach the model'),
  });
  const say = (message: string) => agent.handleMessage(CUSTOMER, message, [], 'whatsapp') as Promise<string>;
  return { state, agent, say };
}

const attemptsOf = (draft: any) => draft.version - 1;

test('classifies the payment phrases from the Joan run', () => {
  for (const [message, kind] of [
    ['can we retry this', 'resend'],
    ['Kindly do it the last time', 'resend'],
    ['resend', 'resend'],
    ['It has not arrived', 'not_arrived'],
    ["I haven't received anything", 'not_arrived'],
    ['did it go through?', 'status_check'],
    ['I paid', 'paid_claim'],
    ["I've already paid", 'paid_claim'],
    ['i want to finish the payment', 'consent'],
    ['yes', 'consent'],
    ['start again', 'restart'],
    ['SFK7ABC123', 'receipt'],
  ] as const) {
    assert.equal(classifyPaymentMessage(message), kind, message);
  }
  for (const message of ['cancel my booking', "no don't send it", 'what is your location?', 'thanks', 'ok']) {
    assert.equal(classifyPaymentMessage(message), null, message);
  }
});

test('Daraja result codes map to customer sentences without raw Daraja text', () => {
  assert.equal(describeDarajaResult(1032).status, 'cancelled');
  for (const code of [1, 2001, 1037, 1001, 9999]) assert.equal(describeDarajaResult(code).status, 'failed');
  assert.match(describeDarajaResult('1').reason, /insufficient funds/);
  assert.match(describeDarajaResult(2001).reason, /PIN/);
  assert.match(describeDarajaResult(1037).reason, /timed out/);
  assert.match(describeDarajaResult(1001).reason, /already in progress/);
  const draft = { id: 'd', step: 'payment_pending', version: 2, updatedAt: new Date('2026-10-05T12:00:00Z') };
  const message = paymentFailureMessage(1032, draft);
  assert.match(message, /cancelled/);
  assert.match(message, /held until 3:15 PM/);
  assert.match(message, /Reply yes/);
  assert.doesNotMatch(message, /\.\.|Request Cancelled by user/);
  assert.match(paymentFailureMessage(1, { ...draft, version: MAX_PAYMENT_ATTEMPTS + 1 }), /0720 111928/);
  assert.doesNotMatch(paymentFailureMessage(1, { ...draft, version: MAX_PAYMENT_ATTEMPTS + 1 }), /Reply yes/);
});

test('getPaymentSituation reads the draft step and latest payment row', async (context) => {
  const { state } = harness(context);
  const now = Date.now();
  const kind = async () => (await getPaymentSituation(CUSTOMER, now)).kind;
  state.payment.updatedAt = new Date(now - 30_000);
  assert.equal(await kind(), 'prompt_sent');
  state.payment.updatedAt = new Date(now - 3 * MINUTE);
  assert.equal(await kind(), 'prompt_stale');
  state.payment.status = 'cancelled';
  assert.equal(await kind(), 'cancelled');
  state.payment.status = 'failed';
  assert.equal(await kind(), 'failed');
  state.draft.updatedAt = new Date(now - 16 * MINUTE);
  assert.equal(await kind(), 'hold_expired');
  state.payment.status = 'success';
  assert.equal(await kind(), 'paid');
  state.draft.step = 'awaiting_confirmation';
  state.payment = null;
  assert.equal(await kind(), 'none');
});

test('pending, then cancelled callback, then retry sends a new prompt as attempt 2', async (context) => {
  const { state, say } = harness(context, { draft: { version: 2 } });
  await paymentController.processMpesaCallback({ CheckoutRequestID: 'ws_CO_1', ResultCode: 1032, ResultDesc: 'Request Cancelled by user.' });
  assert.equal(state.payment.status, 'cancelled');
  assert.match(state.sent.at(-1) || '', /cancelled.*held until.*Reply yes/s);
  assert.doesNotMatch(state.sent.at(-1) || '', /\.\./);

  const reply = await say('can we retry this');
  assert.match(reply, /accepted a new deposit request for Ksh 2,000 for the number ending 678/);
  assert.equal(state.stkPushes, 1);
  assert.equal(attemptsOf(state.draft), 2);
  assert.equal(state.payment.status, 'pending');
  assert.equal(state.payment.checkoutRequestId, 'ws_CO_2');
});

test('cancelled twice, then yes resends and never claims the prompt is already sent', async (context) => {
  const { state, say } = harness(context, { draft: { version: 3 }, payment: { status: 'cancelled' } });
  const reply = await say('yes');
  assert.doesNotMatch(reply, /already sent/i);
  assert.match(reply, /accepted a new deposit request/);
  assert.equal(state.stkPushes, 1);
  assert.equal(attemptsOf(state.draft), 3);
  state.payment.status = 'cancelled';
  const lastTime = await say('Kindly do it the last time');
  assert.match(lastTime, /won't send another.*0720 111928/s);
  assert.equal(state.stkPushes, 1);
});

test('a young pending request reports accepted without claiming phone delivery or sending again', async (context) => {
  const { state, say } = harness(context, { payment: { updatedAt: new Date(Date.now() - 20_000) } });
  const reply = await say('yes');
  assert.match(reply, /already accepted the deposit request.*ending 678/);
  assert.match(reply, /If a prompt appears on your phone/);
  assert.doesNotMatch(reply, /sent.*to your phone|booking is confirmed|session.*is booked/i);
  assert.equal(state.stkPushes, 0);
});

test('three failed prompts stop with a team message and one escalation', async (context) => {
  const { state, say } = harness(context, { draft: { version: MAX_PAYMENT_ATTEMPTS + 1 }, payment: { status: 'failed' } });
  const reply = await say('yes');
  assert.match(reply, /sent the M-Pesa prompt a few times.*check your M-Pesa line.*0720 111928/s);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.escalations.length, 1);
  assert.match(state.escalations[0], /3 M-Pesa prompts/);
});

test('it has not arrived after 30 seconds answers from state without the model or a new push', async (context) => {
  const { state, say } = harness(context, { payment: { updatedAt: new Date(Date.now() - 30_000) } });
  const reply = await say('It has not arrived');
  assert.match(reply, /number ending 678/);
  assert.match(reply, /phone is on.*signal/);
  assert.match(reply, /reply resend/i);
  assert.match(reply, /0720 111928/);
  assert.equal(state.stkPushes, 0);
});

test('the reported prompt never came keeps payment pending and does not push or confirm again', async (context) => {
  const { state, say } = harness(context);
  const reply = await say('The prompt never came');
  assert.equal(classifyPaymentMessage('The prompt never came'), 'not_arrived');
  assert.match(reply, /can't verify that a prompt reached your phone/);
  assert.match(reply, /number ending 678/);
  assert.doesNotMatch(reply, /sent.*to your phone|payment (?:is )?confirmed/i);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.bookingsCreated, 0);
  assert.equal(state.calendarEvents, 0);
  assert.equal(state.payment.status, 'pending');
  assert.equal(state.draft.step, 'payment_pending');
});

test('an expired 16 minute hold rechecks the slot before re-proposing, never pushing directly', async (context) => {
  const { state, say } = harness(context, { draft: { updatedAt: new Date(Date.now() - 16 * MINUTE) }, payment: { status: 'failed' } });
  let rechecked = 0;
  (bookingService.getAvailableSlots as any) = async (date: string, _duration: number, _booking: unknown, excludeDraftId: string) => {
    rechecked++; assert.equal(date, '2026-10-08'); assert.equal(excludeDraftId, 'draft-joan'); return ['15:00'];
  };
  const reply = await say('yes');
  assert.equal(rechecked, 1);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.draft.step, 'awaiting_confirmation');
  assert.match(reply, /hold ended.*still free/s);
  assert.match(reply, /deposit is Ksh 2,000.*Reply yes/s);
});

test('a slot taken during the expired hold offers alternatives and keeps the package', async (context) => {
  const { state, say } = harness(context, { draft: { updatedAt: new Date(Date.now() - 16 * MINUTE) }, payment: { status: 'cancelled' } });
  state.slots = ['10:00', '11:30'];
  const reply = await say('yes');
  assert.equal(state.stkPushes, 0);
  assert.equal(state.draft.step, 'collecting_slots');
  assert.equal(state.draft.service, 'THE ICON');
  assert.equal(state.draft.date, '2026-10-08');
  assert.equal(state.draft.time, null);
  assert.match(reply, /Icon edition/);
  assert.match(reply, /10:00 AM.*11:30 AM/);
});

test('I paid without a success row does not confirm and asks for the receipt code', async (context) => {
  const { state, say } = harness(context, { payment: { status: 'pending', updatedAt: new Date(Date.now() - 3 * MINUTE) } });
  const reply = await say('I paid');
  assert.match(reply, /can't see the payment yet.*receipt code/s);
  assert.doesNotMatch(reply, /confirmed|received/i);
  assert.equal(state.stkPushes, 0);
  const receipt = await say('SFK7ABC123');
  assert.match(receipt, /SFK7ABC123.*team/s);
  assert.doesNotMatch(receipt, /booking is confirmed/i);
  assert.ok(state.escalations.some((entry) => /SFK7ABC123/.test(entry)));
});

test('a success callback confirms once and a duplicate callback creates nothing', async (context) => {
  const { state, say } = harness(context);
  const callback = {
    CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'SFK7SUCCESS' }] },
  };
  await paymentController.processMpesaCallback(callback);
  assert.equal(state.bookingsCreated, 1);
  assert.equal(state.calendarEvents, 1);
  assert.equal(state.payment.status, 'success');
  assert.equal(state.draft, null);
  const confirmations = state.sent.length;
  await paymentController.processMpesaCallback(callback);
  assert.equal(state.bookingsCreated, 1);
  assert.equal(state.calendarEvents, 1);
  assert.equal(state.sent.length, confirmations);
  assert.match(await say('did it go through?'), /payment is confirmed/);
});

test('duplicate yes within 5 seconds sends one STK push', async (context) => {
  const { state, say } = harness(context, { payment: { status: 'cancelled' } });
  const replies = await Promise.all([say('yes'), say('yes')]);
  assert.equal(state.stkPushes, 1);
  assert.equal(replies.filter((reply) => /accepted a new deposit request/.test(reply)).length, 1);
  assert.equal(replies.filter((reply) => /already accepted|still being processed/.test(reply)).length, 1);
  assert.match(await say('yes'), /already accepted/);
  assert.equal(state.stkPushes, 1);
});

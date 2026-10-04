// Regression tests for the Phase 1 bug fixes in agent.service.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { bookingDraftService } from '../booking/booking-draft.service';
import { bookingService } from '../booking/booking.service';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import { mpesaService } from '../payment/mpesa.service';
import { nowInBusinessTimezone } from '../../utils/time';
import { getBookingPolicyWindow, RESCHEDULE_FORFEITURE_WINDOW_HOURS } from '../../utils/booking-policy';
import { AgentService, BookingExtractor } from './agent.service';

const agent = new AgentService() as any;
const extractor = new BookingExtractor() as any;

const PAYMENT_PROPOSAL = {
  role: 'assistant' as const,
  content: "Great, I can hold THE ICON for 2026-10-10 at 15:00. The deposit is KSH 2000. If that works for you, just reply yes and I'll send the M-Pesa prompt.",
};

function withQuietAgent(overrides: Record<string, unknown>) {
  const instance = new AgentService() as any;
  Object.assign(instance, {
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    escalate: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    runAgent: async () => ({ content: 'LLM', tokensUsed: 0 }),
    ...overrides,
  });
  return instance;
}

// #1 Encoding
test('agent.service.ts contains no mojibake or C1 control characters', () => {
  const source = readFileSync(path.join(__dirname, 'agent.service.ts'), 'utf8');
  assert.doesNotMatch(source, /â€|Ã|ðŸ|âš|[\u0080-\u009f]/);
});

test('confirmation detection matches curly-quoted "reply yes" prompts', () => {
  assert.equal(agent.previousMessageRequestsConfirmation([{ role: 'assistant', content: 'If that works, reply “yes” and I’ll confirm.' }]), true);
  assert.equal(agent.previousMessageRequestsConfirmation([{ role: 'assistant', content: 'If that works, reply "yes" and I’ll confirm.' }]), true);
});

test('cancellation confirmation accepts a clear yes but not acknowledgements', () => {
  for (const message of ['yes', 'yes please', 'yeah', 'yep', 'ndio', 'confirm']) {
    assert.equal(agent.isCancellationConfirmation(message), true, message);
  }
  for (const message of ['ok', 'okay', 'sawa', 'no', 'no, keep it', 'keep it']) {
    assert.equal(agent.isCancellationConfirmation(message), false, message);
  }
});

test('the shared 72-hour policy preserves strict boundary behavior', () => {
  const now = new Date('2026-10-03T12:00:00.000Z');
  const windowMs = RESCHEDULE_FORFEITURE_WINDOW_HOURS * 60 * 60 * 1000;

  assert.deepEqual(
    getBookingPolicyWindow(new Date(now.getTime() + windowMs - 1), now),
    { rescheduleForfeitsDeposit: true, cancellationRefundEligible: false }
  );
  assert.deepEqual(
    getBookingPolicyWindow(new Date(now.getTime() + windowMs), now),
    { rescheduleForfeitsDeposit: false, cancellationRefundEligible: false }
  );
  assert.deepEqual(
    getBookingPolicyWindow(new Date(now.getTime() + windowMs + 1), now),
    { rescheduleForfeitsDeposit: false, cancellationRefundEligible: true }
  );
});

test('cancellation confirmer requires cancel_confirm from the turn-start snapshot', async () => {
  await assert.rejects(
    agent.executeConfirmCancellationTool('customer-1', 'service'),
    /pending cancellation proposal from a prior message/
  );
});

test('okay does not cancel but yes confirms a pending cancellation', async () => {
  const originalFindUnique = prisma.bookingDraft.findUnique;
  (prisma.bookingDraft.findUnique as any) = async () => ({
    id: 'draft-1', step: 'cancel_confirm', bookingId: 'booking-1', date: '2026-10-10', cancelProposedAt: new Date(),
  });
  let cancellations = 0;
  const instance = withQuietAgent({
    executeConfirmCancellationTool: async () => {
      cancellations++;
        return { service: 'THE ICON', dateTime: new Date('2026-10-10T12:00:00Z'), refundEligible: true, depositPaid: true };
    },
  });
  const proposal = 'You asked to cancel your THE ICON session on October 10 at 3:00 PM. It is eligible for a refund under policy. If you want me to cancel this booking, reply yes to confirm.';
  try {
    const proposalHistory = [{ role: 'assistant' as const, content: proposal }];
    const acknowledgement = await instance.tryImmediateConfirmation('customer-1', 'okay', proposalHistory);
    assert.match(acknowledgement, /Please reply yes/);
    assert.equal(cancellations, 0);

    const confirmation = await instance.handleMessage('customer-1', 'yes', [
      { role: 'assistant', content: proposal },
    ], 'whatsapp');
    assert.match(confirmation, /has been cancelled/);
    assert.match(confirmation, /studio team has been notified to review any refund; no refund has been issued/i);
    assert.equal(cancellations, 1);
    assert.equal(instance.previousMessageRequestsConfirmation([{ role: 'assistant', content: proposal }]), true);
  } finally {
    prisma.bookingDraft.findUnique = originalFindUnique;
  }
});

test('no and keep it clear a pending cancellation and leave the booking unchanged', async () => {
  const originals = { deleteMany: prisma.bookingDraft.deleteMany, findUnique: prisma.bookingDraft.findUnique };
  const deletedSteps: string[] = [];
  (prisma.bookingDraft.findUnique as any) = async () => ({ step: 'cancel_confirm', cancelProposedAt: new Date() });
  (prisma.bookingDraft.deleteMany as any) = async ({ where }: any) => {
    deletedSteps.push(where.step);
    return { count: 1 };
  };
  const proposal = 'If you want me to cancel this booking, reply yes to confirm.';
  try {
    for (const message of ['no', 'keep it']) {
      const instance = withQuietAgent({});
      const reply = await instance.handleMessage('customer-1', message, [
        { role: 'assistant', content: proposal },
      ], 'whatsapp');
      assert.match(reply, /booking is unchanged/);
    }
    assert.deepEqual(deletedSteps, ['cancel_confirm', 'cancel_confirm']);
  } finally {
    prisma.bookingDraft.deleteMany = originals.deleteMany;
    prisma.bookingDraft.findUnique = originals.findUnique;
  }
});

test('cancellation proposal wording is recognized as a confirmation request', () => {
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'You asked to cancel your THE ICON session on October 10 at 3:00 PM. It is eligible for a refund under policy. If you want me to cancel this booking, reply yes to confirm.',
  }]), true);
});

test('multiple upcoming bookings require the customer to identify one before proposal', async () => {
  const originalFindMany = prisma.booking.findMany;
  const originalDraftFindUnique = prisma.bookingDraft.findUnique;
  const originalUpsert = prisma.bookingDraft.upsert;
  let draftWrites = 0;
  (prisma.bookingDraft.findUnique as any) = async () => null;
  (prisma.booking.findMany as any) = async () => [
    { id: 'booking-1', service: 'THE ICON', dateTime: new Date('2026-10-10T12:00:00Z') },
    { id: 'booking-2', service: 'THE BLOOM', dateTime: new Date('2026-10-17T12:00:00Z') },
  ];
  (prisma.bookingDraft.upsert as any) = async () => { draftWrites++; };

  try {
    const result = await agent.proposeCancellation('customer-1', 'cancel my booking', []);
    assert.match(result.reply, /Which session would you like me to cancel\?/);
    assert.match(result.reply, /THE ICON/);
    assert.match(result.reply, /THE BLOOM/);
    assert.equal(result.proposed, false);
    assert.equal(draftWrites, 0);
  } finally {
    prisma.booking.findMany = originalFindMany;
    prisma.bookingDraft.findUnique = originalDraftFindUnique;
    prisma.bookingDraft.upsert = originalUpsert;
  }
});

test('unrelated bookingDraft updates do not extend cancellation proposal expiry', () => {
  const proposedAt = new Date(Date.now() - 60 * 60 * 1000 - 1);
  const draftAfterUnrelatedUpdate = { cancelProposedAt: proposedAt, updatedAt: new Date() };
  assert.equal(agent.isCancellationProposalExpired(draftAfterUnrelatedUpdate), true);
});

test('a unique cancellation proposal writes its dedicated proposal timestamp', async () => {
  const originals = { findUnique: prisma.bookingDraft.findUnique, findMany: prisma.booking.findMany, upsert: prisma.bookingDraft.upsert };
  let savedDraft: any;
  (prisma.bookingDraft.findUnique as any) = async () => null;
  (prisma.booking.findMany as any) = async () => [{
    id: 'booking-1',
    service: 'THE ICON',
    dateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }];
  (prisma.bookingDraft.upsert as any) = async ({ create, update }: any) => {
    savedDraft = { create, update };
    return {};
  };

  try {
    const result = await agent.proposeCancellation('customer-1', 'cancel', []);
    assert.equal(result.proposed, true);
    assert.ok(savedDraft.create.cancelProposedAt instanceof Date);
    assert.ok(savedDraft.update.cancelProposedAt instanceof Date);
  } finally {
    prisma.bookingDraft.findUnique = originals.findUnique;
    prisma.booking.findMany = originals.findMany;
    prisma.bookingDraft.upsert = originals.upsert;
  }
});

test('an explicit previous-addon question does not require prior assistant wording', () => {
  assert.equal(agent.shouldUsePreviousAddonReply('Which add-ons did I choose before?'), true);
  assert.equal(agent.shouldUsePreviousAddonReply('Which package did I choose before?'), false);
});

test('all package deposit displays and booking charges use one helper result', async () => {
  const originals = {
    packageFindMany: prisma.package.findMany,
    packageFindUnique: prisma.package.findUnique,
    packageFindFirst: prisma.package.findFirst,
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftUpdate: prisma.bookingDraft.update,
    studioInfoFindFirst: prisma.studioInfo.findFirst,
    customerFindUnique: prisma.customer.findUnique,
    paymentUpsert: prisma.payment.upsert,
    slots: bookingService.getAvailableSlots,
    saveProposal: bookingDraftService.saveBookingProposal,
    draftGet: bookingDraftService.get,
    markPaymentPending: bookingDraftService.markPaymentPending,
    stkPush: mpesaService.initiateStkPush,
  };
  const sharedDeposit = 3210;
  const helperCalls: string[] = [];
  const stkAmounts: number[] = [];
  const proposalSaves: unknown[] = [];
  const instance = new AgentService() as any;
  const draft = {
    id: 'draft-deposit-test',
    step: 'awaiting_confirmation',
    service: 'THE ICON',
    date: '2026-10-10',
    time: '15:00',
    dateTimeIso: '2026-10-10T12:00:00.000Z',
  };
  Object.assign(instance, {
    getDepositForPackage: (pkg: { name: string; deposit: number | null } | null) => {
      helperCalls.push(pkg?.name || '<missing-package>');
      return sharedDeposit;
    },
  });
  (prisma.package.findMany as any) = async () => [{ name: 'THE ICON', deposit: sharedDeposit }];
  (prisma.package.findUnique as any) = async ({ where }: any) => ({ name: where.name, deposit: sharedDeposit });
  (prisma.package.findFirst as any) = async () => ({ name: 'THE BLOOM', deposit: sharedDeposit });
  (prisma.bookingDraft.findUnique as any) = async () => draft;
  (prisma.bookingDraft.update as any) = async () => draft;
  (prisma.studioInfo.findFirst as any) = async () => ({ location: 'Studio' });
  (prisma.customer.findUnique as any) = async () => ({ id: 'customer-1', name: 'Jane Doe' });
  (prisma.payment.upsert as any) = async () => ({});
  (bookingService.getAvailableSlots as any) = async () => ['15:00'];
  (bookingDraftService.saveBookingProposal as any) = async (proposal: unknown) => { proposalSaves.push(proposal); };
  (bookingDraftService.get as any) = async () => draft;
  (bookingDraftService.markPaymentPending as any) = async () => {};
  (mpesaService.initiateStkPush as any) = async (_customerId: string, amount: number) => {
    stkAmounts.push(amount);
    return { CheckoutRequestID: 'checkout-deposit-test' };
  };

  try {
    const packageSelection = await instance.getPackageSelectionReply('customer-1', 'I want THE ICON');
    const sameSlot = await instance.getSameBookingSlotReply('customer-1', [
      { role: 'user', content: 'I want THE ICON' },
    ]);
    const bookingProcess = await instance.getBookingProcessReply();
    const ambiguousDeposit = await instance.getAmbiguousDepositReply();
    const additions = await instance.getAdditionsReply();
    const proposal = await instance.executeProposeBookingTool(
      'customer-1', 'Jane Doe', 'THE ICON', '2026-10-10T15:00'
    );
    const confirmation = await instance.executeConfirmBookingTool('customer-1', 'awaiting_confirmation', sharedDeposit);

    for (const reply of [packageSelection, sameSlot, bookingProcess, ambiguousDeposit, additions]) {
      assert.match(reply, /Ksh 3,210/);
    }
    assert.equal(proposal.depositAmount, sharedDeposit);
    assert.equal(confirmation.depositAmount, sharedDeposit);
    assert.deepEqual(stkAmounts, [sharedDeposit]);
    assert.equal(proposalSaves.length, 1);
    assert.equal(helperCalls.length, 5);
  } finally {
    prisma.package.findMany = originals.packageFindMany;
    prisma.package.findUnique = originals.packageFindUnique;
    prisma.package.findFirst = originals.packageFindFirst;
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.update = originals.draftUpdate;
    prisma.studioInfo.findFirst = originals.studioInfoFindFirst;
    prisma.customer.findUnique = originals.customerFindUnique;
    prisma.payment.upsert = originals.paymentUpsert;
    bookingService.getAvailableSlots = originals.slots;
    bookingDraftService.saveBookingProposal = originals.saveProposal;
    bookingDraftService.get = originals.draftGet;
    bookingDraftService.markPaymentPending = originals.markPaymentPending;
    mpesaService.initiateStkPush = originals.stkPush;
  }
});

test('confirmation refuses to charge if the package deposit changed after proposal', async () => {
  const originals = {
    packageFindUnique: prisma.package.findUnique,
    draftGet: bookingDraftService.get,
    slots: bookingService.getAvailableSlots,
    markPaymentPending: bookingDraftService.markPaymentPending,
    stkPush: mpesaService.initiateStkPush,
  };
  let paymentMarkedPending = false;
  let paymentStarted = false;
  const instance = new AgentService() as any;
  Object.assign(instance, {
    getDepositForPackage: async () => 3200,
  });
  (prisma.package.findUnique as any) = async ({ where }: any) => ({ name: where.name, deposit: 3200 });
  (bookingDraftService.get as any) = async () => ({
    id: 'draft-price-changed',
    step: 'awaiting_confirmation',
    service: 'THE ICON',
    date: '2026-10-10',
    time: '15:00',
  });
  (bookingService.getAvailableSlots as any) = async () => ['15:00'];
  (bookingDraftService.markPaymentPending as any) = async () => { paymentMarkedPending = true; };
  (mpesaService.initiateStkPush as any) = async () => { paymentStarted = true; return { CheckoutRequestID: 'must-not-send' }; };

  try {
    for (const proposedAmount of [3000, null]) {
      paymentMarkedPending = false;
      paymentStarted = false;
      await assert.rejects(
        instance.executeConfirmBookingTool('customer-1', 'awaiting_confirmation', proposedAmount),
        /no longer matches the amount in the customer-visible proposal/
      );
      assert.equal(paymentMarkedPending, false);
      assert.equal(paymentStarted, false);
    }
  } finally {
    prisma.package.findUnique = originals.packageFindUnique;
    bookingDraftService.get = originals.draftGet;
    bookingService.getAvailableSlots = originals.slots;
    bookingDraftService.markPaymentPending = originals.markPaymentPending;
    mpesaService.initiateStkPush = originals.stkPush;
  }
});

test('proposal amount extraction fails closed when the prior reply is missing or reworded', () => {
  assert.equal(agent.getDepositAmountFromProposalHistory([PAYMENT_PROPOSAL]), 2000);
  assert.equal(agent.getDepositAmountFromProposalHistory([]), null);
  assert.equal(agent.getDepositAmountFromProposalHistory([{
    role: 'assistant',
    content: 'Your deposit will be Ksh 2,000. Reply yes if that works.',
  }]), null);
});

test('zero or null package deposits never appear in replies or initiate payment', async () => {
  const originals = {
    packageFindMany: prisma.package.findMany,
    packageFindUnique: prisma.package.findUnique,
    packageFindFirst: prisma.package.findFirst,
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftUpdate: prisma.bookingDraft.update,
    studioInfoFindFirst: prisma.studioInfo.findFirst,
    customerFindUnique: prisma.customer.findUnique,
    slots: bookingService.getAvailableSlots,
    saveProposal: bookingDraftService.saveBookingProposal,
    draftGet: bookingDraftService.get,
    markPaymentPending: bookingDraftService.markPaymentPending,
    stkPush: mpesaService.initiateStkPush,
  };
  let configuredDeposit: number | null = 0;
  let proposalSaves = 0;
  let paymentStarted = 0;
  const draft = {
    id: 'draft-invalid-deposit',
    step: 'awaiting_confirmation',
    service: 'THE ICON',
    date: '2026-10-10',
    time: '15:00',
    dateTimeIso: '2026-10-10T12:00:00.000Z',
  };
  const instance = new AgentService() as any;
  (prisma.package.findMany as any) = async () => [{ name: 'THE ICON', deposit: configuredDeposit }];
  (prisma.package.findUnique as any) = async ({ where }: any) => ({ name: where.name, deposit: configuredDeposit });
  (prisma.package.findFirst as any) = async () => ({ name: 'THE ICON', deposit: configuredDeposit });
  (prisma.bookingDraft.findUnique as any) = async () => draft;
  (prisma.bookingDraft.update as any) = async () => draft;
  (prisma.studioInfo.findFirst as any) = async () => ({ location: 'Studio' });
  (prisma.customer.findUnique as any) = async () => ({ id: 'customer-1', name: 'Jane Doe' });
  (bookingService.getAvailableSlots as any) = async () => ['15:00'];
  (bookingDraftService.saveBookingProposal as any) = async () => { proposalSaves++; };
  (bookingDraftService.get as any) = async () => draft;
  (bookingDraftService.markPaymentPending as any) = async () => {};
  (mpesaService.initiateStkPush as any) = async () => { paymentStarted++; return { CheckoutRequestID: 'must-not-send' }; };

  try {
    for (const invalidDeposit of [0, null]) {
      configuredDeposit = invalidDeposit;
      const packageSelection = await instance.getPackageSelectionReply('customer-1', 'I want THE ICON');
      const sameSlot = await instance.getSameBookingSlotReply('customer-1', [
        { role: 'user', content: 'I want THE ICON' },
      ]);
      const bookingProcess = await instance.getBookingProcessReply();
      const ambiguousDeposit = await instance.getAmbiguousDepositReply();
      const additions = await instance.getAdditionsReply();
      for (const reply of [packageSelection, sameSlot, bookingProcess, ambiguousDeposit, additions]) {
        assert.doesNotMatch(reply, /(?:deposit is|deposit of|deposit prompt of|deposit\s+\(starting from)\s*Ksh\s*[0-9,]+/i);
      }

      await assert.rejects(
        instance.executeProposeBookingTool('customer-1', 'Jane Doe', 'THE ICON', '2026-10-10T15:00'),
        /missing or invalid/
      );
      await assert.rejects(
        instance.executeConfirmBookingTool('customer-1', 'awaiting_confirmation', 2000),
        /missing or invalid/
      );
    }
    assert.equal(proposalSaves, 0);
    assert.equal(paymentStarted, 0);
  } finally {
    prisma.package.findMany = originals.packageFindMany;
    prisma.package.findUnique = originals.packageFindUnique;
    prisma.package.findFirst = originals.packageFindFirst;
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.update = originals.draftUpdate;
    prisma.studioInfo.findFirst = originals.studioInfoFindFirst;
    prisma.customer.findUnique = originals.customerFindUnique;
    bookingService.getAvailableSlots = originals.slots;
    bookingDraftService.saveBookingProposal = originals.saveProposal;
    bookingDraftService.get = originals.draftGet;
    bookingDraftService.markPaymentPending = originals.markPaymentPending;
    mpesaService.initiateStkPush = originals.stkPush;
  }
});

test('an unrelated turn clears a pending cancellation before a later yes', async () => {
  const originals = {
    bookingFindMany: prisma.booking.findMany,
    bookingUpdate: prisma.booking.update,
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftUpsert: prisma.bookingDraft.upsert,
    draftDeleteMany: prisma.bookingDraft.deleteMany,
  };
  let draft: any = null;
  let cancellations = 0;
  let runAgentCalls = 0;
  (prisma.booking.findMany as any) = async () => [{
    id: 'booking-1',
    service: 'THE ICON',
    dateTime: new Date('2026-10-10T12:00:00Z'),
    status: 'confirmed',
    googleEventId: null,
  }];
  (prisma.booking.update as any) = async () => { cancellations++; return {}; };
  (prisma.bookingDraft.findUnique as any) = async () => draft;
  (prisma.bookingDraft.upsert as any) = async ({ create, update }: any) => {
    draft = { id: 'draft-1', ...create, ...update };
    draft.updatedAt = new Date();
    return draft;
  };
  (prisma.bookingDraft.deleteMany as any) = async () => {
    draft = null;
    return { count: 1 };
  };

  const instance = withQuietAgent({
    runAgent: async () => {
      runAgentCalls++;
      return { content: 'I can help with studio hours.', tokensUsed: 0 };
    },
  });
  instance.naturalAssistantMode = true;
  try {
    const proposal = await instance.handleMessage('customer-1', 'cancel', [], 'whatsapp');
    assert.match(proposal, /If you want me to cancel this booking, reply yes to confirm/);
    assert.equal(draft.step, 'cancel_confirm');

    const afterUnrelated = await instance.handleMessage('customer-1', 'how much is the empress?', [
      { role: 'user', content: 'cancel' },
      { role: 'assistant', content: proposal },
    ], 'whatsapp');
    assert.equal(draft, null);
    assert.match(afterUnrelated, /studio hours/);

    await instance.handleMessage('customer-1', 'yes', [
      { role: 'user', content: 'how much is the empress?' },
      { role: 'assistant', content: afterUnrelated },
    ], 'whatsapp');
    assert.equal(cancellations, 0);
    assert.equal(runAgentCalls, 2);
  } finally {
    prisma.booking.findMany = originals.bookingFindMany;
    prisma.booking.update = originals.bookingUpdate;
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.upsert = originals.draftUpsert;
    prisma.bookingDraft.deleteMany = originals.draftDeleteMany;
  }
});

test('a cancellation proposal expires after one hour and a later yes cannot cancel', async () => {
  const originals = { findUnique: prisma.bookingDraft.findUnique, deleteMany: prisma.bookingDraft.deleteMany };
  let deleted = false;
  let runAgentCalls = 0;
  (prisma.bookingDraft.findUnique as any) = async () => ({
    step: 'cancel_confirm',
    bookingId: 'booking-1',
    date: '2026-10-10',
    cancelProposedAt: new Date(Date.now() - 60 * 60 * 1000 - 1),
    updatedAt: new Date(),
  });
  (prisma.bookingDraft.deleteMany as any) = async () => { deleted = true; return { count: 1 }; };
  const instance = withQuietAgent({
    runAgent: async () => { runAgentCalls++; return { content: 'LLM', tokensUsed: 0 }; },
  });
  try {
    const reply = await instance.handleMessage('customer-1', 'yes', [{
      role: 'assistant',
      content: 'If you want me to cancel this booking, reply yes to confirm.',
    }], 'whatsapp');
    assert.match(reply, /proposal expired.*booking was not changed/i);
    assert.equal(deleted, true);
    assert.equal(runAgentCalls, 0);
  } finally {
    prisma.bookingDraft.findUnique = originals.findUnique;
    prisma.bookingDraft.deleteMany = originals.deleteMany;
  }
});

test('cancellation proposals preserve awaiting_confirmation and payment_pending drafts', async () => {
  const originalFindUnique = prisma.bookingDraft.findUnique;
  const originalUpsert = prisma.bookingDraft.upsert;
  let activeDraft: any;
  let upserts = 0;
  (prisma.bookingDraft.findUnique as any) = async () => activeDraft;
  (prisma.bookingDraft.upsert as any) = async () => { upserts++; };

  try {
    for (const step of ['awaiting_confirmation', 'payment_pending']) {
      activeDraft = { id: 'active-draft', step, service: 'THE ICON', updatedAt: new Date() };
      const result = await agent.proposeCancellation('customer-1', 'cancel', []);
      assert.equal(result.proposed, false);
      assert.match(result.reply, step === 'payment_pending' ? /M-Pesa payment prompt is already pending/ : /booking proposal is already awaiting your confirmation/);
      assert.equal(activeDraft.step, step);
    }
    assert.equal(upserts, 0);
  } finally {
    prisma.bookingDraft.findUnique = originalFindUnique;
    prisma.bookingDraft.upsert = originalUpsert;
  }
});

test('system prompt requires a separate explicit cancellation confirmation', async () => {
  const prompt = agent.getSystemPrompt('', 'whatsapp');
  assert.match(prompt, /CANCELLATIONS MUST BE TWO STEPS AND REAL, NOT TEXT-ONLY/i);
  assert.match(prompt, /"ok", "okay", and "sawa" are not cancellation consent/i);
  assert.match(prompt, /unrelated message.*clear the pending cancellation proposal/i);
  assert.match(prompt, /has not expired/i);
  assert.match(prompt, /Never replace an existing booking, reschedule, or payment draft/i);
  const source = readFileSync(path.join(__dirname, 'agent.service.ts'), 'utf8');
  assert.match(source, /Two-step cancellation tool/);
});

test('package-price prompt uses a warned fallback when package rows are unavailable', async () => {
  const originalFindMany = prisma.package.findMany;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  (prisma.package.findMany as any) = async () => { throw new Error('database unavailable'); };
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const pricing = await agent.getPackagePricingLine();
    assert.match(pricing, /THE BLOOM: Ksh 15,000/);
    assert.ok(warnings.some((warning) => /using the hardcoded package-price prompt fallback/.test(warning)));
  } finally {
    prisma.package.findMany = originalFindMany;
    console.warn = originalWarn;
  }
});

test('cancellation notification flags a successful deposit for manual refund review', async () => {
  const originals = {
    bookingFindMany: prisma.booking.findMany,
    bookingUpdate: prisma.booking.update,
    draftDeleteMany: prisma.bookingDraft.deleteMany,
    paymentFindFirst: prisma.payment.findFirst,
    notificationCreate: prisma.notification.create,
  };
  let notificationData: any;
  (prisma.booking.findMany as any) = async () => [{
    id: 'booking-paid',
    service: 'THE ICON',
    dateTime: new Date('2026-10-10T12:00:00Z'),
    status: 'confirmed',
    googleEventId: null,
  }];
  (prisma.booking.update as any) = async () => ({});
  (prisma.bookingDraft.deleteMany as any) = async () => ({ count: 1 });
  (prisma.payment.findFirst as any) = async () => ({ amount: 2000, mpesaReceipt: 'TEST-RECEIPT' });
  (prisma.notification.create as any) = async ({ data }: any) => {
    notificationData = data;
    return { id: 'notification-1', ...data };
  };

  try {
    const result = await agent.executeCancelBookingTool('customer-1', undefined, 'booking-paid');
    assert.equal(result.depositPaid, true);
    assert.equal(notificationData.metadata.successfulDepositRecorded, true);
    assert.equal(notificationData.metadata.depositAmount, 2000);
    assert.equal(notificationData.metadata.mpesaReceipt, 'TEST-RECEIPT');
    assert.equal(notificationData.metadata.manualRefundReviewRequired, true);
    assert.match(notificationData.message, /Studio team: manual refund review is required; no refund was issued by the assistant/);
    assert.equal(notificationData.metadata.refundReviewOwner, 'studio_team');
  } finally {
    prisma.booking.findMany = originals.bookingFindMany;
    prisma.booking.update = originals.bookingUpdate;
    prisma.bookingDraft.deleteMany = originals.draftDeleteMany;
    prisma.payment.findFirst = originals.paymentFindFirst;
    prisma.notification.create = originals.notificationCreate;
  }
});

test('payment-pending reply uses a real apostrophe', async () => {
  const original = prisma.bookingDraft.findUnique;
  (prisma.bookingDraft.findUnique as any) = async () => ({ step: 'payment_pending', service: 'THE ICON' });
  try {
    const reply = await agent.tryImmediateConfirmation('customer-1', 'yes');
    assert.match(reply, /^I’ve already sent the M-Pesa deposit prompt/);
  } finally {
    prisma.bookingDraft.findUnique = original;
  }
});

// #2 Date hijacking
test('regex extraction never treats pregnancy months or hours as a day of month', () => {
  for (const message of [
    "I'm 7 months pregnant, can we do Saturday at 3pm?",
    'Can we book THE ICON at 3pm please',
    'Can we do 15:00 on Saturday for the icon',
    'october at 3pm would be lovely',
  ]) {
    assert.equal(extractor.regexExtract(message).date, null, message);
  }
});

test('regex extraction accepts ordinals, month-adjacent days and ISO dates', () => {
  assert.equal(dayjs(extractor.regexExtract('the 12th at 3pm please').date).date(), 12);
  assert.equal(dayjs(extractor.regexExtract('can we do 3 Oct at 3pm').date).date(), 3);
  assert.equal(dayjs(extractor.regexExtract('October 3 at 10am works').date).date(), 3);
  assert.equal(extractor.regexExtract('book 2026-11-14 at 3pm').date, '2026-11-14');
});

test('a bare number cannot override the requested weekday', () => {
  const requested = agent.getAuthoritativeRequestedDate(
    "I'm 7 months pregnant, can we do Saturday at 3pm?",
    '2026-10-10',
    '2026-10-07',
    []
  );
  assert.notEqual(requested, '2026-10-07');
  assert.equal(dayjs(requested).day(), 6);
});

// #3 Stuck payment draft
test('a failed STK push puts the draft back to awaiting_confirmation', async () => {
  const originals = {
    get: bookingDraftService.get,
    slots: bookingService.getAvailableSlots,
    packageFindUnique: prisma.package.findUnique,
    draftUpdate: prisma.bookingDraft.update,
    stk: mpesaService.initiateStkPush,
    paymentUpsert: prisma.payment.upsert,
  };
  const steps: string[] = [];
  let paymentRecorded = false;
  (bookingDraftService.get as any) = async () => ({ id: 'draft-1', step: 'awaiting_confirmation', service: 'THE ICON', date: '2026-10-10', time: '15:00' });
  (bookingService.getAvailableSlots as any) = async () => ['15:00'];
  (prisma.package.findUnique as any) = async () => ({ name: 'THE ICON', deposit: 2000 });
  (prisma.bookingDraft.update as any) = async ({ data }: any) => { steps.push(data.step); return {}; };
  (mpesaService.initiateStkPush as any) = async () => { throw new Error('Daraja timeout'); };
  (prisma.payment.upsert as any) = async () => { paymentRecorded = true; };

  try {
    await assert.rejects(agent.executeConfirmBookingTool('customer-1', 'awaiting_confirmation', 2000), /couldn't initiate the payment request/);
    assert.deepEqual(steps, ['payment_pending', 'awaiting_confirmation']);
    assert.equal(paymentRecorded, false);
  } finally {
    bookingDraftService.get = originals.get;
    bookingService.getAvailableSlots = originals.slots;
    prisma.package.findUnique = originals.packageFindUnique;
    prisma.bookingDraft.update = originals.draftUpdate;
    mpesaService.initiateStkPush = originals.stk;
    prisma.payment.upsert = originals.paymentUpsert;
  }
});

// #4 Unanchored reschedule keywords
test('"exchange" and "remove" are not reschedule requests', () => {
  for (const message of ['can I exchange my outfit', 'please remove the extra outfit', 'what is the exchange policy']) {
    assert.equal(agent.shouldUseRescheduleRequestReply(message), false, message);
    assert.notEqual(agent.inferIntent(message).intent, 'reschedule', message);
  }
});

test('real reschedule wording still matches, including inflections', () => {
  for (const message of ["I'd like to move my appointment", 'can we change it', 'rescheduling please', 'I need to postpone']) {
    assert.equal(agent.shouldUseRescheduleRequestReply(message), true, message);
    assert.equal(agent.inferIntent(message).intent, 'reschedule', message);
  }
});

// Extra #2: "ok"/"sawa" must not send an M-Pesa prompt
test('payment confirmation requires an explicit yes; ok/okay/sawa and negations are rejected', () => {
  for (const message of ['yes', 'Yes please', 'yess', 'yeah', 'yep', 'ndio', 'confirm', 'confirmed', 'go ahead', 'go-ahead', 'proceed', 'yes go ahead and send it']) {
    assert.equal(agent.isPaymentConfirmation(message), true, message);
  }
  for (const message of ['ok', 'okay', 'sawa', 'that works', 'yes but wait', 'yeah hold on', 'no', 'not yet', 'ndio but not today']) {
    assert.equal(agent.isPaymentConfirmation(message), false, message);
  }
});

for (const message of ['ok', 'okay', 'sawa']) {
  test(`"${message}" after a booking proposal does not send the M-Pesa prompt`, async () => {
    const original = prisma.bookingDraft.findUnique;
    (prisma.bookingDraft.findUnique as any) = async () => ({ step: 'awaiting_confirmation', service: 'THE ICON' });
    let paymentStarted = false;
    const instance = withQuietAgent({
      executeConfirmBookingTool: async () => { paymentStarted = true; return { depositAmount: 2000, service: 'THE ICON' }; },
    });
    try {
      const reply = await instance.handleMessage('customer-1', message, [PAYMENT_PROPOSAL], 'whatsapp');
      assert.equal(paymentStarted, false);
      assert.match(reply, /please reply yes to confirm/i);
    } finally {
      prisma.bookingDraft.findUnique = original;
    }
  });
}

test('"yes" after a booking proposal still sends the M-Pesa prompt', async () => {
  const original = prisma.bookingDraft.findUnique;
  (prisma.bookingDraft.findUnique as any) = async () => ({ step: 'awaiting_confirmation', service: 'THE ICON' });
  let paymentStarted = false;
  const instance = withQuietAgent({
    executeConfirmBookingTool: async () => { paymentStarted = true; return { depositAmount: 2000, service: 'THE ICON' }; },
  });
  try {
    const reply = await instance.handleMessage('customer-1', 'yes', [PAYMENT_PROPOSAL], 'whatsapp');
    assert.equal(paymentStarted, true);
    assert.match(reply, /sent the M-Pesa deposit prompt of KSH 2000/);
  } finally {
    prisma.bookingDraft.findUnique = original;
  }
});

test('"okay" still confirms a pending reschedule', async () => {
  const original = prisma.bookingDraft.findUnique;
  (prisma.bookingDraft.findUnique as any) = async () => ({ step: 'reschedule_confirm' });
  let rescheduled = false;
  const instance = withQuietAgent({
    executeConfirmRescheduleTool: async () => {
      rescheduled = true;
      return { service: 'THE ICON', newDateTime: new Date('2026-10-10T12:00:00.000Z'), oldDateTime: new Date('2026-10-08T12:00:00.000Z'), depositForfeited: false };
    },
    notifyRescheduleAdmin: async () => {},
  });
  try {
    await instance.handleMessage('customer-1', 'okay', [{ role: 'assistant', content: "I can move your session to Saturday at 3 PM. If that works for you, just reply yes and I'll confirm it." }], 'whatsapp');
    assert.equal(rescheduled, true);
  } finally {
    prisma.bookingDraft.findUnique = original;
  }
});

// Extra #3: post-shoot vs upcoming appointment details
test('post-shoot questions are excluded from upcoming appointment details', () => {
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('What happens after the shoot?'), false);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('what happens after my shoot'), false);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('Tell me more about my upcoming session'), true);
});

// Extra #4: accurate immediate-confirmation failure text
test('a failed immediate confirmation gives a generic reply, not a reschedule-specific one', async () => {
  const instance = withQuietAgent({
    tryImmediateConfirmation: async () => { throw new Error('db down'); },
  });
  const reply = await instance.handleMessage('customer-1', 'yes', [PAYMENT_PROPOSAL], 'whatsapp');
  assert.doesNotMatch(reply, /reschedul/i);
  assert.match(reply, /couldn’t finish that step/);
});

// Follow-up #2: date signals
test('date signals ignore bare numbers but keep weekdays, relative days and real dates', () => {
  for (const message of ["I'm 7 months pregnant", 'I want 2 of them', 'lets do 3pm']) {
    assert.equal(agent.messageContainsExplicitDateSignal(message), false, message);
  }
  for (const message of ['Saturday at 3pm', 'tomorrow at 2pm', 'next week', 'today please', 'the 12th', '3 Oct', '2026-11-14']) {
    assert.equal(agent.messageContainsExplicitDateSignal(message), true, message);
  }
  assert.equal(agent.messageContainsExplicitDateTimeSignal("I'm 7 months pregnant, can we do 3pm"), false);
  assert.equal(agent.messageContainsExplicitDateTimeSignal('Saturday at 3pm'), true);
});

// Follow-up #3: month names
test('regex extraction uses the month name and rolls into next year when it has passed', () => {
  const today = nowInBusinessTimezone().startOf('day');
  for (const [message, month, day] of [
    ['can we do 3 Dec at 3pm', 11, 3],
    ['how about Jan 15 at 10am', 0, 15],
    ['the 5th of March at 2pm please', 2, 5],
  ] as const) {
    const date = dayjs(extractor.regexExtract(message).date);
    assert.equal(date.month(), month, message);
    assert.equal(date.date(), day, message);
    assert.ok(!date.isBefore(today, 'day') && date.isBefore(today.add(1, 'year').add(1, 'day')), message);
  }
  assert.equal(extractor.regexExtract('can we book 31 Nov at 3pm').date, null);
});

// Follow-up #4: prompt sent but not recorded
test('a payment prompt that was sent but not recorded keeps the draft pending and asks the customer to check their phone', async () => {
  const originals = {
    get: bookingDraftService.get,
    slots: bookingService.getAvailableSlots,
    packageFindUnique: prisma.package.findUnique,
    draftUpdate: prisma.bookingDraft.update,
    stk: mpesaService.initiateStkPush,
    paymentUpsert: prisma.payment.upsert,
  };
  const steps: string[] = [];
  (bookingDraftService.get as any) = async () => ({ id: 'draft-1', step: 'awaiting_confirmation', service: 'THE ICON', date: '2026-10-10', time: '15:00' });
  (bookingService.getAvailableSlots as any) = async () => ['15:00'];
  (prisma.package.findUnique as any) = async () => ({ name: 'THE ICON', deposit: 2000 });
  (prisma.bookingDraft.update as any) = async ({ data }: any) => { steps.push(data.step); return {}; };
  (mpesaService.initiateStkPush as any) = async () => ({ CheckoutRequestID: 'ws_CO_1' });
  (prisma.payment.upsert as any) = async () => { throw new Error('db down'); };

  try {
    const error: any = await agent.executeConfirmBookingTool('customer-1', 'awaiting_confirmation', 2000).catch((e: any) => e);
    assert.equal(error.code, 'PAYMENT_PROMPT_UNRECORDED');
    assert.match(error.message, /Do not send another prompt/);
    assert.deepEqual(steps, ['payment_pending']);
  } finally {
    bookingDraftService.get = originals.get;
    bookingService.getAvailableSlots = originals.slots;
    prisma.package.findUnique = originals.packageFindUnique;
    prisma.bookingDraft.update = originals.draftUpdate;
    mpesaService.initiateStkPush = originals.stk;
    prisma.payment.upsert = originals.paymentUpsert;
  }

  const instance = withQuietAgent({
    tryImmediateConfirmation: async () => { throw Object.assign(new Error('unrecorded'), { code: 'PAYMENT_PROMPT_UNRECORDED' }); },
  });
  const reply = await instance.handleMessage('customer-1', 'yes', [PAYMENT_PROPOSAL], 'whatsapp');
  assert.match(reply, /check your phone for an M-Pesa prompt before trying again/);
});

// Follow-up #5: anchored book / pay / with / join
test('book, pay and with/join keywords only match whole words', () => {
  assert.notEqual(agent.inferIntent('saw you on facebook').intent, 'booking');
  assert.equal(agent.inferIntent('I want to book a session').intent, 'booking');
  assert.equal(agent.inferIntent('I already booked').intent, 'booking');
  assert.notEqual(agent.inferIntent('I will repay you later').intent, 'payment');
  assert.equal(agent.inferIntent('I have paid').intent, 'payment');
  assert.equal(agent.inferIntent('can I pay now').intent, 'payment');
  assert.equal(agent.shouldUseMultiPersonBookingReply('my sister is coming without me to the shoot'), false);
  assert.equal(agent.shouldUseMultiPersonBookingReply('Can my sister join the shoot with me?'), true);
  assert.equal(agent.shouldUseMultiPersonBookingReply('my husband is joining the session'), true);
});

// Follow-up #6: no silent 'standard' fallback for deposits
test('an unrecognised package stops payment instead of falling back to a legacy deposit', async () => {
  const originals = { get: bookingDraftService.get, markPaymentPending: bookingDraftService.markPaymentPending, stk: mpesaService.initiateStkPush };
  let paymentStarted = false;
  (bookingDraftService.get as any) = async () => ({ id: 'draft-1', step: 'awaiting_confirmation', service: 'Mystery Package', date: '2026-10-10', time: '15:00' });
  (bookingDraftService.markPaymentPending as any) = async () => { paymentStarted = true; };
  (mpesaService.initiateStkPush as any) = async () => { paymentStarted = true; };
  try {
    await assert.rejects(agent.executeConfirmBookingTool('customer-1', 'awaiting_confirmation', 2000), /isn't recognised.*Do not start payment/);
    assert.equal(paymentStarted, false);
  } finally {
    bookingDraftService.get = originals.get;
    bookingDraftService.markPaymentPending = originals.markPaymentPending;
    mpesaService.initiateStkPush = originals.stk;
  }
});

// Follow-up #7: confirm_booking gate inside runAgent
for (const [message, shouldSend] of [['okay', false], ['yes', true]] as const) {
  test(`runAgent: model calls confirm_booking after "${message}" -> prompt ${shouldSend ? 'sent' : 'blocked'}`, async () => {
    const originals = {
      customer: prisma.customer.findUnique,
      draft: prisma.bookingDraft.findUnique,
      memory: prisma.customerMemory.findUnique,
      search: knowledgeRetrieval.search,
    };
    (prisma.customer.findUnique as any) = async () => ({ name: 'Miriam', bookings: [] });
    (prisma.bookingDraft.findUnique as any) = async () => ({ step: 'awaiting_confirmation', service: 'THE ICON' });
    (prisma.customerMemory.findUnique as any) = async () => null;
    (knowledgeRetrieval.search as any) = async () => [];

    let paymentStarted = false;
    const toolResults: string[] = [];
    let call = 0;
    const instance = withQuietAgent({
      executeConfirmBookingTool: async () => {
        paymentStarted = true;
        return { depositAmount: 2000, service: 'THE ICON', date: '2026-10-10', time: '15:00' };
      },
      createCompletionWithToolNameGuard: async (params: any) => {
        call++;
        if (call === 1) {
          return {
            provider: 'groq',
            completionCalls: 1,
            response: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'confirm_booking', arguments: '{}' } }] } }] },
          };
        }
        toolResults.push(...params.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content));
        return { provider: 'groq', completionCalls: 1, response: { choices: [{ message: { role: 'assistant', content: 'Done.' } }] } };
      },
    });

    try {
      await (AgentService.prototype as any).runAgent.call(instance, 'customer-1', message, [PAYMENT_PROPOSAL], 'whatsapp');
      assert.equal(paymentStarted, shouldSend);
      assert.equal(toolResults.length, 1);
      if (shouldSend) {
        assert.match(toolResults[0], /initiated a deposit payment request/);
      } else {
        assert.match(toolResults[0], /M-Pesa prompt was NOT sent/);
      }
    } finally {
      prisma.customer.findUnique = originals.customer;
      prisma.bookingDraft.findUnique = originals.draft;
      prisma.customerMemory.findUnique = originals.memory;
      knowledgeRetrieval.search = originals.search;
    }
  });
}

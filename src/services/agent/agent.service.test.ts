import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import prisma from '../../config/prisma';
import { AgentService } from './agent.service';
import { ConversationFlowMatcher } from './conversation-flow.matcher';
import { whatsappService, normalizeWhatsappText } from '../messaging/whatsapp.service';

const agent = new AgentService() as any;
const conversationFlows = new ConversationFlowMatcher();

test('accepts natural confirmation wording for a pending booking', () => {
  assert.equal(agent.isExplicitConfirmation("Let's do that"), true);
  assert.equal(agent.isExplicitConfirmation('Let us do that'), true);
  assert.equal(agent.isExplicitConfirmation('Yes, that works'), true);
  assert.equal(agent.isExplicitConfirmation('Wait, let me check'), false);
});

test('only applies confirmation after the assistant presented a proposal', () => {
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'I can move your session to Friday at 3:00 PM. Would you like me to confirm that change?'
  }]), true);
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'If that works for you, just reply “yes” and I’ll send the M-Pesa prompt.'
  }]), true);
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'What time on Sunday, September 11 would you like to schedule the session?'
  }]), false);
});

test('ignores duplicate yes replies after a payment prompt has already been sent', async () => {
  const originalFindUnique = prisma.bookingDraft.findUnique;
  (prisma.bookingDraft.findUnique as any) = async () => ({
    customerId: 'customer-123',
    service: 'THE ICON',
    step: 'payment_pending',
    date: '2026-09-19',
    time: '15:00'
  });

  try {
    const result = await agent.tryImmediateConfirmation('customer-123');
    assert.match(result || '', /already sent the M-Pesa.*prompt|already sent the M-Pesa/i);
  } finally {
    prisma.bookingDraft.findUnique = originalFindUnique;
  }
});

test('recognizes conversational package selections', () => {
  assert.equal(conversationFlows.isPackageSelection("Let's go with the standard package"), true);
  assert.equal(conversationFlows.isPackageSelection('I like the Executive then'), true);
  assert.equal(conversationFlows.isPackageSelection('What is included in Gold?'), false);
});

test('recognizes a time-only reschedule request and time response', () => {
  assert.equal(conversationFlows.isTimeOnlyRescheduleRequest('Can we reschedule the time kindly'), true);
  assert.equal(conversationFlows.parseTimeOnly('10am'), '10:00');
  assert.equal(conversationFlows.parseTimeOnly('12:30 pm'), '12:30');
  assert.equal(conversationFlows.parseTimeOnly('25pm'), null);
});

test('recognizes a time reply following a time-only reschedule prompt', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your session is currently on Saturday at 10:00 AM. What time would work better for you that day?'
  }];

  assert.equal(conversationFlows.isTimeOnlyRescheduleSelection('11am', history), true);
  assert.equal(conversationFlows.isTimeOnlyRescheduleSelection('next Tuesday', history), false);
});

test('does not repeat an invalid past-appointment menu', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your appointment has already passed. Would you like to reschedule or cancel it?'
  }];

  assert.equal(agent.isPastAppointmentFollowUp('Do number 2', history), true);
  assert.equal(agent.isPastAppointmentFollowUp('Say that again', history), true);
});

test('recognizes upcoming appointment start-time questions', () => {
  assert.equal(agent.shouldUseUpcomingAppointmentTimeReply('When does it start?'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentTimeReply('When does my session start?'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentTimeReply('What time is my appointment?'), true);
});

test('uses stored appointment duration for session detail replies', () => {
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('Any details about the shoot?'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('What time is my session?'), false);
  assert.equal(agent.formatBookingDuration(150), '2 hours 30 minutes');
  assert.equal(agent.formatBookingDuration(210), '3 hours 30 minutes');
});

test('routes a generic reschedule request before tool calling', () => {
  assert.equal(agent.shouldUseRescheduleRequestReply('Can I reschedule?'), true);
  assert.equal(agent.shouldUseRescheduleRequestReply('Can I reschedule the time kindly'), false);
  assert.equal(agent.shouldUseRescheduleRequestReply('Can I reschedule to 2026-09-28 at 10am?'), false);
});

test('stops a reschedule flow when the customer withdraws the request', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your session is within 72 hours, so rescheduling would forfeit your deposit. Would you still like to proceed?'
  }];

  assert.equal(agent.shouldUseRescheduleWithdrawalReply("Let's not reschedule then", history), true);
  assert.equal(agent.shouldUseRescheduleRequestReply("Let's not reschedule then"), true);
});

test('confirms the original booking after a withdrawal follow-up', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'We will keep your original session date and time, and your booking remains unchanged. Your deposit is still held for that session.'
  }];

  assert.equal(agent.shouldConfirmRescheduleWithdrawal('Sure?', history), true);
  assert.equal(agent.shouldConfirmRescheduleWithdrawal('What time is it?', history), false);
});

test('recognizes acknowledgements after completed actions', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your THE ICON session has been moved to Friday, September 25, 2026 at 1:00 PM.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('okay thank you', history), true);
  assert.equal(agent.isPostActionAcknowledgement('What time is it?', history), false);
});

test('distinguishes booking for a relative from a joint session', () => {
  assert.equal(agent.shouldClarifyBookingForSomeoneElse('I want to book a session for my sister'), true);
  assert.equal(agent.shouldUseMultiPersonBookingReply('I want to book a session for my sister'), false);
  assert.equal(agent.shouldClarifyBookingForSomeoneElse('I want to book a session with my sister'), false);
  assert.equal(agent.shouldUseMultiPersonBookingReply('I want to book a session with my sister'), true);
});

test('captures a named recipient after booking-for-someone clarification', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Is the session just for your sister, or would you both like to be photographed together?'
  }];

  assert.equal(agent.shouldCaptureRecipientName('Maryanne Nuduta', history), true);
  assert.equal(agent.shouldCaptureRecipientName('the cheapest one', history), false);
});

test('captures a recipient named before the clarification reply', () => {
  const history = [{
    role: 'user' as const,
    content: 'I wanted to book a session for my sister'
  }];

  assert.equal(agent.shouldCaptureRecipientName('Maryanne Nuduta', history), true);
});

test('does not guess what an ambiguous 10k deposit means', () => {
  assert.equal(agent.shouldClarifyAmbiguousDeposit('she wants the one with the 10 sh deposit in it'), true);
  assert.match(agent.getAmbiguousDepositReply(), /Do you mean a Ksh 10,000 deposit|add-on/i);
});

test('anchors numeric booking dates to the customer message', () => {
  assert.equal(
    agent.getAuthoritativeRequestedDate('27th at 9am', '2026-09-28', '2026-09-27'),
    '2026-09-27'
  );
  assert.equal(
    agent.getAuthoritativeRequestedDate('next Sunday at 9am', '2026-09-27', null),
    '2026-09-27'
  );
});

test('formats additions as plain WhatsApp text', () => {
  const reply = agent.getAdditionsReply();

  assert.doesNotMatch(reply, /\|.*\|/);
  assert.match(reply, /Extra edited photo: Ksh 1,000 each/);
  assert.match(reply, /Nothing has been added yet/);
});

test('recognizes an add-on selection without restarting booking', () => {
  const addon = agent.getSelectedAddon('okay i would want styles wig');

  assert.equal(addon?.sku, 'wig_hire');
  assert.match(agent.getAddonSelectionReply(addon), /Styled wig hire|Ksh 4,000|not the deposit/i);
});

test('routes previous add-on questions to booking history', () => {
  const history = [
    { role: 'assistant' as const, content: 'Here are the add-ons we can include with your session.' },
    { role: 'user' as const, content: 'Which one did I choose previously?' },
  ];

  assert.equal(agent.shouldUsePreviousAddonReply('Which one did I choose previously?', history), true);
  assert.equal(agent.shouldUsePreviousAddonReply('Which package should I choose?', history), false);
});

test('treats "show me" after the add-on clarification as a request for the priced list', () => {
  const history = [
    { role: 'assistant' as const, content: 'Which add-on would you like to add to your session? I can show you the available extras if you are not sure yet.' },
  ];

  assert.equal(agent.isAddonListFollowUp('Show me', history), true);
  assert.equal(agent.isAddonListFollowUp('Show me', [{ role: 'assistant' as const, content: 'Your session is confirmed.' }]), false);
  assert.equal(agent.isAddonListFollowUp('okay i would want styled wig', history), false);
  assert.equal(
    agent.isAddonListFollowUp('Show me', [{ role: 'assistant' as const, content: 'Here are the add\u2011ons we can include with your session:' }]),
    true
  );
});

test('add-on pricing injected into the prompt carries exact figures, never "varies"', () => {
  const line = agent.getAddonPricingLine();

  assert.match(line, /Fiesta House Power Suit: Ksh 10,000/);
  assert.match(line, /Suspending Concept: Ksh 7,000/);
  assert.match(line, /Goddess Sculpture Set: Ksh 15,000/);
  assert.doesNotMatch(line, /varies/i);
});

test('"show me all that are in my session today" asks for booking details, not intent clarification', () => {
  const message = 'show me all that are in my session the one to happen today';

  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply(message), true);
  assert.equal(agent.shouldClarifyMixedIntent(message), false);
  assert.equal(agent.shouldClarifyMixedIntent('can I move my THE ICON booking invoice to next Tuesday'), true);
});

test('clarifies a new add-on request without invoking the model', () => {
  const history = [
    { role: 'assistant' as const, content: 'Which add-on would you like to add to your session?' },
  ];

  assert.equal(agent.shouldClarifyNewAddon('Okay so I want to add a new one on September 25th', history), true);
  assert.equal(agent.shouldClarifyNewAddon('I want to book a new session', history), false);
});

test('enforces the 72-hour reschedule cutoff', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');

  assert.equal(agent.isRescheduleWithin72Hours(new Date('2026-09-24T18:00:00.000Z'), now), true);
  assert.equal(agent.isRescheduleWithin72Hours(new Date('2026-09-27T12:00:00.000Z'), now), false);
  assert.equal(agent.isRescheduleWithin72Hours(new Date('2026-09-23T18:00:00.000Z'), now), false);
  assert.match(agent.getReschedulePolicyMessage(), /within 72 hours|forfeit your deposit/i);
});

test('retries transient WhatsApp delivery failures and normalizes special whitespace', async () => {
  const originalPost = axios.post;
  const calls: any[] = [];

  (axios.post as any) = async (...args: any[]) => {
    calls.push(args[1]);
    const [url, payload] = args;
    if (calls.length === 1) {
      const error = new Error('Service temporarily unavailable');
      (error as any).response = { data: { error: { code: 2, message: 'Service temporarily unavailable' } } };
      (error as any).isAxiosError = true;
      throw error;
    }

    return { data: { messages: [{ id: 'wamid-123' }] } };
  };

  try {
    const result = await whatsappService.sendMessage('254721840961', 'Hello\u202Fthere\u200B');
    assert.equal(result.messages[0].id, 'wamid-123');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].text.body, 'Hello there');
    assert.equal(calls[1].text.body, 'Hello there');
    assert.equal(normalizeWhatsappText('Ksh\u202F35,000'), 'Ksh 35,000');
  } finally {
    axios.post = originalPost;
  }
});

test('routes invoice requests to stored PDF delivery instead of a fabricated invoice text reply', () => {
  assert.equal(agent.shouldUseInvoiceRequestReply('Could you send me the invoice?'), true);
  assert.equal(agent.shouldUseInvoiceRequestReply('What packages do you offer?'), false);
  assert.equal(agent.extractInvoiceNumber('Could you send me invoice INV-2026-005?'), 'INV-2026-005');
});

test('handles ambiguous budget and repeated-package wording before the booking flow gets confused', () => {
  assert.equal(agent.shouldUsePackageBudgetReply('I want the cheapest one'), true);
  assert.equal(agent.shouldUsePackageBudgetReply('same as last time'), true);
  assert.equal(agent.shouldUsePackageBudgetReply('what do you offer?'), false);
  assert.match(agent.getPackageBudgetReply(), /THE BLOOM|THE ICON|cheapest/i);
});

test('forces a clarification when one message bundles multiple intents', () => {
  assert.equal(agent.shouldClarifyMixedIntent('I want the cheapest package for next Tuesday and send me my invoice'), true);
  assert.equal(agent.shouldClarifyMixedIntent('Could you send me the invoice?'), false);
  assert.match(agent.getMixedIntentClarificationReply(), /invoice|package|date|which/i);
});

test('elevates high-signal session details into structured note metadata', () => {
  const metadata = agent.extractSessionNoteMetadata(
    'Please add a styled wig hire, bring my husband and my mother, and I use a wheelchair.'
  );

  assert.equal(metadata.category, 'addon');
  assert.equal(metadata.priority, 'high');
  assert.equal(metadata.normalizedType, 'special_request');
  assert.deepEqual(metadata.tags, ['addon', 'companion', 'accessibility', 'styling']);
  assert.deepEqual(metadata.details.addOns, ['Styled wig hire']);
  assert.deepEqual(metadata.details.companions, ['husband', 'mother']);
  assert.deepEqual(metadata.details.accessibilityNeeds, ['wheelchair']);
});

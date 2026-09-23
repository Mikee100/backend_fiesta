import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { AgentService } from './agent.service';
import { ConversationFlowMatcher } from './conversation-flow.matcher';

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

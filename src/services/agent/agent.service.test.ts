import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { bookingAddonService } from '../booking/booking-addon.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { AgentService, BookingExtractor } from './agent.service';
import { ConversationFlowMatcher } from './conversation-flow.matcher';
import { whatsappService, normalizeWhatsappText } from '../messaging/whatsapp.service';

const agent = new AgentService() as any;
const conversationFlows = new ConversationFlowMatcher();

test('keeps all policy identifiers while omitting unrelated price tables', () => {
  const fullPrompt = agent.getInstructionGuide();
  const compactPrompt = agent.getSystemPrompt('', 'whatsapp', false, false);
  const pricingPrompt = agent.getSystemPrompt('', 'whatsapp', true, false);

  assert.equal((fullPrompt.match(/(?:^|\n)[A-D]\d+[a-z]?\./g) || []).length, 29);
  assert.match(fullPrompt, /THE BLOOM: Ksh 15,000/);
  assert.equal(fullPrompt.includes(agent.getAddonPricingLine()), true);
  assert.match(fullPrompt, /Sus[p]?ending Concept|Sculpture Set|Concierge Services for Travelling Mothers/);
  assert.equal(compactPrompt.includes('THE BLOOM: Ksh 15,000'), false);
  assert.equal(compactPrompt.includes(agent.getAddonPricingLine()), false);
  assert.match(pricingPrompt, /THE BLOOM: Ksh 15,000/);
  assert.equal(pricingPrompt.includes(agent.getAddonPricingLine()), false);
  assert.ok(compactPrompt.length < fullPrompt.length);
});

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

test('resolves package follow-ups from the previous assistant turn', () => {
  const history = [
    { role: 'assistant' as const, content: 'Would you like to book a session or chat about a package?' },
    { role: 'user' as const, content: 'tell me about them' },
    { role: 'assistant' as const, content: "I'm sorry, I couldn't process that." },
  ];

  assert.equal(conversationFlows.isPackageCatalogRequest('tell me about them', history), true);
  assert.equal(conversationFlows.isPackageCatalogRequest('tell me about them', []), false);

  const packageListHistory = [{
    role: 'assistant' as const,
    content: 'Here are all the current Fiesta House packages: THE BLOOM, THE MUSE, THE ICON, THE LEGEND, THE QUEEN, THE EMPRESS, and THE GODDESS.'
  }];
  assert.equal(conversationFlows.isPackageInclusionFollowUp('so what does each come with', packageListHistory), true);
  assert.equal(conversationFlows.isPackageCatalogRequest('so what does each come with', packageListHistory), true);
  assert.equal(conversationFlows.isPackageInclusionFollowUp('what does each come with', []), false);
});

test('omits tool schemas for ordinary informational turns', () => {
  assert.equal(agent.shouldExposeTools('What time do you open?', [], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('How much is THE ICON?', [], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('Please reschedule my booking to Saturday at 2pm', [], 'whatsapp'), true);
  assert.equal(agent.shouldResolvePackageSelectionImmediately('I want THE ICON'), true);
  assert.equal(agent.shouldResolvePackageSelectionImmediately('I want THE ICON next Saturday around 10'), false);
  assert.equal(agent.messageContainsExplicitDateSignal('I want THE ICON next Saturday around 10'), true);
  assert.equal(agent.messageContainsExplicitDateTimeSignal('I want THE ICON next Saturday around 10'), false);
  assert.equal(agent.shouldExposeTools('I want THE ICON next Saturday at 10 AM', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('I want THE ICON next Saturday at 10 AM', [], 'instagram'), false);
  assert.equal(agent.shouldExposeTools('How much is the deposit?', [], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('Does my husband have to pay extra?', [{
    role: 'assistant', content: 'What time would work for you?'
  }], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('10 AM', [{
    role: 'assistant', content: 'What time would work for you?'
  }], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('3rd at 2pm?', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('3rd?', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('Saturday?', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('2pm?', [], 'whatsapp'), true);
});

test('skips the extractor completion for normal package selections', async () => {
  const extractor = new BookingExtractor() as any;
  extractor.aiExtract = async () => {
    throw new Error('The extractor model call should not run');
  };

  const result = await extractor.extract('I want THE ICON package');
  assert.equal(result.usage.completionCalls, 0);
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
  assert.equal(agent.shouldUseLastAppointmentDetailsReply('Tell me about my last session'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('Tell me about my last session'), false);
  assert.equal(agent.formatBookingDuration(150), '2 hours 30 minutes');
  assert.equal(agent.formatBookingDuration(210), '3 hours 30 minutes');
});

test('answers upcoming session details naturally and acknowledges repeat questions', async () => {
  const originalBookingFindFirst = prisma.booking.findFirst;
  const originalPaymentFindFirst = prisma.payment.findFirst;
  (prisma.booking.findFirst as any) = async () => ({
    id: 'upcoming-booking',
    service: 'THE ICON',
    dateTime: new Date('2026-09-27T07:00:00.000Z'),
    durationMinutes: 150,
    recipientName: 'Maryanne',
    customer: { name: 'Njerii' },
    bookingAddons: [
      { name: 'Extra outfit beyond package', quantity: 1 },
      { name: 'Styled wig hire', quantity: 1 },
    ],
  });
  (prisma.payment.findFirst as any) = async () => ({ amount: 10 });

  try {
    const reply = await agent.getUpcomingAppointmentDetailsReply('customer-123');
    assert.match(reply || '', /Your THE ICON session is on Sunday, 27 September 2026 at 10:00 AM for Maryanne/);
    assert.match(reply || '', /It runs for 2 hours 30 minutes at our Parklands studio/);
    assert.match(reply || '', /saved extras are Extra outfit beyond package and Styled wig hire/);
    assert.match(reply || '', /confirmed, and your deposit has been paid/);

    const repeatReply = await agent.getUpcomingAppointmentDetailsReply('customer-123', [
      { role: 'user', content: 'Tell me the details of tomorrow’s session' },
      { role: 'assistant', content: reply || '' },
    ]);
    assert.match(repeatReply || '', /^It’s the same session we just discussed:/);
    assert.match(repeatReply || '', /THE ICON.*Sunday, 27 September 2026 at 10:00 AM/);
  } finally {
    prisma.booking.findFirst = originalBookingFindFirst;
    prisma.payment.findFirst = originalPaymentFindFirst;
  }
});

test('does not mistake a general booking-process question for personal session details', () => {
  const question = 'what is the booking process of the studio';

  assert.equal(agent.shouldUseBookingProcessReply(question), true);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply(question), false);
});

test('answers last-session questions from the most recent past booking', async () => {
  const originalFindFirst = prisma.booking.findFirst;
  (prisma.booking.findFirst as any) = async () => ({
    service: 'THE ICON',
    dateTime: new Date('2026-08-10T07:00:00.000Z'),
    durationMinutes: 150,
    recipientName: 'Maryanne',
    bookingAddons: [{ name: 'Styled wig hire', quantity: 1 }],
  });

  try {
    const reply = await agent.getLastAppointmentDetailsReply('customer-123');
    assert.match(reply, /most recent past booking.*THE ICON/i);
    assert.match(reply, /\nDate: .*\nDuration: 2 hours 30 minutes\nBooked for: Maryanne/);
    assert.match(reply, /Add-ons recorded:\n- Styled wig hire/);
    assert.match(reply, /Does that sound like the session you mean/);
    assert.doesNotMatch(reply, /upcoming session is on/);
  } finally {
    prisma.booking.findFirst = originalFindFirst;
  }
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

test('returns reschedule confirmation without waiting for Google Calendar', { timeout: 1000 }, async () => {
  const originals = {
    bookingDraftFindUnique: prisma.bookingDraft.findUnique,
    bookingFindUnique: prisma.booking.findUnique,
    bookingUpdate: prisma.booking.update,
    bookingDraftDelete: prisma.bookingDraft.delete,
    updateCalendarEvent: googleCalendarService.updateEvent,
    notifyRescheduleAdmin: agent.notifyRescheduleAdmin,
  };
  let bookingUpdated = false;
  let draftCleared = false;
  (prisma.bookingDraft.findUnique as any) = async () => ({
    step: 'reschedule_confirm',
    bookingId: 'booking-123',
    date: '2026-10-04',
    time: '15:00',
    dateTimeIso: '2026-10-04T15:00:00',
  });
  (prisma.booking.findUnique as any) = async () => ({
    id: 'booking-123',
    service: 'THE ICON',
    dateTime: new Date('2026-10-03T11:00:00.000Z'),
    googleEventId: 'calendar-event-123',
    customer: { name: 'Joan' },
  });
  (prisma.booking.update as any) = async () => {
    bookingUpdated = true;
    return {};
  };
  (prisma.bookingDraft.delete as any) = async () => {
    draftCleared = true;
    return {};
  };
  (googleCalendarService.updateEvent as any) = () => new Promise(() => {});
  agent.notifyRescheduleAdmin = () => new Promise(() => {});

  try {
    const reply = await agent.tryImmediateConfirmation('customer-123');

    assert.match(reply, /session has been moved/i);
    assert.equal(bookingUpdated, true);
    assert.equal(draftCleared, true);
  } finally {
    prisma.bookingDraft.findUnique = originals.bookingDraftFindUnique;
    prisma.booking.findUnique = originals.bookingFindUnique;
    prisma.booking.update = originals.bookingUpdate;
    prisma.bookingDraft.delete = originals.bookingDraftDelete;
    googleCalendarService.updateEvent = originals.updateCalendarEvent;
    agent.notifyRescheduleAdmin = originals.notifyRescheduleAdmin;
  }
});

test('recognizes acknowledgements after completed actions', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your THE ICON session has been moved to Friday, September 25, 2026 at 1:00 PM.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('okay thank you', history), true);
  assert.equal(agent.isPostActionAcknowledgement('What time is it?', history), false);
});

test('recognizes acknowledgements after appointment reminders', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Hi Njerii, your THE ICON session is tomorrow at 10:00 AM. Please arrive about 30 minutes early so there is time to get settled and ready.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('okay thank you', history), true);
  assert.equal(agent.isPostActionAcknowledgement('Which package is best?', history), false);
});

test('treats polite thanks as an acknowledgement, not booking confirmation', () => {
  const pendingProposal = [{
    role: 'assistant' as const,
    content: 'If that works for you, reply yes and I will send the M-Pesa prompt.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('Perfect, thanks.', pendingProposal), true);
  assert.equal(agent.isPostActionAcknowledgement('Okay, thank you', pendingProposal), true);
  assert.equal(agent.isPostActionAcknowledgement('okay', pendingProposal), false);
  assert.equal(agent.isPostActionAcknowledgement('Got it', []), true);
});

test('distinguishes booking for a relative from a joint session', () => {
  assert.equal(agent.shouldClarifyBookingForSomeoneElse('I want to book a session for my sister'), true);
  assert.equal(agent.shouldUseMultiPersonBookingReply('I want to book a session for my sister'), false);
  assert.equal(agent.shouldClarifyBookingForSomeoneElse('I want to book a session with my sister'), false);
  assert.equal(agent.shouldUseMultiPersonBookingReply('I want to book a session with my sister'), true);
});

test('handles studio policies without relying on the AI provider', () => {
  assert.match(agent.getStudioPolicyReply('Do you have late night sessions?') || '', /9 AM to 7 PM/i);
  assert.match(agent.getStudioPolicyReply('Can my partner join the maternity shoot?') || '', /welcome/i);
  assert.match(agent.getStudioPolicyReply('Can I do a semi-nude maternity session?') || '', /professionalism and privacy/i);
});

test('keeps partner fee follow-ups in conversational context instead of forcing a template', () => {
  const question = 'Does my husband have to pay extra?';
  assert.equal(agent.getScopeBoundaryReply(question), null);
  assert.equal(agent.shouldClarifyMixedIntent(question), false);
  assert.equal(agent.shouldUseMultiPersonBookingReply(question), false);
});

test('keeps reproductive-health questions outside the studio assistant scope', () => {
  assert.match(agent.getOutOfScopeReply('How do I know my fertile window?') || '', /qualified professional/i);
  assert.match(agent.getOutOfScopeReply('How do I know when I am ovulating?') || '', /qualified professional/i);
  assert.match(agent.getOutOfScopeReply('Can I fuck my best friend for good seeds?') || '', /qualified professional/i);
  assert.match(agent.getOutOfScopeReply('Can you talk dirty to me?') || '', /keep things professional/i);
  assert.equal(agent.getOutOfScopeReply('Can I book a maternity session when I am pregnant?'), null);
});

test('redirects unrelated questions while allowing Fiesta House requests', () => {
  assert.match(agent.getScopeBoundaryReply('What is the capital of France?') || '', /Fiesta House studio assistant/i);
  assert.match(agent.getScopeBoundaryReply('Who is the president of Kenya?') || '', /Fiesta House studio assistant/i);
  assert.match(agent.getScopeBoundaryReply('Tell me a joke') || '', /shoots and bookings/i);
  assert.match(agent.getScopeBoundaryReply('Do I need a girlfriend?') || '', /Fiesta House studio assistant/i);
  assert.match(agent.getScopeBoundaryReply('Should I take out a loan?') || '', /qualified professional/i);
  assert.match(agent.getScopeBoundaryReply('Okay thanks... do I need a girlfriend?') || '', /Fiesta House studio assistant/i);
  assert.equal(agent.getScopeBoundaryReply('Tell me about the business'), null);
  assert.equal(agent.getScopeBoundaryReply('Where is it located at?'), null);
  assert.equal(agent.getScopeBoundaryReply('What does it look like there?'), null);
  assert.equal(agent.getScopeBoundaryReply('What about Saturday?', [{
    role: 'assistant',
    content: 'Fiesta House offers maternity sessions. Which date would you prefer for your booking?'
  }]), null);
  assert.equal(agent.getScopeBoundaryReply('What should I wear for my maternity shoot?'), null);
  assert.equal(agent.getScopeBoundaryReply('Can my partner be in the photos?'), null);
});

test('returns the out-of-scope reply before invoking the AI pipeline', async () => {
  const originalRunAgent = agent.runAgent;
  agent.runAgent = async () => {
    throw new Error('The AI pipeline should not be called');
  };

  try {
    const reply = await agent.handleMessage('customer-123', 'How do I know whether an egg is viable for fertilization?');
    assert.match(reply, /qualified professional/i);
  } finally {
    agent.runAgent = originalRunAgent;
  }
});

test('returns the unrelated-topic redirect before invoking the AI pipeline', async () => {
  const originalRunAgent = agent.runAgent;
  agent.runAgent = async () => {
    throw new Error('The AI pipeline should not be called');
  };

  try {
    const reply = await agent.handleMessage('customer-123', 'Tell me a joke');
    assert.match(reply, /Fiesta House studio assistant/i);
  } finally {
    agent.runAgent = originalRunAgent;
  }
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
  const extractedDate = dayjs().add(1, 'month').startOf('month').date(27);
  assert.equal(
    agent.getAuthoritativeRequestedDate(
      '27th at 9am',
      extractedDate.add(1, 'day').format('YYYY-MM-DD'),
      extractedDate.format('YYYY-MM-DD')
    ),
    extractedDate.format('YYYY-MM-DD')
  );
});

test('keeps a time-only booking reply on the previously offered weekday', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'We have a full slate of slots on Sunday. Which time works best?'
  }];
  const sundayDate = agent.getAuthoritativeRequestedDate('2pm', '2026-10-03', null, history);

  assert.equal(dayjs(sundayDate).day(), 0);
});

test('uses the exact date when the offered weekday context includes it', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Available slots for THE ICON on Sunday, 2026-10-04: 2:00 PM.'
  }];

  assert.equal(
    agent.getAuthoritativeRequestedDate('2pm', '2026-10-03', null, history),
    '2026-10-04'
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
  assert.equal(agent.getSelectedAddon('add an extra professional make-up for me as an add on')?.sku, 'extra_makeup');
  assert.equal(agent.getSelectedAddon('lets include the suspenind concep')?.sku, 'suspending_concept');
});

test('persists the common Suspending Concept misspelling as its priced add-on', async () => {
  const originalFindFirst = prisma.bookingAddon.findFirst;
  const originalCreate = prisma.bookingAddon.create;
  let createdAddon: any;
  (prisma.bookingAddon.findFirst as any) = async () => null;
  (prisma.bookingAddon.create as any) = async ({ data }: any) => {
    createdAddon = data;
    return data;
  };

  try {
    const createdCount = await bookingAddonService.createFromNote({
      customerId: 'customer-123',
      bookingId: 'booking-123',
      note: 'lets include the suspenind concep',
    });

    assert.equal(createdCount, 1);
    assert.equal(createdAddon.sku, 'suspending_concept');
    assert.equal(createdAddon.name, 'Suspending Concept');
    assert.equal(createdAddon.unitPrice, 7000);
    assert.equal(createdAddon.totalPrice, 7000);
  } finally {
    prisma.bookingAddon.findFirst = originalFindFirst;
    prisma.bookingAddon.create = originalCreate;
  }
});

test('links to the dedicated Suspending Concept gallery after a contextual visual question', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'The Suspending Concept is a dreamy, ethereal add-on.'
  }];
  const reply = agent.getSuspendingConceptGalleryReply('Where can I see this idea?', history);

  assert.match(reply, /https:\/\/www\.fiestahousematernity\.com\/gallery\/suspending-concept/);
  assert.equal(agent.getSuspendingConceptGalleryReply('Where can I see this idea?', []), null);
  assert.equal(agent.getSuspendingConceptGalleryReply('Show me the packages', history), null);
  assert.match(
    agent.getSuspendingConceptGalleryReply('Show me some pictures', history),
    /https:\/\/www\.fiestahousematernity\.com\/gallery\/suspending-concept/
  );
});

test('links review and testimonial page requests to the reviews page', () => {
  const reply = agent.getReviewPageReply('Is there a reviews page I can see these?');

  assert.match(reply, /https:\/\/www\.fiestahousematernity\.com\/reviews/);
  assert.equal(agent.getReviewPageReply('What do clients say about the studio?'), null);
});

test('sanitizes unverified Fiesta House URLs in model replies', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'The Suspending Concept is one of our add-ons.'
  }];

  assert.match(
    agent.formatCustomerReply('See our testimonials: https://www.fiestahousematernity.com/testimonials'),
    /https:\/\/www\.fiestahousematernity\.com\/reviews/
  );
  assert.match(
    agent.formatCustomerReply('View it here: https://www.fiestahousematernity.com/gallery', 'Where can I see this?', history),
    /https:\/\/www\.fiestahousematernity\.com\/gallery\/suspending-concept/
  );
  assert.match(
    agent.formatCustomerReply('See this page: https://www.fiestahousematernity.com/fake-page'),
    /https:\/\/www\.fiestahousematernity\.com\/$/
  );
});

test('resolves an affirmative reply to a single offered paid add-on', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Professional makeup is included in your THE ICON package. If you’d like an extra makeup touch-up or a second set of looks, we can add that for Ksh 3,500. Just let me know!'
  }];
  const addon = agent.getSelectedAddon('yess thats what i want', history);

  assert.equal(addon?.sku, 'extra_makeup');
  assert.match(agent.getAddonSelectionReply(addon), /Extra professional makeup.*Ksh 3,500/);
});

test('does not infer a specific add-on from a general list or vague affirmation', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Here are the add-ons we offer: extra makeup, styled wig hire, or extra edited photos. Let me know if any interest you.'
  }];

  assert.equal(agent.getSelectedAddon('yes', history), null);
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
  assert.equal(agent.shouldClarifyMixedIntent('Give me the invoice for the 25th sep session'), false);
  assert.deepEqual(
    agent.extractInvoiceSessionDateRange('Give me the invoice for the 25th sep session'),
    { start: new Date('2026-09-24T21:00:00.000Z'), end: new Date('2026-09-25T21:00:00.000Z') }
  );
});

test('routes a not-received invoice follow-up to stored invoice delivery', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your updated invoice has just been sent to your WhatsApp.'
  }];

  assert.equal(agent.shouldUseInvoiceRequestReply('I have not received it..send it to me', history), true);
  assert.equal(agent.shouldUseInvoiceRequestReply('I have not received it..send it to me', []), false);
});

test('refreshes an existing invoice with newly selected priced add-ons', async () => {
  const originals = {
    bookingFindUnique: prisma.booking.findUnique,
    invoiceFindUnique: prisma.invoice.findUnique,
    packageFindFirst: prisma.package.findFirst,
    paymentFindMany: prisma.payment.findMany,
    invoiceUpdate: prisma.invoice.update,
    sumForBooking: bookingAddonService.sumForBooking,
    markInvoiced: bookingAddonService.markInvoiced,
    generatePdf: invoiceService.generatePdf,
  };
  const existingInvoice = {
    id: 'invoice-1',
    invoiceNumber: 'INV-2026-006',
    status: 'sent',
    sentAt: new Date('2026-09-30T17:00:00.000Z'),
    paidAt: null,
    tax: 0,
    discount: 0,
    createdAt: new Date('2026-09-30T16:00:00.000Z'),
  };
  let updateData: any;
  let pdfInput: any;

  (prisma.booking.findUnique as any) = async () => ({
    id: 'booking-1',
    customerId: 'customer-1',
    service: 'THE ICON',
    dateTime: new Date('2026-10-03T11:00:00.000Z'),
    customer: { name: 'Joan', phone: '254700000000' },
  });
  (prisma.invoice.findUnique as any) = async () => existingInvoice;
  (prisma.package.findFirst as any) = async () => ({ price: 35000 });
  (prisma.payment.findMany as any) = async () => [{ amount: 10, mpesaReceipt: 'TEST-RECEIPT' }];
  (prisma.invoice.update as any) = async ({ data }: any) => {
    updateData = data;
    return { ...existingInvoice, ...data, booking: { service: 'THE ICON', dateTime: new Date('2026-10-03T11:00:00.000Z') } };
  };
  (bookingAddonService.sumForBooking as any) = async () => ({
    addonsTotal: 3500,
    lineItems: [{ name: 'Extra professional makeup', quantity: 1, unitPrice: 3500, totalPrice: 3500 }],
  });
  (bookingAddonService.markInvoiced as any) = async () => {};
  (invoiceService.generatePdf as any) = async (data: any) => {
    pdfInput = data;
    return Buffer.from('refreshed-pdf');
  };

  try {
    const invoice = await invoiceService.createOrRefreshForBooking('booking-1');

    assert.ok(invoice);
    assert.equal(invoice.invoiceNumber, 'INV-2026-006');
    assert.equal(updateData.total, 38500);
    assert.equal(updateData.depositPaid, 10);
    assert.equal(updateData.balanceDue, 38490);
    assert.equal(updateData.status, 'sent');
    assert.deepEqual(pdfInput.addonLines, [{
      name: 'Extra professional makeup', quantity: 1, unitPrice: 3500, totalPrice: 3500,
    }]);
    assert.equal(updateData.pdfData.toString(), 'refreshed-pdf');
  } finally {
    prisma.booking.findUnique = originals.bookingFindUnique;
    prisma.invoice.findUnique = originals.invoiceFindUnique;
    prisma.package.findFirst = originals.packageFindFirst;
    prisma.payment.findMany = originals.paymentFindMany;
    prisma.invoice.update = originals.invoiceUpdate;
    bookingAddonService.sumForBooking = originals.sumForBooking;
    bookingAddonService.markInvoiced = originals.markInvoiced;
    invoiceService.generatePdf = originals.generatePdf;
  }
});

test('sends the invoice for the past session discussed immediately before the request', async () => {
  const originalBookingFindFirst = prisma.booking.findFirst;
  const originalInvoiceFindUnique = prisma.invoice.findUnique;
  const originalInvoiceFindFirst = prisma.invoice.findFirst;
  const originalInvoiceUpdate = prisma.invoice.update;
  const originalRefreshInvoice = invoiceService.createOrRefreshForBooking;
  const originalAddonSum = bookingAddonService.sumForBooking;
  const originalSendDocument = whatsappService.sendDocument;
  let sentFileName = '';
  let searchedForLatestInvoice = false;

  (prisma.booking.findFirst as any) = async () => ({ id: 'past-booking' });
  (prisma.invoice.findUnique as any) = async ({ where }: any) => {
    assert.equal(where.bookingId, 'past-booking');
    return {
      id: 'past-invoice',
      invoiceNumber: 'INV-PAST',
      bookingId: 'past-booking',
      total: 35000,
      depositPaid: 2000,
      balanceDue: 33000,
      pdfData: Buffer.from('pdf'),
      booking: { service: 'THE ICON', dateTime: new Date('2026-08-10T07:00:00.000Z') },
    };
  };
  (prisma.invoice.findFirst as any) = async () => {
    searchedForLatestInvoice = true;
    return null;
  };
  (prisma.invoice.update as any) = async () => ({});
  (invoiceService.createOrRefreshForBooking as any) = async () => ({
    id: 'past-invoice',
    invoiceNumber: 'INV-PAST',
    bookingId: 'past-booking',
    total: 35000,
    depositPaid: 2000,
    balanceDue: 33000,
    pdfData: Buffer.from('pdf'),
    booking: { service: 'THE ICON', dateTime: new Date('2026-08-10T07:00:00.000Z') },
  });
  (bookingAddonService.sumForBooking as any) = async () => ({ addonsTotal: 0, lineItems: [] });
  (whatsappService.sendDocument as any) = async (_customerId: string, _data: Buffer, fileName: string) => {
    sentFileName = fileName;
    return {};
  };

  try {
    const reply = await agent.sendStoredInvoiceToCustomer('customer-123', undefined, [{
      role: 'assistant',
      content: 'The most recent past booking I have on record is THE ICON.\nDate: Friday, 25 September 2026 at 1:00 PM',
    }]);

    assert.equal(reply, 'I’ve sent your invoice as a PDF to WhatsApp.');
    assert.equal(sentFileName, 'INV-PAST.pdf');
    assert.equal(searchedForLatestInvoice, false);
  } finally {
    prisma.booking.findFirst = originalBookingFindFirst;
    prisma.invoice.findUnique = originalInvoiceFindUnique;
    prisma.invoice.findFirst = originalInvoiceFindFirst;
    prisma.invoice.update = originalInvoiceUpdate;
    invoiceService.createOrRefreshForBooking = originalRefreshInvoice;
    bookingAddonService.sumForBooking = originalAddonSum;
    whatsappService.sendDocument = originalSendDocument;
  }
});

test('selects the invoice for an explicitly dated session', async () => {
  const originalBookingFindFirst = prisma.booking.findFirst;
  const originalInvoiceFindUnique = prisma.invoice.findUnique;
  const originalInvoiceFindFirst = prisma.invoice.findFirst;
  const originalInvoiceUpdate = prisma.invoice.update;
  const originalRefreshInvoice = invoiceService.createOrRefreshForBooking;
  const originalAddonSum = bookingAddonService.sumForBooking;
  const originalSendDocument = whatsappService.sendDocument;
  let selectedBooking = '';
  let sentFileName = '';
  let sentSummary = '';

  (prisma.booking.findFirst as any) = async ({ where }: any) => {
    assert.equal(where.dateTime.gte.toISOString(), '2026-09-24T21:00:00.000Z');
    assert.equal(where.dateTime.lt.toISOString(), '2026-09-25T21:00:00.000Z');
    return { id: 'september-25-booking' };
  };
  (prisma.invoice.findUnique as any) = async ({ where }: any) => {
    selectedBooking = where.bookingId;
    return {
      id: 'september-25-invoice',
      invoiceNumber: 'INV-2026-004',
      total: 35000,
      depositPaid: 2000,
      balanceDue: 33000,
      pdfData: Buffer.from('pdf'),
      booking: { service: 'THE ICON', dateTime: new Date('2026-09-25T10:00:00.000Z') },
    };
  };
  (prisma.invoice.findFirst as any) = async () => null;
  (prisma.invoice.update as any) = async () => ({});
  (invoiceService.createOrRefreshForBooking as any) = async () => ({
    id: 'september-25-invoice',
    invoiceNumber: 'INV-2026-004',
    bookingId: 'september-25-booking',
    total: 38500,
    depositPaid: 10,
    balanceDue: 38490,
    pdfData: Buffer.from('refreshed-pdf'),
    booking: { service: 'THE ICON', dateTime: new Date('2026-09-25T10:00:00.000Z') },
  });
  (bookingAddonService.sumForBooking as any) = async () => ({
    addonsTotal: 3500,
    lineItems: [{ name: 'Extra professional makeup', quantity: 1, unitPrice: 3500, totalPrice: 3500 }],
  });
  (whatsappService.sendDocument as any) = async (_customerId: string, _data: Buffer, fileName: string, summary: string) => {
    sentFileName = fileName;
    sentSummary = summary;
    return {};
  };

  try {
    const reply = await agent.sendStoredInvoiceToCustomer(
      'customer-123',
      undefined,
      [],
      'Give me the invoice for the 25th sep session'
    );

    assert.equal(selectedBooking, 'september-25-booking');
    assert.equal(sentFileName, 'INV-2026-004.pdf');
    assert.match(sentSummary, /Add-ons:\nExtra professional makeup: KSh 3,500/);
    assert.match(sentSummary, /Total: KSh 38,500/);
    assert.match(sentSummary, /Balance Due: KSh 38,490/);
    assert.equal(reply, 'I’ve sent your invoice as a PDF to WhatsApp.');
  } finally {
    prisma.booking.findFirst = originalBookingFindFirst;
    prisma.invoice.findUnique = originalInvoiceFindUnique;
    prisma.invoice.findFirst = originalInvoiceFindFirst;
    prisma.invoice.update = originalInvoiceUpdate;
    invoiceService.createOrRefreshForBooking = originalRefreshInvoice;
    bookingAddonService.sumForBooking = originalAddonSum;
    whatsappService.sendDocument = originalSendDocument;
  }
});

test('handles ambiguous budget and repeated-package wording before the booking flow gets confused', () => {
  assert.equal(agent.shouldUsePackageBudgetReply('I want the cheapest one'), true);
  assert.equal(agent.shouldUsePackageBudgetReply('same as last time'), true);
  assert.equal(agent.shouldUsePackageBudgetReply('what do you offer?'), false);
  assert.match(agent.getPackageBudgetReply(), /THE BLOOM|THE ICON|cheapest/i);
});

test('renders package cards without corrupted markers or markdown', () => {
  const card = agent.buildPackageCard({
    name: 'THE ICON',
    price: 35000,
    duration: '2.5 hours',
    images: 15,
    makeup: true,
    outfits: 4,
    photobook: false,
    photobookSize: null,
    mount: true,
    balloonBackdrop: false,
    wig: false,
    notes: null,
  });

  assert.match(card, /THE ICON - Ksh 35,000/);
  assert.match(card, /Session length: 2\.5 hours/);
  assert.match(card, /15 final edited photos/);
  assert.match(card, /4 studio outfits with styling/);
  assert.match(card, /1 A3 fine art mount/);
  assert.doesNotMatch(card, /[âðï�]|\*|â€¢/);
});

test('answers package-inclusion follow-ups from stored package facts', async () => {
  const originalFindMany = prisma.package.findMany;
  (prisma.package.findMany as any) = async () => [
    {
      name: 'THE BLOOM', price: 15000, duration: '1.5 hours', images: 6, makeup: true, outfits: 2,
      photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false, notes: null,
    },
    {
      name: 'THE ICON', price: 35000, duration: '2.5 hours', images: 15, makeup: true, outfits: 4,
      photobook: false, photobookSize: null, mount: true, balloonBackdrop: false, wig: false, notes: null,
    },
  ];

  try {
    const reply = await agent.getPackageCatalogReply(true);
    assert.match(reply || '', /Here is what each package includes/);
    assert.match(reply || '', /THE BLOOM - Ksh 15,000[\s\S]*Session length: 1\.5 hours[\s\S]*6 final edited photos/);
    assert.match(reply || '', /THE ICON - Ksh 35,000[\s\S]*15 final edited photos[\s\S]*1 A3 fine art mount/);
    assert.doesNotMatch(reply || '', /THE BLOOM[\s\S]*?- 5 hours|THE BLOOM[\s\S]*?25 final edited photos/);
  } finally {
    prisma.package.findMany = originalFindMany;
  }
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

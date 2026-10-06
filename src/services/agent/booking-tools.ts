import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { mpesaService } from '../payment/mpesa.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION, MINIMUM_BOOKING_DEPOSIT, PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { notifyAdmin } from '../notifications/notification.service';
import { businessDay, bookingDateFacts, inBusinessTimezone } from '../../utils/time';
import { getBookingPolicyWindow } from '../../utils/booking-policy';
import dayjs from 'dayjs';
import { PAYMENT_ATTEMPTS_EXHAUSTED, PAYMENT_PROMPT_UNRECORDED, RESCHEDULE_COLLECTING_STEP } from './constants';
import { isUsableName, sanitizeSlotValue } from './slot-memory';
import { draftVersion, MAX_PAYMENT_ATTEMPTS } from './payment-recovery';

export async function executeProposeBookingTool(this: any, customerId: string, name: string, service: string, date: string) {
  name = sanitizeSlotValue(name || '');
  if (!isUsableName(name) || !/[a-z]/i.test(name)) {
    throw new Error('Customer name is required before proposing a booking. Ask the customer for their full name first.');
  }

  let customer = await prisma.customer.findUnique({ where: { id: customerId } });
  const existingDraft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!existingDraft?.isForSomeoneElse && customer?.name.toLowerCase().startsWith(`${name.toLowerCase()} `)) {
    name = sanitizeSlotValue(customer.name);
  }
  if (!customer) {
    customer = await prisma.customer.create({ data: { id: customerId, name } });
  } else if (customer.name !== name && !existingDraft?.isForSomeoneElse) {
    await prisma.customer.update({ where: { id: customerId }, data: { name } });
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => service.toLowerCase().includes(key));
  if (!serviceKey) {
    throw new Error(`"${service}" isn't one of our packages. Valid packages are: ${Object.keys(SERVICE_DURATIONS).join(', ')}. Ask the customer to pick one of these before booking.`);
  }

  const requestedSlot = date.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
  if (!requestedSlot) {
    throw new Error('The requested date and time are invalid. Ask the customer to provide a date and time, then check availability.');
  }
  const requestedDate = requestedSlot[1];
  const hour = Number(requestedSlot[2]);
  const minute = Number(requestedSlot[3]);
  const requestedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (hour > 23 || minute > 59) {
    throw new Error('The requested time is invalid. Ask the customer to choose a valid time.');
  }

  // Explicit past-date guard. bookingDateFacts returns { isPast } but does NOT
  // throw for past dates, so getAvailableSlots must never be reached for one -
  // it would return an empty slot list and produce a confusing "time unavailable"
  // error instead of a clear rejection.
  const dateFacts = bookingDateFacts(requestedDate);
  if (dateFacts.isPast) {
    throw new Error(`${requestedDate} is in the past. Ask the customer to choose a future date.`);
  }

  const slotsResult: any = await bookingService.getAvailableSlots(
    requestedDate,
    SERVICE_DURATIONS[serviceKey],
    undefined,
    existingDraft?.id
  );
  if (slotsResult?.status === 'closed') {
    throw new Error(`The studio is closed on ${requestedDate}. Ask the customer to select another date.`);
  }
  const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
  if (!availableSlots.includes(requestedTime)) {
    throw new Error(`That time is unavailable on ${requestedDate}. Available times are: ${availableSlots.join(', ') || 'none'}. Ask the customer to choose an available time.`);
  }

  const dateTimeIso = businessDay(requestedDate)
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0)
    .toISOString();

  const depositAmount = this.getDepositForPackage(await this.getPackageForDeposit(service));

  await bookingDraftService.saveBookingProposal({
    customerId: customer.id,
    service,
    dateTime: dateTimeIso,
    customerName: name,
  });

  return { depositAmount };
}

export async function executeConfirmBookingTool(
  this: any,
  customerId: string,
  initialDraftStep: string | undefined,
  expectedDeposit: number | null
) {
  if (initialDraftStep !== 'awaiting_confirmation') {
    throw new Error('No pending booking proposal from a prior message. Call propose_booking first and wait for the customer to explicitly confirm on their own next message before calling confirm_booking.');
  }

  const draft = await bookingDraftService.get(customerId);
  if (!draft || draft.step !== 'awaiting_confirmation') {
    throw new Error('No pending booking proposal found. Call propose_booking first.');
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => draft.service?.toLowerCase().includes(key));
  if (!serviceKey) {
    throw new Error(`The pending booking's package "${draft.service || 'unknown'}" isn't recognised, so the deposit can't be worked out. Do not start payment; ask the studio team to check the package.`);
  }
  if (!draft.date || !draft.time) {
    throw new Error('The pending booking is missing its date or time. Ask the customer to start the booking again.');
  }
  const slotsResult: any = await bookingService.getAvailableSlots(
    draft.date,
    SERVICE_DURATIONS[serviceKey],
    undefined,
    draft.id
  );
  if (slotsResult?.status === 'closed') {
    throw new Error(`The studio is closed on ${draft.date}. Do not start payment for this booking.`);
  }
  const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
  if (!availableSlots.includes(draft.time)) {
    throw new Error(`The proposed time ${draft.time} on ${draft.date} is no longer available. Do not start payment; ask the customer to choose another time.`);
  }

  const depositAmount = this.getDepositForPackage(await this.getPackageForDeposit(draft.service || ''));
  if (expectedDeposit === null || expectedDeposit !== depositAmount) {
    throw new Error('The package deposit no longer matches the amount in the customer-visible proposal. Do not start payment; prepare a new proposal and ask for confirmation again.');
  }
  if (draftVersion(draft) - 1 >= MAX_PAYMENT_ATTEMPTS) {
    throw Object.assign(new Error('The M-Pesa prompt limit for this booking has been reached. Do not send another prompt; the studio team will follow up.'), { code: PAYMENT_ATTEMPTS_EXHAUSTED });
  }

  await bookingDraftService.markPaymentPending(customerId, draft.version);

  let mpesaResponse: any;
  try {
    mpesaResponse = await mpesaService.initiateStkPush(customerId, depositAmount, draft.id);
  } catch (error: any) {
    console.error('Failed to initiate M-Pesa STK Push:', error);
    await prisma.bookingDraft.update({
      where: { customerId },
      data: { step: 'awaiting_confirmation', ...(Number.isInteger(draft.version) ? { version: draft.version } : {}) },
    }).catch((restoreError) => console.error('Failed to restore booking draft after STK push failure:', restoreError));
    throw new Error(`We couldn't initiate the payment request. Error: ${error.message}`);
  }

  try {
    await prisma.payment.upsert({
      where: { bookingDraftId: draft.id },
      update: {
        amount: depositAmount,
        status: 'pending',
        checkoutRequestId: mpesaResponse.CheckoutRequestID,
        updatedAt: new Date()
      },
      create: {
        bookingDraftId: draft.id,
        amount: depositAmount,
        phone: customerId,
        status: 'pending',
        checkoutRequestId: mpesaResponse.CheckoutRequestID
      }
    });

    return {
      success: true,
      draftId: draft.id,
      depositAmount,
      service: draft.service,
      date: draft.date,
      time: draft.time,
      checkoutRequestId: mpesaResponse.CheckoutRequestID
    };
  } catch (error: any) {
    console.error('Failed to record M-Pesa payment after STK Push:', error);
    throw Object.assign(
      new Error(`An M-Pesa prompt may already have been sent to the customer's phone, but it could not be recorded (${error.message}). Do not send another prompt; ask the customer to check their phone first.`),
      { code: PAYMENT_PROMPT_UNRECORDED }
    );
  }
}

export async function getPackageForDeposit(packageName?: string): Promise<{ name: string; deposit: number | null } | null> {
  if (!packageName) {
    return prisma.package.findFirst({
      where: { name: { in: [...PACKAGE_NAMES_FOR_EXTRACTION] } },
      orderBy: { deposit: 'asc' },
      select: { name: true, deposit: true },
    });
  }

  const normalizedName = packageName.trim().toLowerCase().replace(/\s+(?:package|edition)$/i, '');
  const canonicalName = PACKAGE_NAMES_FOR_EXTRACTION.find((name) => {
    const normalizedPackageName = name.toLowerCase();
    return normalizedPackageName === normalizedName
      || normalizedPackageName.replace(/^the\s+/, '') === normalizedName;
  }) || packageName.trim();
  return prisma.package.findUnique({
    where: { name: canonicalName },
    select: { name: true, deposit: true },
  });
}

export function getDepositForPackage(pkg: { name: string; deposit: number | null } | null | undefined): number {
  if (!pkg) {
    throw new Error('No package deposit is configured. Ask the studio team to confirm the amount.');
  }

  const isProductionMpesa = (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase() === 'production';
  // Local-only testing override; ignored in production and under the node test runner.
  const localOverride = Number(process.env.LOCAL_DEPOSIT_OVERRIDE);
  const depositAmount: unknown = !isProductionMpesa && process.env.NODE_ENV !== 'production' && !process.env.NODE_TEST_CONTEXT
    && Number.isInteger(localOverride) && localOverride > 0
    ? localOverride
    : pkg.deposit;
  if (typeof depositAmount !== 'number' || !Number.isInteger(depositAmount) || depositAmount < 1) {
    throw new Error(`The configured deposit for ${pkg.name} is missing or invalid. Do not quote or initiate payment; ask the studio team to correct package pricing.`);
  }
  if (isProductionMpesa && depositAmount < MINIMUM_BOOKING_DEPOSIT) {
    throw new Error(`The configured booking deposit is below the KSh ${MINIMUM_BOOKING_DEPOSIT.toLocaleString()} minimum. Do not initiate payment; ask the studio team to correct package pricing.`);
  }
  return depositAmount;
}

export async function executeProposeRescheduleTool(this: any, customerId: string, newDate: string, newTime: string) {
  const existingDraft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (existingDraft && existingDraft.step !== 'reschedule_confirm' && existingDraft.step !== RESCHEDULE_COLLECTING_STEP) {
    throw new Error('I have not changed your current request or started a reschedule. Please finish that step or ask the studio team to help.');
  }
  const upcomingBooking = await prisma.booking.findFirst({
    where: { customerId, status: 'confirmed', dateTime: { gte: new Date() },
      ...(existingDraft?.bookingId ? { id: existingDraft.bookingId } : {}) },
    orderBy: { dateTime: 'asc' }
  });

  if (!upcomingBooking) {
    throw new Error('No upcoming confirmed booking found to reschedule.');
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => upcomingBooking.service.toLowerCase().includes(key));
  const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
  const slotsResult: any = await bookingService.getAvailableSlots(newDate, duration, upcomingBooking.id);
  const newDateLabel = `${dayjs(newDate).format('dddd, MMMM D, YYYY')} (${newDate})`;

  if (slotsResult.status === 'closed') {
    throw new Error(`We're closed on ${newDateLabel} (${slotsResult.reason}). Ask the customer to pick a different date. Always refer to the date using this exact weekday.`);
  }
  const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
  if (!availableSlots.includes(newTime)) {
    throw new Error(`${newTime} on ${newDateLabel} isn't available. Available times that day: ${availableSlots.length > 0 ? availableSlots.join(', ') : 'none'}. Ask the customer to pick one of these instead. Always refer to the date using this exact weekday - do not guess it.`);
  }

  const [hour, minute] = newTime.split(':').map(Number);
  const newDateTimeIso = businessDay(newDate)
    .startOf('day')
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0)
    .toISOString();

  await prisma.bookingDraft.upsert({
    where: { customerId },
    update: {
      bookingId: upcomingBooking.id,
      service: upcomingBooking.service,
      date: newDate,
      time: newTime,
      dateTimeIso: newDateTimeIso,
      step: 'reschedule_confirm'
    },
    create: {
      customerId,
      bookingId: upcomingBooking.id,
      service: upcomingBooking.service,
      date: newDate,
      time: newTime,
      dateTimeIso: newDateTimeIso,
      step: 'reschedule_confirm'
    }
  });

  return {
    service: upcomingBooking.service,
    oldDateTime: upcomingBooking.dateTime,
  };
}

export async function executeConfirmRescheduleTool(this: any, customerId: string, initialDraftStep: string | undefined) {
  if (initialDraftStep !== 'reschedule_confirm') {
    throw new Error('No pending reschedule proposal from a prior message. Call propose_reschedule first and wait for the customer to explicitly confirm on their own next message.');
  }

  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.step !== 'reschedule_confirm' || !draft.bookingId || !draft.dateTimeIso) {
    throw new Error('No pending reschedule proposal found. Call propose_reschedule first.');
  }

  const upcomingBooking = await prisma.booking.findUnique({
    where: { id: draft.bookingId },
    include: { customer: true }
  });
  if (!upcomingBooking) {
    throw new Error('The booking being rescheduled no longer exists.');
  }

  const newDateTime = new Date(draft.dateTimeIso);
  await prisma.booking.update({
    where: { id: upcomingBooking.id },
    data: { dateTime: newDateTime }
  });

  if (upcomingBooking.googleEventId) {
    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => upcomingBooking.service.toLowerCase().includes(key));
    const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;

    void googleCalendarService.updateEvent(upcomingBooking.googleEventId, {
      service: upcomingBooking.service,
      dateTime: newDateTime,
      customerName: upcomingBooking.customer.name,
      durationMinutes: duration
    }).then((updated) => {
      if (!updated) {
        void this.notifyRescheduleAdmin({
          customerId,
          event: 'failed',
          service: upcomingBooking.service,
          newDate: draft.date || undefined,
          newTime: draft.time || undefined,
          reason: 'The booking was rescheduled, but Google Calendar did not update.',
        });
      }
    }).catch((error: unknown) => {
      console.error('Google Calendar reschedule sync failed:', error);
    });
  }

  await prisma.bookingDraft.deleteMany({
    where: { id: draft.id, customerId, step: 'reschedule_confirm', bookingId: upcomingBooking.id },
  }).catch((err: unknown) => console.error('Failed to clear reschedule draft:', err));

  // Same invoice number; only the PDF session date and totals are regenerated.
  void invoiceService.createOrRefreshForBooking(upcomingBooking.id)
    .catch((err: unknown) => console.error('Failed to refresh invoice after reschedule:', err));

  return {
    newDateTime,
    oldDateTime: upcomingBooking.dateTime,
    service: upcomingBooking.service,
    depositForfeited: this.isRescheduleWithin72Hours(upcomingBooking.dateTime),
  };
}

export async function executeConfirmCancellationTool(this: any, customerId: string, initialDraftStep: string | undefined) {
  if (initialDraftStep !== 'cancel_confirm') {
    throw new Error('No pending cancellation proposal from a prior message. Ask which booking to cancel, propose it, and wait for the customer to explicitly confirm on their own next message.');
  }

  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.step !== 'cancel_confirm' || !draft.bookingId || !draft.date) {
    throw new Error('No pending cancellation proposal found. Ask which booking to cancel and propose it first.');
  }
  if (this.isCancellationProposalExpired(draft)) {
    await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
    throw new Error('The cancellation proposal expired. Nothing was cancelled; ask the customer to make a new cancellation request.');
  }

  return this.executeCancelBookingTool(customerId, draft.date, draft.bookingId);
}

export function getCancellationCompletionReply(result: {
  service: string;
  dateTime: Date;
  refundEligible: boolean;
  depositPaid?: boolean;
}): string {
  const session = `${result.service} on ${inBusinessTimezone(result.dateTime).format('dddd, D MMMM YYYY [at] h:mm A')}`;
  if (result.refundEligible) {
    const refundStatus = result.depositPaid
      ? 'A successful deposit is recorded. The studio team has been notified to review any refund; no refund has been issued.'
      : 'This is eligibility under the timing policy only; it does not confirm a refund amount or that money has been returned.';
    return `Your ${session} has been cancelled. It was eligible under the more-than-72-hours refund policy. ${refundStatus}`;
  }

  const refundStatus = result.depositPaid
    ? 'A successful deposit is recorded. The studio team has been notified to review the payment; no refund has been issued.'
    : 'It is not automatically refundable under the timing policy.';
  return `Your ${session} has been cancelled. It was 72 hours away or less. ${refundStatus}`;
}

export async function executeCancelBookingTool(this: any, customerId: string, date?: string, bookingId?: string) {
  const upcoming = await prisma.booking.findMany({
    where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
    orderBy: { dateTime: 'asc' }
  });

  if (upcoming.length === 0) {
    throw new Error('No upcoming booking found to cancel.');
  }

  const describe = (booking: { service: string; dateTime: Date }) =>
    `${booking.service} on ${inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD h:mm A')}`;
  const requestedDate = date?.trim();
  const matches = bookingId
    ? upcoming.filter((booking) => booking.id === bookingId)
    : requestedDate
      ? upcoming.filter((booking) => inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD') === requestedDate)
      : upcoming;

  if (matches.length === 0) {
    throw new Error(`No upcoming booking on ${requestedDate}. Upcoming bookings: ${upcoming.map(describe).join('; ')}. Ask the customer which one to cancel.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple upcoming bookings match: ${matches.map(describe).join('; ')}. Nothing was cancelled - ask the customer which one to cancel, then call cancel_booking with that date.`);
  }

  const booking = matches[0];
  const successfulPayment = await prisma.payment.findFirst({
    where: { bookingId: booking.id, status: 'success' },
    orderBy: { updatedAt: 'desc' },
    select: { amount: true, mpesaReceipt: true },
  });
  let calendarEventRemoved = !booking.googleEventId;
  if (booking.googleEventId) {
    calendarEventRemoved = await googleCalendarService.deleteEvent(booking.googleEventId);
    if (!calendarEventRemoved) {
      console.warn('Google Calendar delete failed during cancellation:', booking.googleEventId);
    }
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: 'cancelled',
      ...(calendarEventRemoved ? { googleEventId: null } : {}),
    }
  });
  await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm', bookingId: booking.id } });

  const refundEligible = getBookingPolicyWindow(booking.dateTime).cancellationRefundEligible;
  await notifyAdmin(
    'booking',
    `Booking cancelled for ${customerId}`,
    `${booking.service} on ${dayjs(booking.dateTime).format('YYYY-MM-DD HH:mm')} was cancelled via AI assistant. ${successfulPayment ? `A successful deposit of KSh ${successfulPayment.amount.toLocaleString()} is recorded${successfulPayment.mpesaReceipt ? ` (M-Pesa receipt ${successfulPayment.mpesaReceipt})` : ''}. Studio team: manual refund review is required; no refund was issued by the assistant.` : 'No successful deposit is recorded.'}`,
    {
      customerId,
      event: 'cancel_confirmed',
      bookingId: booking.id,
      service: booking.service,
      dateTime: booking.dateTime.toISOString(),
      refundEligible,
      successfulDepositRecorded: Boolean(successfulPayment),
      depositAmount: successfulPayment?.amount,
      mpesaReceipt: successfulPayment?.mpesaReceipt,
      manualRefundReviewRequired: Boolean(successfulPayment),
      refundReviewOwner: successfulPayment ? 'studio_team' : undefined,
    }
  );

  return {
    bookingId: booking.id,
    service: booking.service,
    dateTime: booking.dateTime,
    refundEligible,
    depositPaid: Boolean(successfulPayment),
  };
}
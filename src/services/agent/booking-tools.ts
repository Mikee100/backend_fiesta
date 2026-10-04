import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { mpesaService } from '../payment/mpesa.service';
import { SERVICE_DURATIONS, MINIMUM_BOOKING_DEPOSIT, PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { businessDay } from '../../utils/time';
import { PAYMENT_PROMPT_UNRECORDED } from './constants';

export async function executeProposeBookingTool(this: any, customerId: string, name: string, service: string, date: string) {
  if (!name || name.trim() === '' || name.trim().toLowerCase() === 'unknown') {
    throw new Error('Customer name is required before proposing a booking. Ask the customer for their full name first.');
  }

  let customer = await prisma.customer.findUnique({ where: { id: customerId } });
  const existingDraft = await prisma.bookingDraft.findUnique({ where: { customerId } });
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

  await bookingDraftService.markPaymentPending(customerId);

  let mpesaResponse: any;
  try {
    mpesaResponse = await mpesaService.initiateStkPush(customerId, depositAmount, draft.id);
  } catch (error: any) {
    console.error('Failed to initiate M-Pesa STK Push:', error);
    await prisma.bookingDraft.update({
      where: { customerId },
      data: { step: 'awaiting_confirmation' },
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

  const depositAmount: unknown = pkg.deposit;
  const isProductionMpesa = (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase() === 'production';
  if (typeof depositAmount !== 'number' || !Number.isInteger(depositAmount) || depositAmount < 1) {
    throw new Error(`The configured deposit for ${pkg.name} is missing or invalid. Do not quote or initiate payment; ask the studio team to correct package pricing.`);
  }
  if (isProductionMpesa && depositAmount < MINIMUM_BOOKING_DEPOSIT) {
    throw new Error(`The configured booking deposit is below the KSh ${MINIMUM_BOOKING_DEPOSIT.toLocaleString()} minimum. Do not initiate payment; ask the studio team to correct package pricing.`);
  }
  return depositAmount;
}
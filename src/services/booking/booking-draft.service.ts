import prisma from '../../config/prisma';
import { inBusinessTimezone } from '../../utils/time';

export class BookingDraftService {
  async saveBookingProposal(input: {
    customerId: string;
    service: string;
    dateTime: string;
    customerName: string;
  }) {
    const dateTime = inBusinessTimezone(input.dateTime);
    const date = dateTime.format('YYYY-MM-DD');
    const time = dateTime.format('HH:mm');
    const existing = await prisma.bookingDraft.findUnique({ where: { customerId: input.customerId }, select: { service: true, date: true, time: true } });
    // A different edition or slot is a new proposal, so the M-Pesa prompt count starts again.
    const newProposal = !existing || existing.service !== input.service || existing.date !== date || existing.time !== time;
    return prisma.bookingDraft.upsert({
      where: { customerId: input.customerId },
      update: {
        service: input.service,
        date,
        time,
        dateTimeIso: input.dateTime,
        name: input.customerName,
        step: 'awaiting_confirmation',
        ...(newProposal ? { version: 1 } : {}),
      },
      create: {
        customerId: input.customerId,
        service: input.service,
        date,
        time,
        dateTimeIso: input.dateTime,
        name: input.customerName,
        step: 'awaiting_confirmation',
      },
    });
  }

  async get(customerId: string) {
    return prisma.bookingDraft.findUnique({ where: { customerId } });
  }

  /** Claims the draft for one STK push; a concurrent duplicate confirmation fails the version check. */
  async markPaymentPending(customerId: string, version?: number) {
    const versioned = Number.isInteger(version);
    try {
      return await prisma.bookingDraft.update({
        where: { customerId, step: 'awaiting_confirmation', ...(versioned ? { version } : {}) },
        data: { step: 'payment_pending', ...(versioned ? { version: Number(version) + 1 } : {}) },
      });
    } catch (error: any) {
      if (error?.code === 'P2025') throw Object.assign(new Error('A payment prompt is already being sent for this booking.'), { code: 'PAYMENT_ALREADY_PENDING' });
      throw error;
    }
  }
}

export const bookingDraftService = new BookingDraftService();

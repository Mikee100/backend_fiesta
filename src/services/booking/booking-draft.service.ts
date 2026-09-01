import dayjs from 'dayjs';
import prisma from '../../config/prisma';

export class BookingDraftService {
  async saveBookingProposal(input: {
    customerId: string;
    service: string;
    dateTime: string;
    customerName: string;
  }) {
    const dateTime = dayjs(input.dateTime);
    return prisma.bookingDraft.upsert({
      where: { customerId: input.customerId },
      update: {
        service: input.service,
        date: dateTime.format('YYYY-MM-DD'),
        time: dateTime.format('HH:mm'),
        dateTimeIso: input.dateTime,
        name: input.customerName,
        step: 'awaiting_confirmation',
      },
      create: {
        customerId: input.customerId,
        service: input.service,
        date: dateTime.format('YYYY-MM-DD'),
        time: dateTime.format('HH:mm'),
        dateTimeIso: input.dateTime,
        name: input.customerName,
        step: 'awaiting_confirmation',
      },
    });
  }

  async get(customerId: string) {
    return prisma.bookingDraft.findUnique({ where: { customerId } });
  }

  async markPaymentPending(customerId: string) {
    return prisma.bookingDraft.update({
      where: { customerId },
      data: { step: 'payment_pending' },
    });
  }
}

export const bookingDraftService = new BookingDraftService();

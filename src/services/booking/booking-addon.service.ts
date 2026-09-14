import { ADDON_CATALOG } from '../../config/constants';
import prisma from '../../config/prisma';

function parseQuantity(note: string, fallback = 1): number {
  const patterns = [
    /(\d+)\s*x\b/i,
    /\bx\s*(\d+)\b/i,
    /(\d+)\s+(?:extra|photos?|outfits?|wigs?)/i,
  ];
  for (const pattern of patterns) {
    const match = note.match(pattern);
    if (match?.[1]) {
      const qty = Number(match[1]);
      if (Number.isFinite(qty) && qty > 0 && qty <= 50) return qty;
    }
  }
  return fallback;
}

export class BookingAddonService {
  /**
   * Detect priced add-ons mentioned in a free-text note and persist them
   * as BookingAddon line items linked to the customer (and booking when known).
   */
  async createFromNote(params: {
    customerId: string;
    bookingId?: string | null;
    note: string;
    sessionNoteId?: string;
  }): Promise<number> {
    const { customerId, bookingId, note, sessionNoteId } = params;
    const matches = ADDON_CATALOG.filter((item) => item.match.test(note));
    if (matches.length === 0) return 0;

    let created = 0;
    for (const item of matches) {
      const quantity = item.quantityFromNote ? parseQuantity(note, 1) : 1;
      const unitPrice = item.unitPrice;
      const totalPrice = unitPrice * quantity;

      const existing = await prisma.bookingAddon.findFirst({
        where: {
          customerId,
          sku: item.sku,
          status: { in: ['pending', 'confirmed'] },
          ...(bookingId
            ? { bookingId }
            : { bookingId: null, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
        },
      });
      if (existing) continue;

      await prisma.bookingAddon.create({
        data: {
          customerId,
          bookingId: bookingId || undefined,
          name: item.name,
          sku: item.sku,
          quantity,
          unitPrice,
          totalPrice,
          status: 'pending',
          note,
          sessionNoteId,
        },
      });
      created += 1;
    }
    return created;
  }

  /** Attach orphan pending add-ons for a customer onto a newly confirmed booking. */
  async attachPendingToBooking(customerId: string, bookingId: string): Promise<number> {
    const result = await prisma.bookingAddon.updateMany({
      where: {
        customerId,
        bookingId: null,
        status: 'pending',
      },
      data: {
        bookingId,
        status: 'confirmed',
      },
    });

    if (bookingId) {
      await prisma.bookingAddon.updateMany({
        where: { bookingId, status: 'pending' },
        data: { status: 'confirmed' },
      });
    }

    return result.count;
  }

  async sumForBooking(bookingId: string): Promise<{
    addonsTotal: number;
    lineItems: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
  }> {
    const addons = await prisma.bookingAddon.findMany({
      where: {
        bookingId,
        status: { in: ['pending', 'confirmed', 'invoiced'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    const lineItems = addons.map((a) => ({
      name: a.quantity > 1 ? `${a.name} × ${a.quantity}` : a.name,
      quantity: a.quantity,
      unitPrice: a.unitPrice,
      totalPrice: a.totalPrice,
    }));

    const addonsTotal = addons.reduce((sum, a) => sum + a.totalPrice, 0);
    return { addonsTotal, lineItems };
  }

  async markInvoiced(bookingId: string): Promise<void> {
    await prisma.bookingAddon.updateMany({
      where: { bookingId, status: { in: ['pending', 'confirmed'] } },
      data: { status: 'invoiced' },
    });
  }
}

export const bookingAddonService = new BookingAddonService();

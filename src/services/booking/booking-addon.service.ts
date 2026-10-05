import { ADDON_CATALOG, BOOKING_SLOT_RETENTION_MS } from '../../config/constants';
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
  private async getBookingAddonScope(bookingId: string) {
    const sessionNotes = await prisma.customerSessionNote.findMany({
      where: { bookingId },
      select: { id: true },
    });

    return {
      OR: [
        { bookingId },
        ...(sessionNotes.length > 0
          ? [{ sessionNoteId: { in: sessionNotes.map((note) => note.id) } }]
          : []),
      ],
    };
  }

  /**
   * Detect priced add-ons mentioned in a free-text note and persist them
   * as BookingAddon line items linked to the customer (and booking when known).
  * Unlinked rows are temporary customer-scoped storage, not draft-bound storage.
  * Confirmation attaches only rows inside BOOKING_SLOT_RETENTION_MS (14 days).
   */
  async createFromNote(params: {
    customerId: string;
    bookingId?: string | null;
    note: string;
    sessionNoteId?: string;
    incrementExistingSkus?: readonly string[];
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
      if (existing) {
        if (!params.incrementExistingSkus?.includes(item.sku)) continue;
        if (existing.unitPrice !== unitPrice || existing.quantity + quantity > 50) {
          throw new Error('Existing add-on price or quantity requires studio review.');
        }
        await prisma.bookingAddon.update({
          where: { id: existing.id },
          data: {
            quantity: { increment: quantity }, totalPrice: { increment: totalPrice },
            ...(sessionNoteId ? { sessionNoteId } : {}),
          },
        });
        created++;
        continue;
      }

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

  /** Temporary 14-day orphan attachment; no draft identity until 8.1b. Excluded rows stay pending. */
  async attachPendingToBooking(customerId: string, bookingId: string): Promise<number> {
    const result = await prisma.bookingAddon.updateMany({
      where: {
        customerId,
        bookingId: null,
        status: 'pending',
        createdAt: { gt: new Date(Date.now() - BOOKING_SLOT_RETENTION_MS), lte: new Date() },
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
    const bookingAddonScope = await this.getBookingAddonScope(bookingId);
    const addons = await prisma.bookingAddon.findMany({
      where: {
        ...bookingAddonScope,
        status: { in: ['pending', 'confirmed', 'invoiced'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    const pricedAddons = addons.filter((addon) => addon.unitPrice > 0);
    const lineItems = pricedAddons.map((a) => ({
      name: a.quantity > 1 ? `${a.name} × ${a.quantity}` : a.name,
      quantity: a.quantity,
      unitPrice: a.unitPrice,
      totalPrice: a.totalPrice,
    }));

    const addonsTotal = pricedAddons.reduce((sum, a) => sum + a.totalPrice, 0);
    return { addonsTotal, lineItems };
  }

  async markInvoiced(bookingId: string): Promise<void> {
    const bookingAddonScope = await this.getBookingAddonScope(bookingId);
    await prisma.bookingAddon.updateMany({
      where: { ...bookingAddonScope, status: { in: ['pending', 'confirmed'] }, unitPrice: { gt: 0 } },
      data: { status: 'invoiced' },
    });
  }
}

export const bookingAddonService = new BookingAddonService();

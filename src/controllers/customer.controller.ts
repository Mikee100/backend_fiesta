import { Request, Response } from 'express';
import prisma from '../config/prisma';

export class CustomerController {
  private getActivityWindows() {
    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    const endOfYesterday = new Date(startOfToday.getTime() - 1);
    const onlineSince = new Date(now.getTime() - 5 * 60 * 1000);

    return { now, startOfToday, startOfYesterday, endOfYesterday, onlineSince };
  }

  private inRange(date: Date, start: Date, end: Date) {
    return date >= start && date <= end;
  }
  
  /**
   * Get all customers
   */
  async getCustomers(req: Request, res: Response) {
    try {
      const segment = String(req.query.segment || 'all').toLowerCase();
      const { now, startOfToday, startOfYesterday, endOfYesterday, onlineSince } = this.getActivityWindows();

      const customers = await prisma.customer.findMany({
        orderBy: { updatedAt: 'desc' },
        include: {
          messages: {
            select: { createdAt: true, content: true, direction: true, platform: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          _count: {
            select: { bookings: true, messages: true }
          }
        }
      });

      const enriched = customers.map((customer) => {
        const lastMessage = customer.messages[0];
        const lastActivityAt = lastMessage?.createdAt || customer.updatedAt;

        return {
          ...customer,
          lastActivityAt,
          lastMessagePreview: lastMessage?.content || null,
          lastMessageDirection: lastMessage?.direction || null,
          lastMessagePlatform: lastMessage?.platform || null,
        };
      });

      const filtered = enriched.filter((customer) => {
        const activity = new Date(customer.lastActivityAt);

        if (segment === 'online') return activity >= onlineSince && activity <= now;
        if (segment === 'today') return activity >= startOfToday && activity <= now;
        if (segment === 'yesterday') return this.inRange(activity, startOfYesterday, endOfYesterday);

        return true;
      });

      filtered.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
      return res.json(filtered);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Summary counters for customer activity dashboard segments.
   */
  async getActivitySummary(req: Request, res: Response) {
    try {
      const { now, startOfToday, startOfYesterday, endOfYesterday, onlineSince } = this.getActivityWindows();

      const [
        onlineRows,
        todayRows,
        yesterdayRows,
        newToday,
        pausedAi,
        totalCustomers,
      ] = await Promise.all([
        prisma.message.findMany({
          where: { createdAt: { gte: onlineSince, lte: now } },
          select: { customerId: true },
          distinct: ['customerId'],
        }),
        prisma.message.findMany({
          where: { createdAt: { gte: startOfToday, lte: now } },
          select: { customerId: true },
          distinct: ['customerId'],
        }),
        prisma.message.findMany({
          where: { createdAt: { gte: startOfYesterday, lte: endOfYesterday } },
          select: { customerId: true },
          distinct: ['customerId'],
        }),
        prisma.customer.count({ where: { createdAt: { gte: startOfToday, lte: now } } }),
        prisma.customer.count({ where: { OR: [{ aiEnabled: false }, { isAiPaused: true }] } }),
        prisma.customer.count(),
      ]);

      return res.json({
        onlineNow: onlineRows.length,
        activeToday: todayRows.length,
        activeYesterday: yesterdayRows.length,
        newToday,
        pausedAi,
        totalCustomers,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get single customer details
   */
  async getCustomer(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const customer = await prisma.customer.findUnique({
        where: { id },
        include: {
          bookings: { orderBy: { dateTime: 'desc' } },
          messages: { orderBy: { createdAt: 'desc' }, take: 50 },
          _count: {
            select: { bookings: true, messages: true }
          }
        }
      });
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      return res.json(customer);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get customer messages
   */
  async getMessages(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const messages = await prisma.message.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'asc' }
      });
      return res.json(messages);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get customer session notes
   */
  async getSessionNotes(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const notes = await prisma.customerSessionNote.findMany({
        where: { customerId: id },
        include: { booking: true },
        orderBy: { createdAt: 'desc' }
      });
      return res.json(notes);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Update session note status
   */
  async updateSessionNote(req: Request, res: Response) {
    try {
      const { noteId } = req.params;
      const { status, adminNotes, reviewedBy } = req.body;
      const note = await prisma.customerSessionNote.update({
        where: { id: noteId },
        data: {
          status,
          adminNotes,
          reviewedBy,
          reviewedAt: new Date()
        }
      });
      return res.json(note);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get this customer's own sentiment history (not business-wide stats)
   */
  async getSentiment(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const scores = await prisma.sentimentScore.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return res.json(scores);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Business-wide average messages/bookings per customer, so a single
   * customer's activity can be honestly compared against a real baseline
   * instead of arbitrary hardcoded thresholds.
   */
  async getAverageActivity(req: Request, res: Response) {
    try {
      const totalCustomers = await prisma.customer.count();
      if (totalCustomers === 0) {
        return res.json({ avgMessages: 0, avgBookings: 0 });
      }
      const [totalMessages, totalBookings] = await Promise.all([
        prisma.message.count(),
        prisma.booking.count(),
      ]);
      return res.json({
        avgMessages: totalMessages / totalCustomers,
        avgBookings: totalBookings / totalCustomers,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Toggle AI enabled/disabled for a customer
   */
  async toggleAi(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { enabled } = req.body;

      const customer = await prisma.customer.update({
        where: { id },
        data: { aiEnabled: enabled }
      });

      return res.json({ aiEnabled: customer.aiEnabled });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const customerController = new CustomerController();

import { Request, Response } from 'express';
import prisma from '../config/prisma';

export class CustomerController {
  
  /**
   * Get all customers
   */
  async getCustomers(req: Request, res: Response) {
    try {
      const customers = await prisma.customer.findMany({
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: {
            select: { bookings: true, messages: true }
          }
        }
      });
      return res.json(customers);
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

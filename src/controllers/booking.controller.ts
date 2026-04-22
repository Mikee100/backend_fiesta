import { Request, Response } from 'express';
import prisma from '../config/prisma';

export class BookingController {
  
  /**
   * List all bookings
   */
  async listBookings(req: Request, res: Response) {
    try {
      const bookings = await prisma.booking.findMany({
        include: {
          customer: true
        },
        orderBy: {
          dateTime: 'desc'
        }
      });
      return res.json({ bookings, total: bookings.length });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get available packages
   */
  async getPackages(req: Request, res: Response) {
    // For now, return hardcoded packages matching the knowledge base
    const packages = [
      { id: 'standard', name: 'Standard Package', price: 10000, duration: '1.5h' },
      { id: 'economy', name: 'Economy Package', price: 15000, duration: '2h' },
      { id: 'executive', name: 'Executive Package', price: 20000, duration: '2.5h' },
      { id: 'gold', name: 'Gold Package', price: 30000, duration: '2.5h' },
      { id: 'platinum', name: 'Platinum Package', price: 35000, duration: '2.5h' },
      { id: 'vip', name: 'VIP Package', price: 45000, duration: '3.5h' },
      { id: 'vvip', name: 'VVIP Package', price: 50000, duration: '3.5h' },
    ];
    return res.json(packages);
  }

  /**
   * Get available services
   */
  async getServices(req: Request, res: Response) {
    const services = [
      { name: 'Standard Package', duration: 90 },
      { name: 'Economy Package', duration: 120 },
      { name: 'Executive Package', duration: 150 },
      { name: 'Gold Package', duration: 150 },
      { name: 'Platinum Package', duration: 150 },
      { name: 'VIP Package', duration: 210 },
      { name: 'VVIP Package', duration: 210 },
    ];
    return res.json(services);
  }

  /**
   * Get available hours for a date
   */
  async getAvailableHours(req: Request, res: Response) {
    try {
      const { date } = req.params;
      const startOfDay = new Date(date);
      startOfDay.setHours(0,0,0,0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23,59,59,999);

      const existingBookings = await prisma.booking.findMany({
        where: {
          dateTime: {
            gte: startOfDay,
            lte: endOfDay
          },
          status: {
            not: 'cancelled'
          }
        }
      });

      // Generate slots from 9 AM to 5 PM
      const slots = [];
      for (let h = 9; h < 17; h++) {
        for (let m of [0, 30]) {
          const slotTime = new Date(date);
          slotTime.setHours(h, m, 0, 0);
          
          const isTaken = existingBookings.some(b => 
            new Date(b.dateTime).getHours() === h && 
            new Date(b.dateTime).getMinutes() === m
          );

          slots.push({
            time: slotTime.toISOString(),
            available: !isTaken
          });
        }
      }

      return res.json(slots);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Confirm booking
   */
  async confirmBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const booking = await prisma.booking.update({
        where: { id },
        data: { status: 'confirmed' }
      });
      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Cancel booking
   */
  async cancelBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const booking = await prisma.booking.update({
        where: { id },
        data: { status: 'cancelled' }
      });
      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const bookingController = new BookingController();

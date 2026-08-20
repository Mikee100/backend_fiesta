import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { googleCalendarService } from '../services/calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../config/constants';
import { notifyAdmin } from '../services/notifications/notification.service';
import dayjs from 'dayjs';

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
    try {
      const packages = await prisma.package.findMany({ orderBy: { price: 'asc' } });
      return res.json(packages);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  private pickPackageFields(body: any) {
    const {
      name, type, price, deposit, duration, images, makeup, outfits,
      styling, photobook, photobookSize, mount, balloonBackdrop, wig, notes
    } = body;
    return { name, type, price, deposit, duration, images, makeup, outfits, styling, photobook, photobookSize, mount, balloonBackdrop, wig, notes };
  }

  /**
   * Create a new package
   */
  async createPackage(req: Request, res: Response) {
    try {
      const pkg = await prisma.package.create({ data: this.pickPackageFields(req.body) });
      return res.status(201).json(pkg);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Update an existing package
   */
  async updatePackage(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const pkg = await prisma.package.update({ where: { id }, data: this.pickPackageFields(req.body) });
      return res.json(pkg);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Delete a package
   */
  async deletePackage(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await prisma.package.delete({ where: { id } });
      return res.status(204).send();
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
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
   * Update a booking's date/time and/or service - used by admins to manually
   * reschedule a booking (e.g. a customer called in directly instead of
   * messaging), rather than only through the WhatsApp AI flow.
   */
  async updateBooking(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const { dateTime, service } = req.body;

      const existing = await prisma.booking.findUnique({ where: { id }, include: { customer: true } });
      if (!existing) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const customerName = existing.customer.name;

      const newDateTime = dateTime ? new Date(dateTime) : existing.dateTime;
      const newService = service || existing.service;
      const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => newService.toLowerCase().includes(k)) || 'standard';
      const durationMinutes = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

      const booking = await prisma.booking.update({
        where: { id },
        data: { dateTime: newDateTime, service: newService, durationMinutes },
      });

      if (existing.googleEventId) {
        await googleCalendarService.updateEvent(existing.googleEventId, {
          service: newService,
          dateTime: newDateTime,
          customerName,
          durationMinutes,
        });
      }

      const dateChanged = newDateTime.getTime() !== new Date(existing.dateTime).getTime();
      const serviceChanged = newService !== existing.service;
      if (dateChanged || serviceChanged) {
        await notifyAdmin(
          'reschedule',
          `Manual reschedule: ${customerName}`,
          `${existing.service} moved from ${dayjs(existing.dateTime).format('YYYY-MM-DD HH:mm')} to ${dayjs(newDateTime).format('YYYY-MM-DD HH:mm')}${serviceChanged ? ` (service changed to ${newService})` : ''}.`,
          {
            event: 'manual_reschedule',
            bookingId: existing.id,
            customerId: existing.customerId,
            oldService: existing.service,
            newService,
            oldDateTime: existing.dateTime.toISOString(),
            newDateTime: newDateTime.toISOString(),
          }
        );
      }

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
      const existing = await prisma.booking.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      if (existing.googleEventId) {
        await googleCalendarService.deleteEvent(existing.googleEventId);
      }

      const booking = await prisma.booking.update({
        where: { id },
        data: {
          status: 'cancelled',
          googleEventId: null,
        }
      });

      const hoursUntil = dayjs(existing.dateTime).diff(dayjs(), 'hour', true);
      const refundEligible = hoursUntil > 72;
      await notifyAdmin(
        'booking',
        `Booking cancelled: ${existing.customerId}`,
        `${existing.service} on ${dayjs(existing.dateTime).format('YYYY-MM-DD HH:mm')} was cancelled.${refundEligible ? ' Refund eligible (>72h).' : ' Not automatically refundable (<=72h).'}`,
        {
          event: 'manual_cancel',
          bookingId: existing.id,
          customerId: existing.customerId,
          service: existing.service,
          dateTime: existing.dateTime.toISOString(),
          refundEligible,
        }
      );

      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const bookingController = new BookingController();

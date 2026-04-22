import prisma from '../config/prisma';
import { googleCalendarService } from '../services/calendar/calendar.service';

export class CalendarController {
  
  /**
   * Get calendar events (Confirmed bookings)
   */
  async getEvents(req: Request, res: Response) {
    try {
      const bookings = await prisma.booking.findMany({
        where: { status: 'confirmed' },
        include: { customer: true }
      });

      const events = bookings.map(b => ({
        id: b.id,
        title: `${b.service} - ${b.customer.name}`,
        start: b.dateTime,
        status: b.status
      }));

      return res.json(events);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Sync all unsynced confirmed bookings to Google Calendar
   */
  async sync(req: Request, res: Response) {
    try {
      const unsynced = await prisma.booking.findMany({
        where: {
          status: 'confirmed',
          googleEventId: null
        },
        include: { customer: true }
      });

      console.log(`Syncing ${unsynced.length} bookings to Google Calendar...`);

      const durations: Record<string, number> = {
        'standard': 90, 'economy': 120, 'executive': 150, 'gold': 150, 'platinum': 150, 'vip': 210, 'vvip': 210
      };

      for (const booking of unsynced) {
        const serviceKey = Object.keys(durations).find(k => booking.service.toLowerCase().includes(k)) || 'standard';
        const duration = durations[serviceKey];

        const googleEventId = await googleCalendarService.createEvent({
          service: booking.service,
          dateTime: booking.dateTime,
          customerName: booking.customer.name,
          durationMinutes: duration
        });

        if (googleEventId) {
          await prisma.booking.update({
            where: { id: booking.id },
            data: { googleEventId }
          });
        }
      }

      return res.json({ 
        success: true, 
        message: `Successfully synced ${unsynced.length} bookings to Google Calendar` 
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const calendarController = new CalendarController();

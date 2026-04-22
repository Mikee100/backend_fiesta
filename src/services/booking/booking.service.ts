import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { googleCalendarService } from '../calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../../config/constants';

export class BookingService {
  
  /**
   * Get available time slots for a specific date and duration
   */
  async getAvailableSlots(date: string, durationMinutes: number) {
    const startOfDay = dayjs(date).startOf('day');
    const endOfDay = dayjs(date).endOf('day');

    console.log(`Checking slots for ${date}, duration: ${durationMinutes} mins`);
    
    // 1. Fetch existing bookings from local DB
    const existingBookings = await prisma.booking.findMany({
      where: {
        dateTime: {
          gte: startOfDay.toDate(),
          lte: endOfDay.toDate()
        },
        status: {
          not: 'cancelled'
        }
      }
    });

    // 2. Fetch events from Google Calendar
    const googleEvents = await googleCalendarService.getEvents(startOfDay.toDate(), endOfDay.toDate());

    console.log(`Found ${existingBookings.length} local bookings and ${googleEvents.length} Google Calendar events for ${date}`);

    // 3. Check if it's a Monday
    if (dayjs(date).day() === 1) {
      console.log(`Date ${date} is a Monday. Returning closed status.`);
      return { status: 'closed', reason: 'Closed on Mondays' };
    }

    // Business Hours: 9 AM to 5 PM
    const businessStart = 9;
    const businessEnd = 17;
    
    const availableSlots: string[] = [];
    
    // Check every 30 minutes
    for (let hour = businessStart; hour < businessEnd; hour++) {
      for (let minute of [0, 30]) {
        const slotStart = dayjs(date).hour(hour).minute(minute).second(0).millisecond(0);
        const slotEnd = slotStart.add(durationMinutes, 'minute');

        // Check if this slot exceeds business hours
        if (slotEnd.hour() > businessEnd || (slotEnd.hour() === businessEnd && slotEnd.minute() > 0)) {
          continue;
        }

        // Check for overlap with local bookings
        const overlapsLocal = existingBookings.some(booking => {
          const bStart = dayjs(booking.dateTime);
          const bDuration = booking.durationMinutes || DEFAULT_DURATION;
          const bEnd = bStart.add(bDuration, 'minute');
          return slotStart.isBefore(bEnd) && slotEnd.isAfter(bStart);
        });

        if (overlapsLocal) continue;

        // Check for overlap with Google Calendar events
        const overlapsGoogle = googleEvents.some(event => {
          if (!event.start?.dateTime || !event.end?.dateTime) return false;
          const eStart = dayjs(event.start.dateTime);
          const eEnd = dayjs(event.end.dateTime);
          return slotStart.isBefore(eEnd) && slotEnd.isAfter(eStart);
        });

        if (!overlapsGoogle) {
          availableSlots.push(slotStart.format('HH:mm'));
        }
      }
    }

    console.log(`Returning ${availableSlots.length} available slots: ${availableSlots.join(', ')}`);
    return availableSlots;
  }
}

export const bookingService = new BookingService();

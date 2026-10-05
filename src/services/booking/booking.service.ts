import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { googleCalendarService } from '../calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../../config/constants';
import { businessDay, bookingDateFacts, nowInBusinessTimezone } from '../../utils/time';

type OccupiedWindow = { start: dayjs.Dayjs; end: dayjs.Dayjs };

export class BookingService {
  async getAvailableDates(fromDate: string, toDate: string, service: string) {
    const from = bookingDateFacts(fromDate);
    bookingDateFacts(toDate);
    const requestedStart = businessDay(fromDate);
    const end = businessDay(toDate);
    const requestedDays = end.diff(requestedStart, 'day') + 1;
    if (requestedDays < 1 || requestedDays > 14) throw new Error('Choose a date range of one to fourteen days.');
    const serviceKey = typeof service === 'string'
      ? Object.keys(SERVICE_DURATIONS).find((key) => service.toLowerCase().includes(key)) : undefined;
    if (!serviceKey) throw new Error('Choose a recognised package before checking available dates.');
    if (bookingDateFacts(toDate).isPast) {
      return { fromDate, toDate, service, status: 'past', message: 'That date range has passed. Please choose today or a future date.', dates: [] as { date: string; weekday: string; slots: string[] }[] };
    }
    const start = from.isPast ? nowInBusinessTimezone().startOf('day') : requestedStart;
    const effectiveFromDate = start.format('YYYY-MM-DD');
    const days = end.diff(start, 'day') + 1;
    const occupied = await this.loadOccupiedWindows(start.startOf('day'), end.endOf('day'));
    const dates: { date: string; weekday: string; slots: string[] }[] = [];
    for (let offset = 0; offset < days; offset++) {
      const date = start.add(offset, 'day').format('YYYY-MM-DD');
      const facts = bookingDateFacts(date);
      if (facts.isMonday) continue;
      const slots = this.calculateSlots(date, SERVICE_DURATIONS[serviceKey], occupied);
      if (slots.length) {
        dates.push({ date, weekday: facts.weekday, slots: slots.slice(0, 3) });
      }
    }
    return {
      fromDate: effectiveFromDate, toDate, service, dates,
      status: dates.length ? 'available' : 'unavailable',
      message: dates.length ? 'Open dates with available slots.' : 'No open dates with available slots in this range; the days are closed or fully booked.',
    };
  }
  
  /**
   * Get available time slots for a specific date and duration.
  * excludeBookingId lets a reschedule check availability without the
   * customer's own current booking (still 'confirmed' until the reschedule is
   * applied) falsely counting as a conflict against itself.
  * excludeDraftId lets a proposal recheck availability without conflicting
  * with its own temporary slot hold.
   */
  async getAvailableSlots(date: string, durationMinutes: number, excludeBookingId?: string, excludeDraftId?: string) {
    const facts = bookingDateFacts(date);
    if (facts.isPast) return { status: 'closed', reason: 'That date is in the past' };
    if (facts.isMonday) return { status: 'closed', reason: 'Closed on Mondays' };
    const startOfDay = businessDay(date).startOf('day');
    const endOfDay = businessDay(date).endOf('day');

    const occupied = await this.loadOccupiedWindows(startOfDay, endOfDay, excludeBookingId, excludeDraftId);
    return this.calculateSlots(date, durationMinutes, occupied);
  }

  private async loadOccupiedWindows(startOfDay: dayjs.Dayjs, endOfDay: dayjs.Dayjs, excludeBookingId?: string, excludeDraftId?: string): Promise<OccupiedWindow[]> {
    const existingBookings = await prisma.booking.findMany({
      where: {
        dateTime: {
          gte: startOfDay.toDate(),
          lte: endOfDay.toDate()
        },
        status: {
          not: 'cancelled'
        },
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {})
      }
    });

    // 1b. Fetch active proposal/payment drafts from last 15 minutes as holds.
    const fifteenMinutesAgo = nowInBusinessTimezone().subtract(15, 'minute').toDate();
    const activeDrafts = await prisma.bookingDraft.findMany({
      where: {
        step: { in: ['awaiting_confirmation', 'payment_pending'] },
        updatedAt: {
          gte: fifteenMinutesAgo
        },
        dateTimeIso: { not: null },
        ...(excludeDraftId ? { id: { not: excludeDraftId } } : {}),
      }
    });

    // 2. Fetch events from Google Calendar
    const googleEvents = await googleCalendarService.getEvents(startOfDay.toDate(), endOfDay.toDate());

    const occupied: OccupiedWindow[] = existingBookings.map((booking) => {
      const start = businessDay(booking.dateTime);
      return { start, end: start.add(booking.durationMinutes || DEFAULT_DURATION, 'minute') };
    });
    for (const draft of activeDrafts) {
      if (!draft.dateTimeIso) continue;
      const start = businessDay(draft.dateTimeIso);
      const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => draft.service?.toLowerCase().includes(key));
      occupied.push({ start, end: start.add(serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION, 'minute') });
    }
    for (const event of googleEvents) {
      if (!event.start?.dateTime || !event.end?.dateTime) continue;
      occupied.push({ start: businessDay(event.start.dateTime), end: businessDay(event.end.dateTime) });
    }
    return occupied;
  }

  private calculateSlots(date: string, durationMinutes: number, occupied: OccupiedWindow[]): string[] {
    const businessStart = 9;
    const businessEnd = 19;
    
    const availableSlots: string[] = [];
    
    // Check every 30 minutes
    for (let hour = businessStart; hour < businessEnd; hour++) {
      for (let minute of [0, 30]) {
        const slotStart = businessDay(date).hour(hour).minute(minute).second(0).millisecond(0);
        const slotEnd = slotStart.add(durationMinutes, 'minute');
        if (slotStart.isBefore(nowInBusinessTimezone())) continue;

        // Check if this slot exceeds business hours
        if (slotEnd.hour() > businessEnd || (slotEnd.hour() === businessEnd && slotEnd.minute() > 0)) {
          continue;
        }

        if (!occupied.some((window) => slotStart.isBefore(window.end) && slotEnd.isAfter(window.start))) {
          availableSlots.push(slotStart.format('HH:mm'));
        }
      }
    }

    return availableSlots;
  }
}

export const bookingService = new BookingService();

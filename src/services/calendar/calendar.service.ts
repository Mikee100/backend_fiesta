import { google } from 'googleapis';
import dayjs from 'dayjs';

/**
 * Service to handle synchronization with Google Calendar
 * Using Service Account credentials from environment variables
 */
export class GoogleCalendarService {
  private auth;
  private calendar;
  private calendarId: string;

  constructor() {
    try {
      const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      if (!keyString) {
        console.error('GOOGLE_SERVICE_ACCOUNT_KEY not found in environment');
        return;
      }

      const credentials = JSON.parse(keyString);
      
      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });

      this.calendar = google.calendar({ version: 'v3', auth: this.auth });
      this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
      
      console.log('Google Calendar Service initialized with Service Account:', credentials.client_email);
      console.log('Target Calendar ID:', this.calendarId);
    } catch (error: any) {
      console.error('Error initializing Google Calendar Service:', error.message);
    }
  }

  /**
   * Create a new event on Google Calendar
   */
  async createEvent(booking: { service: string, dateTime: Date, customerName: string, durationMinutes: number }) {
    if (!this.calendar) return null;
    try {
      const start = dayjs(booking.dateTime).toISOString();
      const end = dayjs(booking.dateTime).add(booking.durationMinutes, 'minute').toISOString();

      const event = {
        summary: `${booking.service} - ${booking.customerName}`,
        description: `Booking for ${booking.service} via WhatsApp AI`,
        start: { dateTime: start, timeZone: 'Africa/Nairobi' },
        end: { dateTime: end, timeZone: 'Africa/Nairobi' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 60 },
          ],
        },
      };

      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: event,
      });

      console.log('Google Calendar event created:', response.data.id);
      return response.data.id;
    } catch (error: any) {
      console.error('Error creating Google Calendar event:', error.message);
      return null;
    }
  }

  /**
   * Update an existing event (e.g. for rescheduling)
   */
  async updateEvent(calendarEventId: string, booking: { service: string, dateTime: Date, customerName: string, durationMinutes: number }) {
    if (!this.calendar) return false;
    try {
      const start = dayjs(booking.dateTime).toISOString();
      const end = dayjs(booking.dateTime).add(booking.durationMinutes, 'minute').toISOString();

      await this.calendar.events.patch({
        calendarId: this.calendarId,
        eventId: calendarEventId,
        requestBody: {
          start: { dateTime: start, timeZone: 'Africa/Nairobi' },
          end: { dateTime: end, timeZone: 'Africa/Nairobi' },
        },
      });

      console.log('Google Calendar event updated:', calendarEventId);
      return true;
    } catch (error: any) {
      console.error('Error updating Google Calendar event:', error.message);
      return false;
    }
  }

  /**
   * Remove an event from the calendar
   */
  async deleteEvent(calendarEventId: string) {
    if (!this.calendar) return false;
    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId: calendarEventId,
      });
      console.log('Google Calendar event deleted:', calendarEventId);
      return true;
    } catch (error: any) {
      console.error('Error deleting Google Calendar event:', error.message);
      return false;
    }
  }

  /**
   * Fetch events for a specific time range
   */
  async getEvents(start: Date, end: Date) {
    if (!this.calendar) return [];
    try {
      const response = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      return response.data.items || [];
    } catch (error: any) {
      console.error('Error fetching Google Calendar events:', error.message);
      return [];
    }
  }
}

export const googleCalendarService = new GoogleCalendarService();

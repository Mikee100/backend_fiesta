import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { whatsappService } from '../messaging/whatsapp.service';
import { inBusinessTimezone, nowInBusinessTimezone } from '../../utils/time';
import { customerReplyTemplates } from '../messaging/customer-reply.templates';

export class AutomationService {
  
  /**
   * Check for upcoming bookings (24h reminder)
   */
  async processReminders() {
    console.log('Running Automation: processReminders');
    
    // Find bookings happening in the next 24-25 hours
    const tomorrowStart = nowInBusinessTimezone().add(1, 'day').startOf('day').toDate();
    const tomorrowEnd = nowInBusinessTimezone().add(1, 'day').endOf('day').toDate();

    const upcomingBookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        dateTime: {
          gte: tomorrowStart,
          lte: tomorrowEnd
        },
        // Don't send if already sent
        reminders: {
          none: {
            type: '24hr',
            status: 'sent'
          }
        }
      },
      include: {
        customer: true
      }
    });

    for (const booking of upcomingBookings) {
      try {
        const timeStr = inBusinessTimezone(booking.dateTime).format('h:mm A');
        const message = customerReplyTemplates.appointmentReminder(booking.customer.name, booking.service, timeStr);

        await whatsappService.sendMessage(booking.customer.id, message);

        // Record reminder
        await prisma.bookingReminder.create({
          data: {
            bookingId: booking.id,
            type: '24hr',
            scheduledFor: booking.dateTime,
            status: 'sent',
            messageContent: message,
            sentAt: new Date()
          }
        });

        console.log(`Reminder sent to ${booking.customer.id} for booking ${booking.id}`);
      } catch (error) {
        console.error(`Failed to send reminder for booking ${booking.id}:`, error);
      }
    }
  }

  /**
   * Check for past bookings (5-day feedback)
   */
  async processFollowups() {
    console.log('Running Automation: processFollowups');

    // Find bookings that happened exactly 5 days ago (give or take an hour)
    const fiveDaysAgoStart = nowInBusinessTimezone().subtract(5, 'day').startOf('day').toDate();
    const fiveDaysAgoEnd = nowInBusinessTimezone().subtract(5, 'day').endOf('day').toDate();

    const pastBookings = await prisma.booking.findMany({
      where: {
        status: 'confirmed',
        dateTime: {
          gte: fiveDaysAgoStart,
          lte: fiveDaysAgoEnd
        },
        // Don't send if already sent
        followups: {
          none: {
            type: 'feedback',
            status: 'sent'
          }
        }
      },
      include: {
        customer: true
      }
    });

    for (const booking of pastBookings) {
      try {
        const message = customerReplyTemplates.feedbackFollowUp(booking.customer.name);

        await whatsappService.sendMessage(booking.customer.id, message);

        // Record followup
        await prisma.postShootFollowup.create({
          data: {
            bookingId: booking.id,
            type: 'feedback',
            scheduledFor: new Date(),
            status: 'sent',
            messageContent: message,
            sentAt: new Date()
          }
        });

        console.log(`Followup sent to ${booking.customer.id} for booking ${booking.id}`);
      } catch (error) {
        console.error(`Failed to send followup for booking ${booking.id}:`, error);
      }
    }
  }
}

export const automationService = new AutomationService();

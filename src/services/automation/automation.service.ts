import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { whatsappService } from '../messaging/whatsapp.service';

export class AutomationService {
  
  /**
   * Check for upcoming bookings (24h reminder)
   */
  async processReminders() {
    console.log('Running Automation: processReminders');
    
    // Find bookings happening in the next 24-25 hours
    const tomorrowStart = dayjs().add(24, 'hour').startOf('hour').toDate();
    const tomorrowEnd = dayjs().add(25, 'hour').endOf('hour').toDate();

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
        const timeStr = dayjs(booking.dateTime).format('h:mm A');
        const message = `Hi ${booking.customer.name}! 📸 This is a friendly reminder from Fiesta AI for your ${booking.service} appointment tomorrow at ${timeStr}. We're excited to see you!`;

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
    const fiveDaysAgoStart = dayjs().subtract(5, 'day').startOf('hour').toDate();
    const fiveDaysAgoEnd = dayjs().subtract(5, 'day').endOf('hour').toDate();

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
        const message = `Hi ${booking.customer.name}! 👋 It's been 5 days since your shoot. We hope you're loving your photos! How was your experience with us? We'd love to hear your feedback!`;

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

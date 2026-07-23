import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { googleCalendarService } from '../services/calendar/calendar.service';
import { whatsappService } from '../services/messaging/whatsapp.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../config/constants';

export class PaymentController {
  /**
   * Handles M-Pesa Callback
   */
  async handleMpesaCallback(req: Request, res: Response) {
    const { Body } = req.body;
    
    if (!Body || !Body.stkCallback) {
      console.error('Invalid M-Pesa Callback payload:', req.body);
      return res.status(400).json({ status: 'error', message: 'Invalid payload' });
    }

    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = Body.stkCallback;

    console.log(`M-Pesa Callback received for CheckoutRequestID: ${CheckoutRequestID}, ResultCode: ${ResultCode}`);
    console.log('Full Callback Body:', JSON.stringify(req.body, null, 2));

    try {
      // Find the payment record with potential booking or draft
      const payment = await prisma.payment.findFirst({
        where: { checkoutRequestId: CheckoutRequestID },
        include: { 
          booking: { include: { customer: true } },
          bookingDraft: { include: { customer: true } }
        }
      });

      if (!payment) {
        console.error(`❌ Payment record not found for CheckoutRequestID: ${CheckoutRequestID}`);
        return res.status(404).json({ status: 'error', message: 'Payment record not found' });
      }

      console.log(`✅ Found payment record for ${payment.phone}. Linked to draft: ${!!payment.bookingDraft}, booking: ${!!payment.booking}`);

      if (ResultCode === 0) {
        // Success
        const mpesaReceipt = CallbackMetadata.Item.find((item: any) => item.Name === 'MpesaReceiptNumber')?.Value;
        
        let targetBooking;

        // 1. If it's a draft, promote it to a real booking
        if (payment.bookingDraft) {
          const draft = payment.bookingDraft;
          const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => draft.service?.toLowerCase().includes(k)) || 'standard';
          const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

          targetBooking = await prisma.booking.create({
            data: {
              customerId: draft.customerId,
              service: draft.service || 'Standard Package',
              dateTime: draft.dateTimeIso ? new Date(draft.dateTimeIso) : new Date(),
              status: 'confirmed',
              durationMinutes: duration,
              recipientName: draft.name
            },
            include: { customer: true }
          });

          // Delete the draft
          await prisma.bookingDraft.delete({ where: { id: draft.id } });
        } else if (payment.booking) {
          // 2. If it's an existing provisional booking, confirm it
          targetBooking = await prisma.booking.update({
            where: { id: payment.booking.id },
            data: { status: 'confirmed' },
            include: { customer: true }
          });
        }

        // Update payment record
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'success',
            mpesaReceipt: mpesaReceipt,
            bookingId: targetBooking?.id // Ensure it's linked to the new booking
          }
        });

        if (targetBooking) {
          // Sync with Google Calendar
          const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => targetBooking.service.toLowerCase().includes(k)) || 'standard';
          const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

          const googleEventId = await googleCalendarService.createEvent({
            service: targetBooking.service,
            dateTime: targetBooking.dateTime,
            customerName: targetBooking.customer.name,
            durationMinutes: duration
          });

          if (googleEventId) {
            await prisma.booking.update({
              where: { id: targetBooking.id },
              data: { googleEventId }
            });
          }

          // Notify customer via WhatsApp
          const message = `🌟 *Payment Received!* 🌟\n\nYour booking for *${targetBooking.service}* on *${targetBooking.dateTime.toLocaleDateString()}* at *${targetBooking.dateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}* has been officially *CONFIRMED*.\n\nWe look forward to seeing you at Fiesta House Attire & Maternity! ✨`;
          await whatsappService.sendMessage(targetBooking.customer.id, message);

          console.log(`Booking ${targetBooking.id} confirmed after successful payment.`);

          // Best-effort: keep CustomerMemory current with this confirmed booking.
          // Never let a memory-update failure break the payment confirmation flow.
          try {
            const existingMemory = await prisma.customerMemory.findUnique({ where: { customerId: targetBooking.customerId } });
            const newTotal = (existingMemory?.totalBookings || 0) + 1;
            const preferredPackages = existingMemory?.preferredPackages || [];
            if (!preferredPackages.includes(targetBooking.service)) preferredPackages.push(targetBooking.service);

            await prisma.customerMemory.upsert({
              where: { customerId: targetBooking.customerId },
              update: {
                totalBookings: { increment: 1 },
                relationshipStage: newTotal > 1 ? 'returning' : 'booked',
                preferredPackages
              },
              create: {
                customerId: targetBooking.customerId,
                totalBookings: 1,
                relationshipStage: 'booked',
                preferredPackages: [targetBooking.service]
              }
            });
          } catch (memErr) {
            console.error('Failed to update customer memory after booking:', memErr);
          }
        }
      } else {
        // Failed
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'failed' }
        });

        const customerId = payment.bookingDraft?.customerId || payment.booking?.customerId;
        if (customerId) {
           const message = `❌ *Payment Failed* ❌\n\nWe couldn't process your deposit payment: *${ResultDesc}*.\n\nYour booking request is still on hold for 15 minutes. Please try the payment again or contact us for assistance.`;
           await whatsappService.sendMessage(customerId, message);
        }
        
        console.log(`Payment failed for CheckoutRequestID: ${CheckoutRequestID}. Reason: ${ResultDesc}`);
      }

      return res.status(200).json({ status: 'success' });
    } catch (error: any) {
      console.error('Error processing M-Pesa callback:', error);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }
}

export const paymentController = new PaymentController();

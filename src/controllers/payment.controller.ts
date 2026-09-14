import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { googleCalendarService } from '../services/calendar/calendar.service';
import { whatsappService } from '../services/messaging/whatsapp.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../config/constants';
import { notifyAdmin } from '../services/notifications/notification.service';
import { invoiceService } from '../services/invoice/invoice.service';
import { customerReplyTemplates } from '../services/messaging/customer-reply.templates';
import { bookingAddonService } from '../services/booking/booking-addon.service';

export class PaymentController {
  /**
   * Creates an invoice for a confirmed booking if one doesn't exist yet.
   * Safe to call multiple times (idempotent by unique bookingId).
   */
  private async ensureInvoiceForBooking(bookingId: string): Promise<void> {
    const existing = await prisma.invoice.findUnique({ where: { bookingId }, select: { id: true } });
    if (existing) return;

    const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { customer: true } });
    if (!booking) return;

    const pkg = await prisma.package.findFirst({ where: { name: { contains: booking.service, mode: 'insensitive' } } });
    const packagePrice = pkg?.price || 0;
    const { addonsTotal, lineItems: addonLines } = await bookingAddonService.sumForBooking(bookingId);
    const subtotal = packagePrice + addonsTotal;
    const tax = 0;
    const discount = 0;
    const total = subtotal + tax - discount;

    const payments = await prisma.payment.findMany({ where: { bookingId, status: 'success' } });
    const depositPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const depositReceipts = payments.map((p) => p.mpesaReceipt).filter((r): r is string => !!r);
    const balanceDue = Math.max(total - depositPaid, 0);

    const year = new Date().getFullYear();
    const invoiceCountThisYear = await prisma.invoice.count({ where: { invoiceNumber: { startsWith: `INV-${year}-` } } });
    const invoiceNumber = invoiceService.buildInvoiceNumber(year, invoiceCountThisYear + 1);

    const pdfBuffer = await invoiceService.generatePdf({
      invoiceNumber,
      customerName: booking.customer.name,
      customerPhone: booking.customer.phone,
      service: booking.service,
      bookingDateTime: booking.dateTime,
      subtotal: packagePrice,
      addonLines,
      tax,
      discount,
      total,
      depositPaid,
      depositReceipts,
      balanceDue,
      createdAt: new Date(),
    });

    await prisma.invoice.create({
      data: {
        invoiceNumber,
        bookingId,
        customerId: booking.customerId,
        subtotal,
        tax,
        discount,
        total,
        depositPaid,
        balanceDue,
        status: 'pending',
        pdfData: pdfBuffer,
      }
    });

    await bookingAddonService.markInvoiced(bookingId);
  }

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
          const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => draft.service?.toLowerCase().includes(k)) || 'bloom';
          const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

          targetBooking = await prisma.booking.create({
            data: {
              customerId: draft.customerId,
              service: draft.service || 'THE BLOOM',
              dateTime: draft.dateTimeIso ? new Date(draft.dateTimeIso) : new Date(),
              status: 'confirmed',
              durationMinutes: duration,
              recipientName: draft.name
            },
            include: { customer: true }
          });

          // Attach any pending add-on line items captured during the draft flow
          await bookingAddonService.attachPendingToBooking(draft.customerId, targetBooking.id);

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
          const appointmentDate = targetBooking.dateTime.toLocaleDateString('en-KE', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Africa/Nairobi',
          });
          const appointmentTime = targetBooking.dateTime.toLocaleTimeString('en-KE', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'Africa/Nairobi',
          });
          const message = `Payment received. Your ${targetBooking.service} session is confirmed.\n\n${appointmentDate} at ${appointmentTime}\n\nWe'll send you a reminder before your session. We look forward to welcoming you.`;
          await whatsappService.sendMessage(targetBooking.customer.id, message);

          // Best-effort auto invoice generation right after successful payment.
          // Do not break the payment flow if invoice creation fails.
          try {
            await this.ensureInvoiceForBooking(targetBooking.id);
          } catch (invoiceErr: any) {
            console.error(`Failed to auto-generate invoice for booking ${targetBooking.id}:`, invoiceErr?.message || invoiceErr);
          }

          await notifyAdmin(
            'booking',
            `New booking confirmed: ${targetBooking.customer.name || targetBooking.customer.id}`,
            `${targetBooking.service} on ${targetBooking.dateTime.toLocaleDateString()} at ${targetBooking.dateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Deposit KSH ${payment.amount}${mpesaReceipt ? `, M-Pesa code ${mpesaReceipt}` : ''}.`,
            {
              event: 'new_booking_confirmed',
              customerId: targetBooking.customerId,
              bookingId: targetBooking.id,
              paymentId: payment.id,
              service: targetBooking.service,
              bookingDateTime: targetBooking.dateTime.toISOString(),
              amount: payment.amount,
              paymentAmount: payment.amount,
              paymentStatus: 'success',
              mpesaReceipt: mpesaReceipt || null,
              checkoutRequestId: payment.checkoutRequestId || null,
              paidAt: new Date().toISOString(),
            }
          );

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
           const message = customerReplyTemplates.paymentFailed(ResultDesc);
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

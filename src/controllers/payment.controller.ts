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

    // Immediate 200 OK fast-ack to Safaricom Daraja to prevent webhook timeouts
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

    // Process payment verification, booking creation, calendar sync, and WhatsApp dispatch asynchronously
    setImmediate(async () => {
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
          return;
        }

        console.log(`✅ Found payment record for ${payment.phone}. Linked to draft: ${!!payment.bookingDraft}, booking: ${!!payment.booking}`);

        if (ResultCode === 0) {
          // Success
          const mpesaReceipt = CallbackMetadata?.Item?.find((item: any) => item.Name === 'MpesaReceiptNumber')?.Value;
          
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
                recipientName: draft.recipientName || (draft.isForSomeoneElse ? draft.name : null)
              },
              include: { customer: true }
            });

            // Attach any pending add-on line items captured during the draft flow
            await bookingAddonService.attachPendingToBooking(draft.customerId, targetBooking.id);

            // Keep operational notes captured before payment attached to the
            // booking as well, so recipient and special-request context survives
            // the draft-to-booking transition.
            await prisma.customerSessionNote.updateMany({
              where: {
                customerId: draft.customerId,
                bookingId: null,
                status: 'pending',
                createdAt: { gte: draft.createdAt },
              },
              data: { bookingId: targetBooking.id },
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
            // Sync with Google Calendar (best-effort)
            try {
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
            } catch (calErr: any) {
              console.error('Failed to sync booking to Google Calendar:', calErr?.message || calErr);
            }

            // Generate the invoice before notifying the customer so the PDF can
            // be delivered with the successful payment confirmation.
            let invoiceNumber: string | null = null;
            let invoicePdf: Buffer | null = null;
            let balanceDue: number | null = null;
            try {
              const invoice = await invoiceService.createOrRefreshForBooking(targetBooking.id);
              invoiceNumber = invoice?.invoiceNumber || null;
              invoicePdf = invoice?.pdfData ? Buffer.from(invoice.pdfData) : null;
              balanceDue = invoice?.balanceDue ?? null;
            } catch (invoiceErr: any) {
              console.error(`Failed to auto-generate invoice for booking ${targetBooking.id}:`, invoiceErr?.message || invoiceErr);
            }

            // Notify customer via WhatsApp with payment details and the invoice.
            try {
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
              const paymentDetails = [
                `Payment received successfully. Your ${targetBooking.service} session is confirmed.`,
                '',
                `Amount paid: KSh ${payment.amount.toLocaleString()}`,
                `M-Pesa receipt: ${mpesaReceipt || 'Available in your payment record'}`,
                invoiceNumber ? `Invoice: ${invoiceNumber}` : null,
                balanceDue !== null ? `Balance due: KSh ${balanceDue.toLocaleString()}` : null,
                '',
                `Session: ${appointmentDate} at ${appointmentTime}`,
                '',
                invoicePdf ? 'Your invoice is attached to this message. We will send you a reminder before your session.' : 'We will send your invoice shortly. We will also send you a reminder before your session.',
                'We look forward to welcoming you.'
              ].filter((line): line is string => line !== null).join('\n');

              if (invoicePdf && invoiceNumber) {
                await whatsappService.sendDocument(targetBooking.customer.id, invoicePdf, `${invoiceNumber}.pdf`, paymentDetails);
              } else {
                await whatsappService.sendMessage(targetBooking.customer.id, paymentDetails);
              }
            } catch (waErr: any) {
              console.error('Failed to send WhatsApp booking confirmation or invoice:', waErr?.message || waErr);
              try {
                await whatsappService.sendMessage(
                  targetBooking.customer.id,
                  `Payment received successfully for ${targetBooking.service}. Your session is confirmed. M-Pesa receipt: ${mpesaReceipt || 'recorded'}. We will send your invoice shortly.`
                );
              } catch (fallbackErr: any) {
                console.error('Failed to send WhatsApp payment confirmation fallback:', fallbackErr?.message || fallbackErr);
              }
            }

            try {
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
            } catch (adminErr: any) {
              console.error('Failed to notify admin of confirmed booking:', adminErr?.message || adminErr);
            }

            console.log(`Booking ${targetBooking.id} confirmed after successful payment.`);

            // Best-effort: keep CustomerMemory current with this confirmed booking.
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
            try {
              const message = customerReplyTemplates.paymentFailed(ResultDesc);
              await whatsappService.sendMessage(customerId, message);
            } catch (waErr: any) {
              console.error('Failed to send payment failure WhatsApp message:', waErr?.message || waErr);
            }
          }
          
          console.log(`Payment failed for CheckoutRequestID: ${CheckoutRequestID}. Reason: ${ResultDesc}`);
        }
      } catch (asyncErr: any) {
        console.error('Error in asynchronous M-Pesa callback handling:', asyncErr);
      }
    });
  }
}

export const paymentController = new PaymentController();

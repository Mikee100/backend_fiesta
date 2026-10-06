import prisma from '../../config/prisma';
import { bookingAddonService } from '../booking/booking-addon.service';
import { invoiceService } from '../invoice/invoice.service';
import { whatsappService } from '../messaging/whatsapp.service';
import { nowInBusinessTimezone } from '../../utils/time';
import { stripAssistantEmojis } from './emoji-policy';

type HistoryMessage = { role: 'user' | 'assistant'; content: string };

export function extractInvoiceNumber(userMessage: string): string | null {
  const match = userMessage.match(/\bINV-\d{4}-\d{3}\b/i);
  return match ? match[0].toUpperCase() : null;
}

export function extractInvoiceSessionDateRange(userMessage: string): { start: Date; end: Date } | null {
  const monthPattern = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const match = userMessage.match(new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?[\\s/-]+${monthPattern}|${monthPattern}[\\s/-]+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(\\d{4}))?\\b`, 'i'));
  if (!match) return null;

  const day = Number(match[1] || match[4]);
  const monthName = (match[2] || match[3]).slice(0, 3).toLowerCase();
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthName);
  if (month < 0 || day < 1 || day > 31) return null;

  const year = Number(match[5] || nowInBusinessTimezone().year());
  const start = nowInBusinessTimezone().year(year).month(month).date(day).startOf('day');
  if (start.year() !== year || start.month() !== month || start.date() !== day) return null;

  return { start: start.toDate(), end: start.add(1, 'day').toDate() };
}

export function shouldUseInvoiceRequestReply(userMessage: string, history: HistoryMessage[] = []): boolean {
  history = stripAssistantEmojis(history);
  const text = userMessage.toLowerCase();
  const invoiceKeywords = /(invoice|receipt|payment summary)/.test(text);
  const actionKeywords = /(send|sent|share|download|get|give(?: me)?|provide|view|need|can you|could you)/.test(text);
  if (invoiceKeywords && actionKeywords) return true;

  const selectedSessionDate = extractInvoiceSessionDateRange(userMessage);
  const assistantAskedForInvoiceDate = history.slice(-6).some((message) =>
    message.role === 'assistant'
    && /\binvoices?\b[\s\S]{0,300}\bwhich session date\b/i.test(message.content)
  );
  if (selectedSessionDate && assistantAskedForInvoiceDate) return true;

  const resendRequest = /\b(send|resend|forward|share|get|deliver)\b/.test(text)
    && /\b(it|that|this|again|another time)\b/.test(text);
  const refersToInvoice = history.slice(-6).some((message) =>
    message.role === 'assistant' && /\binvoice\b|\bINV-\d{4}-\d{3}\b|pdf.{0,20}(?:whatsapp|sent|attached)/i.test(message.content)
  );
  const reportsNotReceived = /\b(not|haven't|have not|never)\s+(?:received|got|get)\b/.test(text)
    || /\bdidn't\s+(?:receive|get)\b/.test(text);
  return refersToInvoice && (reportsNotReceived || resendRequest);
}

export function getInvoiceSessionDateFromHistory(history: HistoryMessage[]): { start: Date; end: Date } | null {
  history = stripAssistantEmojis(history);
  let latestInvoiceDeliveryIndex = -1;
  history.forEach((message, index) =>
  {
    if (
      message.role === 'assistant'
      && /\binvoice\b/i.test(message.content)
      && /\b(send|sent|deliver|forward|pull up|email|attached)\b/i.test(message.content)
    ) {
      latestInvoiceDeliveryIndex = index;
    }
  });

  if (latestInvoiceDeliveryIndex < 0) return null;
  const selectedDate = history
    .slice(0, latestInvoiceDeliveryIndex)
    .reverse()
    .find((message) => message.role === 'user' && extractInvoiceSessionDateRange(message.content));
  return selectedDate ? extractInvoiceSessionDateRange(selectedDate.content) : null;
}

export function shouldDeclineConsolidatedInvoiceRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const asksForInvoice = /\b(invoice|receipt|payment summary)\b/.test(text);
  const asksForMultiple = /\b(all|every|each|combined|consolidated)\b/.test(text)
    || /\b(?:one|single)\s+(?:combined\s+|consolidated\s+)?invoice\b/.test(text)
    || /\bin one\b/.test(text);
  return asksForInvoice && asksForMultiple;
}

export async function sendStoredInvoiceToCustomer(
  this: any,
  customerId: string,
  requestedInvoiceNumber?: string,
  history: HistoryMessage[] = [],
  userMessage = ''
): Promise<string> {
  if (this.shouldDeclineConsolidatedInvoiceRequest(userMessage)) {
    return 'Invoices are issued per booking, and I cannot combine multiple sessions into one invoice here. I have not sent an invoice, so I do not send the wrong session by mistake. Please tell me which session date you need, or ask the studio team about a consolidated statement.';
  }

  const requestedSessionDate = this.extractInvoiceSessionDateRange(userMessage)
    || this.getInvoiceSessionDateFromHistory(history);
  const refersToPastAppointment = !requestedInvoiceNumber && [...history].reverse()
    .find((message) => message.role === 'assistant')?.content
    .includes('The most recent past booking I have on record is');
  const pastBooking = refersToPastAppointment
    ? await prisma.booking.findFirst({
        where: { customerId, status: { not: 'cancelled' }, dateTime: { lt: new Date() } },
        orderBy: { dateTime: 'desc' },
        select: { id: true },
      })
    : null;

  let invoice: any;
  if (requestedInvoiceNumber) {
    invoice = await prisma.invoice.findFirst({
        where: { customerId, invoiceNumber: requestedInvoiceNumber },
        include: { booking: true },
      });
  } else if (requestedSessionDate) {
    const bookingOnDate = await prisma.booking.findFirst({
      where: {
        customerId,
        status: { not: 'cancelled' },
        dateTime: { gte: requestedSessionDate.start, lt: requestedSessionDate.end },
      },
      orderBy: { dateTime: 'desc' },
      select: { id: true },
    });
    if (bookingOnDate) {
      invoice = await prisma.invoice.findUnique({
        where: { bookingId: bookingOnDate.id },
        include: { booking: true },
      });
    }
  } else if (pastBooking) {
    invoice = await prisma.invoice.findUnique({
          where: { bookingId: pastBooking.id },
          include: { booking: true },
        });
  } else {
    invoice = await prisma.invoice.findFirst({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        include: { booking: true },
      });
  }

  if (!invoice) {
    if (requestedSessionDate) {
      return "I couldn't find a saved invoice for a session on that date, so I haven't sent another session's invoice.";
    }
    if (refersToPastAppointment) {
      return "I couldn't find an invoice saved for your most recent past session. I don't want to send you the wrong session's invoice, so please ask the team to check that booking.";
    }
    if (requestedInvoiceNumber) {
      return `I could not find invoice ${requestedInvoiceNumber} under your account. Please confirm the invoice number or ask the team to resend it.`;
    }
    return 'I could not find a saved invoice for your account yet. Please confirm the booking or ask the team to generate one.';
  }

  const refreshedInvoice = await invoiceService.createOrRefreshForBooking(invoice.bookingId);
  if (refreshedInvoice) invoice = refreshedInvoice;

  const { lineItems: addonLines } = await bookingAddonService.sumForBooking(invoice.bookingId);
  const addonSummary = addonLines.length > 0
    ? `\nAdd-ons:\n${addonLines.map((line) => `${line.name}: ${line.totalPrice > 0 ? `KSh ${line.totalPrice.toLocaleString()}` : 'Quoted'}`).join('\n')}\n`
    : '';
  const summary = `Invoice ${invoice.invoiceNumber}\n\nService: ${invoice.booking.service}\nDate: ${invoice.booking.dateTime.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi' })}${addonSummary}\nTotal: KSh ${invoice.total.toLocaleString()}\nDeposit Paid: KSh ${invoice.depositPaid.toLocaleString()}\nBalance Due: KSh ${invoice.balanceDue.toLocaleString()}\n\nYour invoice is attached here as a PDF.`;

  try {
    if (!invoice.pdfData) {
      throw new Error('No PDF stored for this invoice');
    }

    await whatsappService.sendDocument(customerId, Buffer.from(invoice.pdfData), `${invoice.invoiceNumber}.pdf`, summary);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'sent', sentAt: new Date() },
    });
    return 'I’ve sent your invoice as a PDF to WhatsApp.';
  } catch (error: any) {
    console.error('Failed to send stored PDF invoice to WhatsApp:', error?.message || error);
    const downloadUrl = `${process.env.BASE_URL || ''}/api/invoices/download/${invoice.id}`;
    try {
      await whatsappService.sendMessage(customerId, `${summary}\n\nDownload your invoice: ${downloadUrl}`);
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      return 'I’ve sent the invoice details and a download link to WhatsApp.';
    } catch (fallbackError: any) {
      console.error('Fallback invoice message failed:', fallbackError?.message || fallbackError);
      return 'I found your invoice, but I could not send it right now. Please ask the team to resend it or use the invoice download link from the dashboard.';
    }
  }
}
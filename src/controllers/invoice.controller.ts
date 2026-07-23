import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { invoiceService } from '../services/invoice/invoice.service';
import { whatsappService } from '../services/messaging/whatsapp.service';

// Fields safe to send to the frontend - excludes the binary pdfData blob,
// which is only ever served directly via the download endpoint.
const INVOICE_LIST_SELECT = {
  id: true,
  invoiceNumber: true,
  bookingId: true,
  customerId: true,
  subtotal: true,
  tax: true,
  discount: true,
  total: true,
  depositPaid: true,
  balanceDue: true,
  status: true,
  sentAt: true,
  paidAt: true,
  pdfUrl: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { name: true, phone: true } },
  booking: { select: { id: true, service: true, dateTime: true } },
} as const;

export class InvoiceController {
  async getAllInvoices(req: Request, res: Response) {
    try {
      const invoices = await prisma.invoice.findMany({ select: INVOICE_LIST_SELECT, orderBy: { createdAt: 'desc' } });
      return res.json(invoices);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getInvoicesByBooking(req: Request, res: Response) {
    try {
      const bookingId = req.params.bookingId as string;
      const invoices = await prisma.invoice.findMany({ where: { bookingId }, select: INVOICE_LIST_SELECT });
      return res.json(invoices);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getInvoicesByCustomer(req: Request, res: Response) {
    try {
      const customerId = req.params.customerId as string;
      const invoices = await prisma.invoice.findMany({
        where: { customerId },
        select: INVOICE_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
      });
      return res.json(invoices);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async generateInvoice(req: Request, res: Response) {
    try {
      const bookingId = req.params.bookingId as string;

      const existing = await prisma.invoice.findUnique({ where: { bookingId }, select: INVOICE_LIST_SELECT });
      if (existing) {
        return res.status(200).json(existing); // idempotent - one invoice per booking
      }

      const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { customer: true } });
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const pkg = await prisma.package.findFirst({ where: { name: { contains: booking.service, mode: 'insensitive' } } });
      const subtotal = pkg?.price || 0;
      const tax = 0;
      const discount = 0;
      const total = subtotal + tax - discount;

      const payments = await prisma.payment.findMany({ where: { bookingId, status: 'success' } });
      const depositPaid = payments.reduce((sum, p) => sum + p.amount, 0);
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
        subtotal,
        tax,
        discount,
        total,
        depositPaid,
        balanceDue,
        createdAt: new Date(),
      });

      const invoice = await prisma.invoice.create({
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
        },
        select: INVOICE_LIST_SELECT,
      });

      return res.status(201).json(invoice);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async sendInvoice(req: Request, res: Response) {
    try {
      const invoiceId = req.params.invoiceId as string;
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { customer: true, booking: true },
      });
      if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      const summary = `*Invoice ${invoice.invoiceNumber}*\n\n`
        + `Service: ${invoice.booking.service}\n`
        + `Date: ${invoice.booking.dateTime.toLocaleDateString()}\n\n`
        + `Total: KSh ${invoice.total.toLocaleString()}\n`
        + `Deposit Paid: KSh ${invoice.depositPaid.toLocaleString()}\n`
        + `Balance Due: KSh ${invoice.balanceDue.toLocaleString()}\n\n`
        + `Thank you for choosing Fiesta House Attire & Maternity!`;

      // Try sending the actual PDF as a real WhatsApp document attachment -
      // only works on a paid 360dialog production account. Falls back to a
      // text summary with a real download link, which works today on the free
      // sandbox too.
      try {
        if (!invoice.pdfData) throw new Error('No PDF stored for this invoice');
        await whatsappService.sendDocument(invoice.customerId, Buffer.from(invoice.pdfData), `${invoice.invoiceNumber}.pdf`, summary);
      } catch (docError: any) {
        console.error('Falling back to text invoice (document send failed):', docError.message);
        const downloadUrl = `${process.env.BASE_URL || ''}/api/invoices/download/${invoice.id}`;
        await whatsappService.sendMessage(invoice.customerId, `${summary}\n\nDownload your invoice: ${downloadUrl}`);
      }

      const updated = await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'sent', sentAt: new Date() },
        select: INVOICE_LIST_SELECT,
      });

      return res.json(updated);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async downloadInvoice(req: Request, res: Response) {
    try {
      const invoiceId = req.params.invoiceId as string;
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice || !invoice.pdfData) {
        return res.status(404).json({ error: 'Invoice PDF not found' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
      return res.send(Buffer.from(invoice.pdfData));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const invoiceController = new InvoiceController();

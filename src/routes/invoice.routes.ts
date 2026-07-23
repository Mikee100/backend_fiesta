import { Router } from 'express';
import { invoiceController } from '../controllers/invoice.controller';

const router = Router();

router.get('/', invoiceController.getAllInvoices.bind(invoiceController));
router.get('/booking/:bookingId', invoiceController.getInvoicesByBooking.bind(invoiceController));
router.get('/customer/:customerId', invoiceController.getInvoicesByCustomer.bind(invoiceController));
router.get('/download/:invoiceId', invoiceController.downloadInvoice.bind(invoiceController));
router.post('/generate/:bookingId', invoiceController.generateInvoice.bind(invoiceController));
router.post('/send/:invoiceId', invoiceController.sendInvoice.bind(invoiceController));

export default router;

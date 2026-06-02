import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';

const router = Router();

// Safaricom M-Pesa Callback
router.post('/callback', paymentController.handleMpesaCallback.bind(paymentController));

export default router;

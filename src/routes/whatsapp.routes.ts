import { Router } from 'express';
import { whatsappController } from '../controllers/whatsapp.controller';

const router = Router();

// Meta Webhook Verification
router.get('/', whatsappController.verifyWebhook);

// Handle Incoming Messages
router.post('/', whatsappController.handleWebhook);

// Dashboard Routes
router.get('/conversations', whatsappController.getConversations.bind(whatsappController));
router.get('/messages', whatsappController.getMessages.bind(whatsappController));
router.post('/send', whatsappController.sendMessage.bind(whatsappController));
router.get('/settings', whatsappController.getSettings.bind(whatsappController));

export default router;

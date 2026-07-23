import { Router } from 'express';
import { instagramController } from '../controllers/instagram.controller';
import { verifyInstagramWebhook } from '../middleware/verifyWebhook';

const router = Router();

// Meta Webhook Verification
router.get('/', instagramController.verifyWebhook);

// Handle Incoming Messages
router.post('/', verifyInstagramWebhook, instagramController.handleWebhook.bind(instagramController));

// Dashboard Routes
router.get('/stats', instagramController.getStats.bind(instagramController));
router.get('/conversations', instagramController.getConversations.bind(instagramController));
router.get('/messages', instagramController.getMessages.bind(instagramController));
router.post('/send', instagramController.sendMessage.bind(instagramController));
router.get('/settings', instagramController.getSettings.bind(instagramController));

export default router;

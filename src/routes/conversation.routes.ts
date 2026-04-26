import { Router } from 'express';
import { conversationController } from '../controllers/conversation.controller';

const router = Router();

// /api/conversations
router.get('/', conversationController.getAllConversations.bind(conversationController));
router.get('/:id', conversationController.getById.bind(conversationController));
router.get('/:id/messages', conversationController.getConversationMessages.bind(conversationController));
router.post('/:id/reply', conversationController.sendReply.bind(conversationController));

export default router;

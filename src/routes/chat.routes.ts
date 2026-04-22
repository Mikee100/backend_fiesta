import { Router } from 'express';
import { chatController } from '../controllers/chat.controller';

const router = Router();

// Define /api/chat route
router.post('/chat', chatController.handleIncomingMessage.bind(chatController));

export default router;

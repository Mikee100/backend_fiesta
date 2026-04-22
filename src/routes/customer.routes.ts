import { Router } from 'express';
import { customerController } from '../controllers/customer.controller';

const router = Router();

router.get('/', customerController.getCustomers.bind(customerController));
router.get('/:id', customerController.getCustomer.bind(customerController));
router.get('/:id/messages', customerController.getMessages.bind(customerController));
router.get('/:id/session-notes', customerController.getSessionNotes.bind(customerController));
router.patch('/session-notes/:noteId', customerController.updateSessionNote.bind(customerController));
router.post('/:id/toggle-ai', customerController.toggleAi.bind(customerController));

export default router;

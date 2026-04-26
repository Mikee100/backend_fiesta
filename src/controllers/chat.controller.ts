import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';

export class ChatController {
  
  /**
   * Endpoint for accepting chat messages (e.g., from WhatsApp or a web widget)
   * POST /api/chat
   * Body: { customerId: string, message: string }
   */
  async handleIncomingMessage(req: Request, res: Response) {
    try {
      const { customerId, message } = req.body;

      if (!customerId || !message) {
        return res.status(400).json({ error: 'customerId and message are required' });
      }

      console.log(`Received message from ${customerId}: ${message}`);

      // Pass directly to the Agent Service which handles RAG + Booking Logic
      const reply = await agentService.handleMessage(customerId, message, [], 'web');

      console.log(`Agent structured reply:`, reply);

      return res.status(200).json({
        success: true,
        reply: reply
      });
    } catch (error: any) {
      console.error('Error handling chat message:', error);
      return res.status(500).json({ error: 'Internal server error while processing message.' });
    }
  }
}

export const chatController = new ChatController();

import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';
import { whatsappService } from '../services/messaging/whatsapp.service';
import prisma from '../config/prisma';
import dotenv from 'dotenv';

dotenv.config();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'socialresponder2025';

export class WhatsAppController {
  
  /**
   * Webhook Verification (GET)
   */
  verifyWebhook(req: Request, res: Response) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WhatsApp Webhook Verified!');
      return res.status(200).send(challenge);
    } else {
      console.error('WhatsApp Verification Failed. Token mismatch.');
      return res.sendStatus(403);
    }
  }

  /**
   * Handle Incoming Messages (POST)
   */
  async handleWebhook(req: Request, res: Response) {
    try {
      const body = req.body;

      // Check if it's a WhatsApp message event
      if (body.object === 'whatsapp_business_account') {
        if (
          body.entry &&
          body.entry[0].changes &&
          body.entry[0].changes[0].value.messages &&
          body.entry[0].changes[0].value.messages[0]
        ) {
          const message = body.entry[0].changes[0].value.messages[0];
          const from = message.from; // Phone number
          const msgBody = message.text ? message.text.body : '';
          const msgId = message.id;

          if (!msgBody) {
             return res.sendStatus(200);
          }

          console.log(`WhatsApp message from ${from}: ${msgBody}`);

          // 1. Check for Duplicate Message (Deduplication)
          const existingMessage = await prisma.message.findFirst({
            where: { externalId: msgId }
          });

          if (existingMessage) {
            console.log(`Duplicate message received (${msgId}), skipping.`);
            return res.sendStatus(200);
          }

          // 2. Ensure Customer exists and Save Inbound Message
          let customer = await prisma.customer.findUnique({ where: { id: from } });
          if (!customer) {
            customer = await prisma.customer.create({ data: { id: from, name: 'WhatsApp User' } });
          }

          await prisma.message.create({
            data: {
              content: msgBody,
              platform: 'whatsapp',
              direction: 'inbound',
              customerId: from,
              externalId: msgId
            }
          });

          // 2. Load recent history (last 10 messages)
          const recentMessages = await prisma.message.findMany({
            where: { customerId: from },
            orderBy: { createdAt: 'desc' },
            take: 10,
            skip: 1 // Skip the message we just saved
          });

          // Format for OpenAI (reverse because we took 'desc')
          const history = recentMessages.reverse().map(m => ({
            role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.content
          }));

          // 3. Mark as read
          await whatsappService.markAsRead(msgId);

          // 4. Get AI Response with history
          const aiReply = await agentService.handleMessage(from, msgBody, history);

          // 5. Save Outbound Message
          await prisma.message.create({
            data: {
              content: aiReply,
              platform: 'whatsapp',
              direction: 'outbound',
              customerId: from,
              handledBy: 'ai'
            }
          });

          // 6. Send reply back to WhatsApp
          await whatsappService.sendMessage(from, aiReply);
        }
        return res.sendStatus(200);
      } else {
        // Not a WhatsApp event
        return res.sendStatus(404);
      }
    } catch (error: any) {
      console.error('Error handling WhatsApp webhook:', error);
      if (error.response) {
        console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
      }
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all conversations (latest message per customer)
   */
  async getConversations(req: Request, res: Response) {
    try {
      const customers = await prisma.customer.findMany({
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      const conversations = customers
        .filter(c => c.messages.length > 0)
        .map(c => ({
          customerId: c.id,
          customerName: c.name,
          phone: c.id, // ID is the phone number in our system
          latestMessage: c.messages[0].content,
          latestTimestamp: c.messages[0].createdAt,
          unreadCount: 0, // Placeholder
          aiEnabled: c.aiEnabled
        }))
        .sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());

      return res.json({ conversations });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get messages for a specific customer
   */
  async getMessages(req: Request, res: Response) {
    try {
      const { customerId } = req.query;
      if (!customerId) return res.status(400).json({ error: 'customerId is required' });

      const messages = await prisma.message.findMany({
        where: { customerId: customerId as string },
        orderBy: { createdAt: 'asc' },
      });

      // Format for frontend
      const formattedMessages = messages.map(m => ({
        id: m.id,
        customerId: m.customerId,
        content: m.content,
        direction: m.direction,
        timestamp: m.createdAt,
      }));

      return res.json({ messages: formattedMessages });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Send a manual message
   */
  async sendMessage(req: Request, res: Response) {
    try {
      const { to, message, customerId } = req.body;
      if (!to || !message) return res.status(400).json({ error: 'to and message are required' });

      await whatsappService.sendMessage(to, message);

      // Save to DB
      await prisma.message.create({
        data: {
          content: message,
          platform: 'whatsapp',
          direction: 'outbound',
          customerId: customerId || to,
          handledBy: 'human'
        }
      });

      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get WhatsApp settings
   */
  async getSettings(req: Request, res: Response) {
    return res.json({
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: '********', // Hide token
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
      webhookUrl: `${process.env.BASE_URL || ''}/webhooks/whatsapp`
    });
  }
}

export const whatsappController = new WhatsAppController();

import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';
import { whatsappService } from '../services/messaging/whatsapp.service';
import * as messageDebouncer from '../services/messaging/debounce.service';
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
          const msgId = message.id;
          const msgType = message.type; // 'text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', etc.

          // 1. Check for Duplicate Message (Deduplication) - before anything else,
          // so retried webhook deliveries for non-text messages don't re-trigger a reply.
          const existingMessage = await prisma.message.findFirst({
            where: { externalId: msgId }
          });

          if (existingMessage) {
            console.log(`Duplicate message received (${msgId}), skipping.`);
            return res.sendStatus(200);
          }

          // 2. Resolve the message content. Non-text messages (images, voice notes,
          // documents, locations, etc.) don't have a `.text.body` - previously these
          // were silently dropped with no reply at all, leaving the customer thinking
          // the bot was broken. Now they get an acknowledgment instead of silence.
          const NON_TEXT_LABELS: Record<string, string> = {
            image: 'an image',
            video: 'a video',
            audio: 'a voice note',
            document: 'a document',
            sticker: 'a sticker',
            location: 'a location',
            contacts: 'a contact card',
          };
          const isNonText = msgType !== 'text';
          const msgBody = isNonText
            ? `[Customer sent ${NON_TEXT_LABELS[msgType] || 'a message'} - not yet supported by the AI]`
            : (message.text?.body || '');

          if (!isNonText && !msgBody) {
            return res.sendStatus(200);
          }

          console.log(`WhatsApp message from ${from} (${msgType}): ${msgBody}`);

          // 2. Ensure Customer exists and Save Inbound Message
          let customer = await prisma.customer.findUnique({ where: { id: from } });
          if (!customer) {
            customer = await prisma.customer.create({
              data: {
                id: from,
                name: 'WhatsApp User',
                phone: from,
                whatsappId: from,
              }
            });
          } else if (!customer.phone || !customer.whatsappId) {
            // Legacy customer rows were created without phone/whatsappId in some
            // flows. Backfill these fields whenever we receive a new inbound
            // WhatsApp message so profile details are no longer blank.
            customer = await prisma.customer.update({
              where: { id: from },
              data: {
                phone: customer.phone || from,
                whatsappId: customer.whatsappId || from,
              }
            });
          }

          try {
            await prisma.message.create({
              data: {
                content: msgBody,
                platform: 'whatsapp',
                direction: 'inbound',
                customerId: from,
                externalId: msgId
              }
            });
          } catch (e: any) {
            // Backup for the dedup check above: two near-simultaneous webhook
            // deliveries for the same message (a common retry pattern) could
            // both pass the check-then-create race window before either
            // finishes writing. externalId is @unique, so the loser here just
            // means it was already handled - safe to drop.
            if (e.code === 'P2002') {
              console.log(`Duplicate message race condition caught (${msgId}), skipping.`);
              return res.sendStatus(200);
            }
            throw e;
          }

          await whatsappService.markAsRead(msgId);

          if (isNonText) {
            // Non-text messages skip the AI/RAG pipeline entirely - there's nothing
            // meaningful for it to reason about - and get a fixed acknowledgment
            // right away instead of silence.
            const reply = "Thanks for sending that! I can only read text messages right now, but I've saved it and one of our team members will take a look. Feel free to type out your question in the meantime and I'll answer right away.";
            await prisma.message.create({
              data: { content: reply, platform: 'whatsapp', direction: 'outbound', customerId: from, handledBy: 'system' }
            });
            await whatsappService.sendMessage(from, reply);
          } else {
            // Debounce: if the customer sends several messages in quick succession,
            // wait for them to pause before running the AI once on the whole burst,
            // instead of firing a separate disjointed reply per message.
            messageDebouncer.scheduleTurn(from, () => this.processPendingTurn(from));
          }
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
   * Runs after a customer has paused sending messages (see debounce.service.ts).
   * Gathers every inbound message received since the last reply - which may be
   * more than one if they sent a burst - and processes them as a single turn.
   */
  private async processPendingTurn(customerId: string): Promise<void> {
    try {
      const lastOutbound = await prisma.message.findFirst({
        where: { customerId, platform: 'whatsapp', direction: 'outbound' },
        orderBy: { createdAt: 'desc' }
      });

      const pendingInbound = await prisma.message.findMany({
        where: {
          customerId,
          platform: 'whatsapp',
          direction: 'inbound',
          ...(lastOutbound ? { createdAt: { gt: lastOutbound.createdAt } } : {})
        },
        orderBy: { createdAt: 'asc' }
      });

      if (pendingInbound.length === 0) return; // nothing unresponded - shouldn't normally happen

      const combinedMessage = pendingInbound.map(m => m.content).join('\n');

      const recentMessages = await prisma.message.findMany({
        where: { customerId, createdAt: { lt: pendingInbound[0].createdAt } },
        orderBy: { createdAt: 'desc' },
        take: 10
      });
      const history = recentMessages.reverse().map(m => ({
        role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content
      }));

      // handleMessage never throws - on any internal failure (provider error,
      // circuit open, rate limited) it resolves to a safe fallback string,
      // logged distinctly in AiJobMetric.
      const aiReply = await agentService.handleMessage(customerId, combinedMessage, history, 'whatsapp');

      await prisma.message.create({
        data: { content: aiReply, platform: 'whatsapp', direction: 'outbound', customerId, handledBy: 'ai' }
      });

      await whatsappService.sendMessage(customerId, aiReply);
    } catch (error: any) {
      console.error('Error processing debounced WhatsApp turn:', error);
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

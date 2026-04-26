import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';
import { instagramService } from '../services/messaging/instagram.service';
import prisma from '../config/prisma';
import dotenv from 'dotenv';

dotenv.config();

const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'socialresponder2025';

export class InstagramController {
  
  /**
   * Webhook Verification (GET)
   */
  verifyWebhook(req: Request, res: Response) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Instagram Webhook Verified!');
      return res.status(200).send(challenge);
    } else {
      console.error('Instagram Verification Failed. Token mismatch.');
      return res.sendStatus(403);
    }
  }

  /**
   * Handle Incoming Messages (POST)
   */
  async handleWebhook(req: Request, res: Response) {
    try {
      const body = req.body;

      // Check if it's an Instagram event
      if (body.object === 'instagram') {
        if (body.entry && body.entry.length > 0) {
          for (const entry of body.entry) {
            if (entry.messaging && entry.messaging.length > 0) {
              for (const event of entry.messaging) {
                // We only care about message events
                if (event.message && !event.message.is_echo) {
                  const senderId = event.sender.id; // Instagram scoped user ID
                  const msgBody = event.message.text;
                  const msgId = event.message.mid;

                  if (!msgBody) continue;

                  console.log(`Instagram message from ${senderId}: ${msgBody}`);

                  // 1. Check for Duplicate Message (Deduplication)
                  const existingMessage = await prisma.message.findFirst({
                    where: { externalId: msgId }
                  });

                  if (existingMessage) {
                    console.log(`Duplicate message received (${msgId}), skipping.`);
                    continue;
                  }

                  // 2. Ensure Customer exists
                  let customer = await prisma.customer.findFirst({ 
                    where: { instagramId: senderId } 
                  });
                  
                  if (!customer) {
                    customer = await prisma.customer.create({ 
                      data: { 
                        instagramId: senderId, 
                        name: 'Instagram User',
                        // Note: Prisma will auto-generate the CUID for the 'id' field
                      } 
                    });
                  }

                  // 3. Save Inbound Message
                  try {
                    await prisma.message.create({
                      data: {
                        content: msgBody,
                        platform: 'instagram',
                        direction: 'inbound',
                        customerId: customer.id,
                        externalId: msgId
                      }
                    });
                  } catch (e: any) {
                    if (e.code === 'P2002') {
                      console.log(`Duplicate message race condition caught (${msgId}), skipping.`);
                      continue;
                    }
                    throw e;
                  }

                  // 4. Load recent history (last 10 messages)
                  const recentMessages = await prisma.message.findMany({
                    where: { customerId: customer.id },
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                    skip: 1 // Skip the message we just saved
                  });

                  // Format for OpenAI (reverse because we took 'desc')
                  const history = recentMessages.reverse().map(m => ({
                    role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: m.content
                  }));

                  // 5. Mark as read
                  await instagramService.markAsRead(senderId);

                  // 6. Get AI Response with history
                  const aiReply = await agentService.handleMessage(customer.id, msgBody, history, 'instagram');

                  // 7. Save Outbound Message
                  await prisma.message.create({
                    data: {
                      content: aiReply,
                      platform: 'instagram',
                      direction: 'outbound',
                      customerId: customer.id,
                      handledBy: 'ai'
                    }
                  });

                  // 8. Send reply back to Instagram
                  await instagramService.sendMessage(senderId, aiReply);
                }
              }
            }
          }
        }
        return res.sendStatus(200);
      } else {
        // Not an Instagram event
        return res.sendStatus(404);
      }
    } catch (error: any) {
      console.error('Error handling Instagram webhook:', error);
      if (error.response) {
        console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
      }
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Instagram Dashboard Stats
   */
  async getStats(req: Request, res: Response) {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [
        totalMessages,
        activeConversations,
        messagesThisMonth,
        messagesThisWeek,
        inboundMessages,
        outboundMessages,
        recentMessages
      ] = await Promise.all([
        prisma.message.count({ where: { platform: 'instagram' } }),
        prisma.message.groupBy({
          by: ['customerId'],
          where: { platform: 'instagram', createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        }).then(res => res.length),
        prisma.message.count({ where: { platform: 'instagram', createdAt: { gte: thirtyDaysAgo } } }),
        prisma.message.count({ where: { platform: 'instagram', createdAt: { gte: sevenDaysAgo } } }),
        prisma.message.count({ where: { platform: 'instagram', direction: 'inbound' } }),
        prisma.message.count({ where: { platform: 'instagram', direction: 'outbound' } }),
        prisma.message.findMany({
          where: { platform: 'instagram', createdAt: { gte: sevenDaysAgo } },
          select: { createdAt: true }
        })
      ]);

      // Calculate messages by day for the last 7 days
      const messagesByDay = Array.from({ length: 7 }).map((_, i) => {
        const d = new Date(now.getTime() - (6 - i) * 24 * 60 * 60 * 1000);
        return {
          date: d.toLocaleDateString('en-US', { weekday: 'short' }),
          count: 0
        };
      });

      recentMessages.forEach(msg => {
        const d = new Date(msg.createdAt).toLocaleDateString('en-US', { weekday: 'short' });
        const day = messagesByDay.find(m => m.date === d);
        if (day) day.count++;
      });

      // Find top customers
      const topCustomerIds = await prisma.message.groupBy({
        by: ['customerId'],
        where: { platform: 'instagram' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5
      });

      const topCustomers = await Promise.all(
        topCustomerIds.map(async (tc) => {
          const cust = await prisma.customer.findUnique({ where: { id: tc.customerId } });
          return {
            name: cust?.name || 'Unknown',
            messageCount: tc._count.id
          };
        })
      );

      return res.json({
        totalMessages,
        activeConversations,
        avgResponseTime: 45, // Mocked average response time
        messagesThisMonth,
        messagesThisWeek,
        inboundMessages,
        outboundMessages,
        messagesByDay,
        topCustomers
      });
    } catch (error: any) {
      console.error('Error fetching Instagram stats:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all conversations (latest message per customer)
   */
  async getConversations(req: Request, res: Response) {
    try {
      const customers = await prisma.customer.findMany({
        where: {
          instagramId: {
            not: null
          }
        },
        include: {
          messages: {
            where: { platform: 'instagram' },
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
          platformId: c.instagramId,
          latestMessage: c.messages[0].content,
          latestTimestamp: c.messages[0].createdAt,
          unreadCount: 0,
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
        where: { 
          customerId: customerId as string,
          platform: 'instagram'
        },
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

      await instagramService.sendMessage(to, message);

      // Save to DB
      await prisma.message.create({
        data: {
          content: message,
          platform: 'instagram',
          direction: 'outbound',
          customerId: customerId, // Should be the Prisma Customer ID
          handledBy: 'human'
        }
      });

      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Instagram settings
   */
  async getSettings(req: Request, res: Response) {
    return res.json({
      accessToken: '********', // Hide token
      verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN,
      webhookUrl: `${process.env.BASE_URL || ''}/webhooks/instagram`
    });
  }
}

export const instagramController = new InstagramController();

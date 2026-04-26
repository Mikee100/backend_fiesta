import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { whatsappService } from '../services/messaging/whatsapp.service';
import { instagramService } from '../services/messaging/instagram.service';

export class ConversationController {
  
  /**
   * Get all conversations across platforms or filtered by platform
   */
  async getAllConversations(req: Request, res: Response) {
    try {
      const { platform } = req.query;

      // Filter by platform if provided
      const platformFilter = platform ? { equals: String(platform) } : undefined;

      // Get all customers who have messages
      const customers = await prisma.customer.findMany({
        where: platformFilter ? {
          messages: {
            some: {
              platform: platformFilter
            }
          }
        } : {
          messages: {
            some: {}
          }
        },
        include: {
          messages: {
            where: platformFilter ? { platform: platformFilter } : undefined,
            orderBy: { createdAt: 'desc' },
            take: 1, // Get the latest message
          },
          _count: {
            select: { messages: true }
          }
        }
      });

      const now = new Date();
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

      const conversations = customers
        .filter(c => c.messages.length > 0)
        .map(c => {
          const lastMessage = c.messages[0];
          // Determine if chat is currently active (last message within 24 hours)
          const isActive = (now.getTime() - new Date(lastMessage.createdAt).getTime()) < TWENTY_FOUR_HOURS;
          
          return {
            id: c.id, // Frontend expects customerId as 'id'
            name: c.name,
            phone: c.phone || undefined,
            whatsappId: c.whatsappId || undefined,
            instagramId: c.instagramId || undefined,
            messengerId: c.messengerId || undefined,
            platform: lastMessage.platform,
            lastMessage: lastMessage.content,
            lastMessageAt: lastMessage.createdAt,
            lastMessageDirection: lastMessage.direction,
            messageCount: c._count.messages,
            isActive: isActive
          };
        })
        .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

      return res.json(conversations);
    } catch (error: any) {
      console.error('Error fetching conversations:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get a single conversation details
   */
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const customer = await prisma.customer.findUnique({
        where: { id }
      });
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      return res.json(customer);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all messages for a specific conversation
   */
  async getConversationMessages(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { platform } = req.query;

      const platformFilter = platform ? { equals: String(platform) } : undefined;

      const messages = await prisma.message.findMany({
        where: {
          customerId: id,
          ...(platformFilter && { platform: platformFilter })
        },
        orderBy: { createdAt: 'asc' }
      });

      return res.json(messages);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Send a manual reply from the dashboard
   */
  async sendReply(req: Request, res: Response) {
    try {
      const { id } = req.params; // Customer ID
      const { message, platform } = req.body;

      if (!message || !platform) {
        return res.status(400).json({ error: 'message and platform are required' });
      }

      const customer = await prisma.customer.findUnique({ where: { id } });
      if (!customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      let externalMessageId = '';

      // Route the message to the correct platform service
      if (platform === 'whatsapp') {
        const to = customer.whatsappId || customer.phone;
        if (!to) return res.status(400).json({ error: 'Customer has no WhatsApp ID or Phone' });
        
        await whatsappService.sendTextMessage(to, message);
      } 
      else if (platform === 'instagram') {
        const to = customer.instagramId;
        if (!to) return res.status(400).json({ error: 'Customer has no Instagram ID' });
        
        const response = await instagramService.sendMessage(to, message);
        if (response && response.message_id) {
          externalMessageId = response.message_id;
        }
      }
      else {
        return res.status(400).json({ error: `Sending to platform '${platform}' is not supported yet` });
      }

      // Save the outbound message to the database
      const dbMessage = await prisma.message.create({
        data: {
          content: message,
          platform: String(platform),
          direction: 'outbound',
          customerId: id,
          handledBy: 'human',
          ...(externalMessageId ? { externalId: externalMessageId } : {})
        }
      });

      return res.json(dbMessage);
    } catch (error: any) {
      console.error('Error sending reply:', error);
      return res.status(500).json({ error: error.message });
    }
  }
}

export const conversationController = new ConversationController();

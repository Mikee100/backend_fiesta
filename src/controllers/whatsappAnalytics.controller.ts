import { Request, Response } from 'express';
import prisma from '../config/prisma';
import dayjs from 'dayjs';
import { scoreSentiment } from '../services/agent/resilience.service';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

const TOPICS: { name: string; keywords: string[] }[] = [
  { name: 'Pricing', keywords: ['price', 'cost', 'ksh', 'deposit', 'pay', 'expensive', 'afford', 'money'] },
  { name: 'Booking', keywords: ['book', 'date', 'time', 'appointment', 'schedule', 'slot', 'available', 'reschedule', 'cancel'] },
  { name: 'Location', keywords: ['where', 'location', 'address', 'studio', 'parking', 'direction', 'parklands', 'diamond plaza'] },
  { name: 'Service Quality', keywords: ['makeup', 'styling', 'photo', 'quality', 'professional', 'outfit', 'wig', 'backdrop'] },
];

function classifyTopic(content: string): string {
  const lower = content.toLowerCase();
  for (const topic of TOPICS) {
    if (topic.keywords.some(kw => lower.includes(kw))) return topic.name;
  }
  return 'Other';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'but', 'if', 'do', 'does', 'did', 'have', 'has', 'had',
  'my', 'your', 'me', 'us', 'this', 'that', 'these', 'those', 'can', 'will', 'would', 'should', 'could', 'what',
  'when', 'how', 'so', 'not', 'just', 'about', 'im', "i'm", 'yes', 'no', 'ok', 'okay', 'hi', 'hello', 'thanks',
  'thank', 'please', 'want', 'need', 'get', 'got', 'like', 'also', 'there', 'here', 'am', 'as', 'by', 'up', 'out',
]);

function extractKeywords(texts: string[], topN: number): { keyword: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (word.length < 4 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([keyword, count]) => ({ keyword, count }));
}

export class WhatsAppAnalyticsController {
  async getTotalCustomers(req: Request, res: Response) {
    try {
      const rows = await prisma.message.findMany({ where: { platform: 'whatsapp' }, select: { customerId: true }, distinct: ['customerId'] });
      return res.json(rows.length);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getTotalInboundMessages(req: Request, res: Response) {
    try {
      const count = await prisma.message.count({ where: { platform: 'whatsapp', direction: 'inbound' } });
      return res.json(count);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getTotalOutboundMessages(req: Request, res: Response) {
    try {
      const count = await prisma.message.count({ where: { platform: 'whatsapp', direction: 'outbound' } });
      return res.json(count);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getPeakChatHours(req: Request, res: Response) {
    try {
      const messages = await prisma.message.findMany({ where: { platform: 'whatsapp', direction: 'inbound' }, select: { createdAt: true } });
      const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
      for (const m of messages) buckets[dayjs(m.createdAt).hour()].count++;
      return res.json(buckets);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getPeakChatDays(req: Request, res: Response) {
    try {
      const messages = await prisma.message.findMany({ where: { platform: 'whatsapp', direction: 'inbound' }, select: { createdAt: true } });
      const counts = new Array(7).fill(0);
      for (const m of messages) counts[dayjs(m.createdAt).day()]++;
      const buckets = WEEK_ORDER.map(i => ({ day: DAY_NAMES[i], count: counts[i] }));
      return res.json(buckets);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getBookingConversionRate(req: Request, res: Response) {
    try {
      const waCustomers = await prisma.message.findMany({ where: { platform: 'whatsapp' }, select: { customerId: true }, distinct: ['customerId'] });
      if (waCustomers.length === 0) return res.json(0);
      const waCustomerIds = waCustomers.map(c => c.customerId);
      const withBookings = await prisma.booking.findMany({ where: { customerId: { in: waCustomerIds } }, select: { customerId: true }, distinct: ['customerId'] });
      return res.json(withBookings.length / waCustomerIds.length);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getSentiment(req: Request, res: Response) {
    try {
      const messages = await prisma.message.findMany({ where: { platform: 'whatsapp', direction: 'inbound' }, select: { content: true } });
      let positive = 0, neutral = 0, negative = 0;
      for (const m of messages) {
        const { sentiment } = scoreSentiment(m.content);
        if (sentiment === 'positive' || sentiment === 'very_positive') positive++;
        else if (sentiment === 'negative' || sentiment === 'very_negative') negative++;
        else neutral++;
      }
      return res.json({ distribution: { positive, neutral, negative }, total: messages.length });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getSentimentTrend(req: Request, res: Response) {
    try {
      const sevenDaysAgo = dayjs().subtract(7, 'day').startOf('day');
      const messages = await prisma.message.findMany({
        where: { platform: 'whatsapp', direction: 'inbound', createdAt: { gte: sevenDaysAgo.toDate() } },
        select: { content: true, createdAt: true },
      });

      const buckets = new Map<string, { positive: number; neutral: number; negative: number }>();
      for (let i = 0; i < 7; i++) buckets.set(sevenDaysAgo.add(i, 'day').format('YYYY-MM-DD'), { positive: 0, neutral: 0, negative: 0 });

      for (const m of messages) {
        const day = dayjs(m.createdAt).format('YYYY-MM-DD');
        const bucket = buckets.get(day);
        if (!bucket) continue;
        const { sentiment } = scoreSentiment(m.content);
        if (sentiment === 'positive' || sentiment === 'very_positive') bucket.positive++;
        else if (sentiment === 'negative' || sentiment === 'very_negative') bucket.negative++;
        else bucket.neutral++;
      }

      return res.json(Array.from(buckets.entries()).map(([date, b]) => ({ date, ...b })));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getSentimentByTopic(req: Request, res: Response) {
    try {
      const messages = await prisma.message.findMany({ where: { platform: 'whatsapp', direction: 'inbound' }, select: { content: true } });
      const byTopic = new Map<string, { positive: number; neutral: number; negative: number }>();
      for (const topic of TOPICS) byTopic.set(topic.name, { positive: 0, neutral: 0, negative: 0 });
      byTopic.set('Other', { positive: 0, neutral: 0, negative: 0 });

      for (const m of messages) {
        const topic = classifyTopic(m.content);
        const { sentiment } = scoreSentiment(m.content);
        const bucket = byTopic.get(topic)!;
        if (sentiment === 'positive' || sentiment === 'very_positive') bucket.positive++;
        else if (sentiment === 'negative' || sentiment === 'very_negative') bucket.negative++;
        else bucket.neutral++;
      }

      return res.json(Array.from(byTopic.entries()).map(([topic, b]) => ({ topic, ...b })));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getMostExtremeMessages(req: Request, res: Response) {
    try {
      const messages = await prisma.message.findMany({
        where: { platform: 'whatsapp', direction: 'inbound' },
        select: { content: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 500, // cap the scan for cost - most recent 500 inbound messages is plenty for "recent extremes"
      });

      const scored = messages.map(m => ({ ...m, score: scoreSentiment(m.content).score }));
      const mostPositive = [...scored].sort((a, b) => b.score - a.score).filter(m => m.score > 0).slice(0, 3);
      const mostNegative = [...scored].sort((a, b) => a.score - b.score).filter(m => m.score < 0).slice(0, 3);

      return res.json({ mostPositive, mostNegative });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getKeywordTrends(req: Request, res: Response) {
    try {
      const messages = await prisma.message.findMany({
        where: { platform: 'whatsapp', direction: 'inbound' },
        select: { content: true },
        take: 1000,
        orderBy: { createdAt: 'desc' },
      });
      return res.json(extractKeywords(messages.map(m => m.content), 10));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  async getAgentAIPerformance(req: Request, res: Response) {
    try {
      const [aiCount, agentCount, aiJobs] = await Promise.all([
        prisma.message.count({ where: { platform: 'whatsapp', direction: 'outbound', handledBy: 'ai' } }),
        prisma.message.count({ where: { platform: 'whatsapp', direction: 'outbound', handledBy: 'human' } }),
        prisma.aiJobMetric.findMany({ where: { platform: 'whatsapp' }, select: { success: true } }),
      ]);

      const aiResolutionRate = aiJobs.length > 0
        ? Math.round((aiJobs.filter(j => j.success).length / aiJobs.length) * 100)
        : 0;

      // Sentiment of customers replied to by each handler, live-scored over their inbound messages
      const sentimentFor = async (handledBy: string) => {
        const customerIds = (await prisma.message.findMany({
          where: { platform: 'whatsapp', direction: 'outbound', handledBy },
          select: { customerId: true },
          distinct: ['customerId'],
        })).map(c => c.customerId);
        if (customerIds.length === 0) return 0;
        const inbound = await prisma.message.findMany({
          where: { platform: 'whatsapp', direction: 'inbound', customerId: { in: customerIds } },
          select: { content: true },
        });
        if (inbound.length === 0) return 0;
        const positive = inbound.filter(m => {
          const s = scoreSentiment(m.content).sentiment;
          return s === 'positive' || s === 'very_positive';
        }).length;
        return Math.round((positive / inbound.length) * 100);
      };

      const [aiSentiment, agentSentiment] = await Promise.all([sentimentFor('ai'), sentimentFor('human')]);

      return res.json({
        agent: { count: agentCount, resolutionRate: agentCount > 0 ? 100 : 0, sentiment: { positive: agentSentiment } },
        ai: { count: aiCount, resolutionRate: aiResolutionRate, sentiment: { positive: aiSentiment } },
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const whatsappAnalyticsController = new WhatsAppAnalyticsController();

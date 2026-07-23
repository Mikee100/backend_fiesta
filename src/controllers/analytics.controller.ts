import { Request, Response } from 'express';
import prisma from '../config/prisma';
import dayjs from 'dayjs';

export class AnalyticsController {

  /**
   * Get AI performance metrics from persisted observability data
   */
  async getAiPerformance(req: Request, res: Response) {
    try {
      const daysRaw = Number(req.query.days || 30);
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 180) : 30;
      const since = dayjs().subtract(days, 'day').toDate();

      const [jobMetrics, customerMemory, learningRows] = await Promise.all([
        prisma.aiJobMetric.findMany({
          where: { createdAt: { gte: since } },
          select: {
            latencyMs: true,
            success: true,
            isFallback: true,
          },
        }),
        prisma.customerMemory.aggregate({
          _avg: { satisfactionScore: true },
        }),
        prisma.conversationLearning.findMany({
          where: { createdAt: { gte: since } },
          select: {
            extractedIntent: true,
            wasSuccessful: true,
          },
        }),
      ]);

      const latencies = jobMetrics
        .map((m) => m.latencyMs)
        .filter((latency): latency is number => typeof latency === 'number' && Number.isFinite(latency));

      const avgLatency = latencies.length > 0
        ? Math.round(latencies.reduce((sum, current) => sum + current, 0) / latencies.length)
        : 0;

      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const p95 = sortedLatencies.length > 0
        ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))]
        : 0;

      const totalJobs = jobMetrics.length;
      const successfulJobs = jobMetrics.filter((m) => m.success).length;
      const fallbackJobs = jobMetrics.filter((m) => m.isFallback).length;

      const successRate = totalJobs > 0 ? (successfulJobs / totalJobs) * 100 : 0;
      const nonFallbackSuccessRate = totalJobs > 0
        ? ((jobMetrics.filter((m) => m.success && !m.isFallback).length) / totalJobs) * 100
        : 0;

      const intentAccumulator = new Map<string, { count: number; successful: number }>();
      for (const row of learningRows) {
        const key = row.extractedIntent || 'unknown';
        const current = intentAccumulator.get(key) || { count: 0, successful: 0 };
        current.count += 1;
        if (row.wasSuccessful) {
          current.successful += 1;
        }
        intentAccumulator.set(key, current);
      }

      const byIntent = Array.from(intentAccumulator.entries()).map(([intent, data]) => {
        const count = data.count;
        const successful = data.successful;
        return {
          intent,
          count,
          successRate: count > 0 ? Math.round((successful / count) * 10000) / 100 : 0,
        };
      });

      return res.json({
        responseTime: {
          average: avgLatency,
          p95: Math.round(p95),
        },
        accuracy: {
          successRate: Math.round(successRate * 100) / 100,
          sampleSize: totalJobs,
        },
        userSatisfaction: {
          averageRating: customerMemory._avg.satisfactionScore ? Math.round(customerMemory._avg.satisfactionScore * 100) / 100 : 0,
        },
        efficiency: {
          cacheHitRate: Math.round(nonFallbackSuccessRate * 100) / 100,
          fallbackRate: totalJobs > 0 ? Math.round((fallbackJobs / totalJobs) * 10000) / 100 : 0,
        },
        byIntent,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get personalization effectiveness metrics from learning data
   */
  async getPersonalizedResponses(req: Request, res: Response) {
    try {
      const daysRaw = Number(req.query.days || 30);
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 180) : 30;
      const since = dayjs().subtract(days, 'day').toDate();

      const [learningAggregate, learningCount, successfulConversations, styleBreakdown] = await Promise.all([
        prisma.conversationLearning.aggregate({
          where: { createdAt: { gte: since } },
          _avg: { timeToResolution: true },
        }),
        prisma.conversationLearning.count({
          where: { createdAt: { gte: since } },
        }),
        prisma.conversationLearning.count({
          where: {
            createdAt: { gte: since },
            wasSuccessful: true,
          },
        }),
        prisma.customerMemory.groupBy({
          by: ['communicationStyle'],
          _count: { id: true },
          where: {
            communicationStyle: { not: null },
          },
        }),
      ]);

      const byCommunicationStyle = styleBreakdown.map((row) => ({
        style: row.communicationStyle || 'unknown',
        customers: row._count.id,
      }));

      return res.json({
        totalPersonalizedConversations: learningCount,
        overallSuccessRate: learningCount > 0 ? Math.round((successfulConversations / learningCount) * 10000) / 100 : 0,
        averageTimeToResolution: learningAggregate._avg.timeToResolution ? Math.round(learningAggregate._avg.timeToResolution) : 0,
        byCommunicationStyle,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Get booking counts by status
   */
  async getBookingStatusCounts(req: Request, res: Response) {
    try {
      const counts = await prisma.booking.groupBy({
        by: ['status'],
        _count: {
          id: true
        }
      });

      const formatted = {
        confirmed: 0,
        provisional: 0,
        cancelled: 0
      };

      counts.forEach(c => {
        if (c.status === 'confirmed') formatted.confirmed = c._count.id;
        if (c.status === 'provisional') formatted.provisional = c._count.id;
        if (c.status === 'cancelled') formatted.cancelled = c._count.id;
      });

      return res.json(formatted);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get total revenue
   */
  async getRevenue(req: Request, res: Response) {
    try {
      const confirmedBookings = await prisma.booking.findMany({
        where: { status: 'confirmed' }
      });

      const packagePrices: Record<string, number> = {
        'standard': 10000, 'economy': 15000, 'executive': 20000, 
        'gold': 30000, 'platinum': 35000, 'vip': 45000, 'vvip': 50000
      };

      const totalRevenue = confirmedBookings.reduce((sum, b) => {
        const serviceKey = Object.keys(packagePrices).find(k => b.service.toLowerCase().includes(k)) || 'standard';
        return sum + (packagePrices[serviceKey] || 0);
      }, 0);

      return res.json({ total: totalRevenue });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Business KPIs
   */
  /**
   * Get Business KPIs matched to frontend BusinessKPIs interface
   */
  async getBusinessKpis(req: Request, res: Response) {
    try {
      const totalCustomers = await prisma.customer.count();
      const bookings = await prisma.booking.findMany({ where: { status: 'confirmed' } });
      const totalBookings = bookings.length;
      
      const packagePrices: Record<string, number> = {
        'standard': 10000, 'economy': 15000, 'executive': 20000, 
        'gold': 30000, 'platinum': 35000, 'vip': 45000, 'vvip': 50000
      };

      const totalRevenue = bookings.reduce((sum, b) => {
        const serviceKey = Object.keys(packagePrices).find(k => b.service.toLowerCase().includes(k)) || 'standard';
        return sum + (packagePrices[serviceKey] || 0);
      }, 0);

      // Popular Packages
      const packageCounts: Record<string, number> = {};
      bookings.forEach(b => {
        const serviceKey = Object.keys(packagePrices).find(k => b.service.toLowerCase().includes(k)) || 'standard';
        packageCounts[serviceKey] = (packageCounts[serviceKey] || 0) + 1;
      });
      const popularPackages = Object.entries(packageCounts)
        .map(([pkg, count]) => ({ package: pkg, bookings: count }))
        .sort((a, b) => b.bookings - a.bookings);

      // Customer metrics
      const customersWithBookings = await prisma.customer.count({
        where: { bookings: { some: {} } }
      });

      const startOfMonth = dayjs().startOf('month').toDate();
      const newCustomersThisMonth = await prisma.customer.count({
        where: { createdAt: { gte: startOfMonth } }
      });

      return res.json({
        revenue: {
          total: totalRevenue,
          count: totalBookings
        },
        avgBookingValue: totalBookings > 0 ? totalRevenue / totalBookings : 0,
        conversionRate: {
          rate: totalCustomers > 0 ? (customersWithBookings / totalCustomers) * 100 : 0,
          totalCustomers,
          convertedCustomers: customersWithBookings
        },
        popularPackages: popularPackages.slice(0, 5),
        customerMetrics: {
          totalCustomers,
          customersWithBookings,
          repeatCustomers: 0, // Simplified
          repeatRate: 0,
          newCustomersThisMonth,
          clv: totalCustomers > 0 ? totalRevenue / totalCustomers : 0
        },
        period: {
          start: dayjs().subtract(1, 'month').toDate(),
          end: new Date()
        }
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Active Users Stats
   */
  async getActiveUsers(req: Request, res: Response) {
    try {
      return res.json({
        daily: await prisma.customer.count({ where: { updatedAt: { gte: dayjs().subtract(1, 'day').toDate() } } }),
        weekly: await prisma.customer.count({ where: { updatedAt: { gte: dayjs().subtract(7, 'day').toDate() } } }),
        monthly: await prisma.customer.count({ where: { updatedAt: { gte: dayjs().subtract(30, 'day').toDate() } } })
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Engaged Customers
   */
  async getEngagedCustomers(req: Request, res: Response) {
    try {
      const customers = await prisma.customer.findMany({
        take: 10,
        include: { _count: { select: { messages: true, bookings: true } } },
        orderBy: { messages: { _count: 'desc' } }
      });
      return res.json(customers);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Package Popularity
   */
  async getPackagePopularity(req: Request, res: Response) {
    try {
      const bookings = await prisma.booking.groupBy({
        by: ['service'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } }
      });

      const formatted = bookings.map(b => ({
        name: b.service,
        value: b._count.id
      }));

      return res.json(formatted);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get monthly revenue (MonthlyRevenue interface)
   */
  async getMonthlyRevenue(req: Request, res: Response) {
    try {
      const year = dayjs().year();
      const bookings = await prisma.booking.findMany({
        where: {
          status: 'confirmed',
          dateTime: {
            gte: dayjs(`${year}-01-01`).toDate(),
            lte: dayjs(`${year}-12-31`).toDate()
          }
        }
      });

      const packagePrices: Record<string, number> = {
        'standard': 10000, 'economy': 15000, 'executive': 20000, 
        'gold': 30000, 'platinum': 35000, 'vip': 45000, 'vvip': 50000
      };

      const monthlyData: Record<string, { revenue: number, bookings: number }> = {};
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      months.forEach(m => monthlyData[m] = { revenue: 0, bookings: 0 });

      bookings.forEach(b => {
        const month = dayjs(b.dateTime).format('MMM');
        const serviceKey = Object.keys(packagePrices).find(k => b.service.toLowerCase().includes(k)) || 'standard';
        monthlyData[month].revenue += packagePrices[serviceKey] || 0;
        monthlyData[month].bookings += 1;
      });

      const formatted = Object.entries(monthlyData).map(([month, data]) => ({ 
        month, 
        revenue: data.revenue,
        bookings: data.bookings
      }));
      return res.json(formatted);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get revenue by package (RevenueByPackage interface)
   */
  async getRevenueByPackage(req: Request, res: Response) {
    try {
      const bookings = await prisma.booking.findMany({ where: { status: 'confirmed' } });
      
      const packagePrices: Record<string, number> = {
        'standard': 10000, 'economy': 15000, 'executive': 20000, 
        'gold': 30000, 'platinum': 35000, 'vip': 45000, 'vvip': 50000
      };

      const stats: Record<string, { revenue: number, bookings: number }> = {};
      
      bookings.forEach(b => {
        const serviceKey = Object.keys(packagePrices).find(k => b.service.toLowerCase().includes(k)) || 'standard';
        if (!stats[serviceKey]) stats[serviceKey] = { revenue: 0, bookings: 0 };
        stats[serviceKey].revenue += packagePrices[serviceKey] || 0;
        stats[serviceKey].bookings += 1;
      });

      const formatted = Object.entries(stats).map(([pkg, data]) => ({
        package: pkg,
        revenue: data.revenue,
        bookings: data.bookings,
        avgValue: data.bookings > 0 ? data.revenue / data.bookings : 0
      }));
      return res.json(formatted);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get seasonal trends (SeasonalTrend interface)
   */
  async getSeasonalTrends(req: Request, res: Response) {
    try {
      const currentYear = dayjs().year();
      const lastYear = currentYear - 1;
      
      const bookings = await prisma.booking.findMany({
        where: {
          status: 'confirmed',
          dateTime: {
            gte: dayjs(`${lastYear}-01-01`).toDate()
          }
        }
      });

      const trends: Record<string, { currentYear: number, lastYear: number }> = {};
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      months.forEach(m => trends[m] = { currentYear: 0, lastYear: 0 });

      bookings.forEach(b => {
        const date = dayjs(b.dateTime);
        const month = date.format('MMM');
        const year = date.year();
        
        if (year === currentYear) trends[month].currentYear += 1;
        else if (year === lastYear) trends[month].lastYear += 1;
      });

      const formatted = Object.entries(trends).map(([month, data]) => ({
        month,
        currentYear: data.currentYear,
        lastYear: data.lastYear
      }));
      return res.json(formatted);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Sentiment Analysis Stats
   */
  async getSentimentAnalysis(req: Request, res: Response) {
    try {
      const thirtyDaysAgo = dayjs().subtract(30, 'day').toDate();
      const scores = await prisma.sentimentScore.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        include: { customer: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });

      const distribution = {
        very_positive: scores.filter(s => s.sentiment === 'very_positive').length,
        positive: scores.filter(s => s.sentiment === 'positive').length,
        neutral: scores.filter(s => s.sentiment === 'neutral').length,
        negative: scores.filter(s => s.sentiment === 'negative').length,
        very_negative: scores.filter(s => s.sentiment === 'very_negative').length,
      };

      // Group by day for the last 7 days
      const sevenDaysAgo = dayjs().subtract(7, 'day').startOf('day');
      const trendMap = new Map<string, { positive: number; neutral: number; negative: number; total: number; scoreSum: number }>();
      for (let i = 0; i < 7; i++) {
        trendMap.set(sevenDaysAgo.add(i, 'day').format('YYYY-MM-DD'), { positive: 0, neutral: 0, negative: 0, total: 0, scoreSum: 0 });
      }
      for (const s of scores) {
        const day = dayjs(s.createdAt).format('YYYY-MM-DD');
        const bucket = trendMap.get(day);
        if (!bucket) continue;
        bucket.total++;
        bucket.scoreSum += s.score;
        if (s.sentiment === 'positive' || s.sentiment === 'very_positive') bucket.positive++;
        else if (s.sentiment === 'negative' || s.sentiment === 'very_negative') bucket.negative++;
        else bucket.neutral++;
      }
      const recentTrends = Array.from(trendMap.entries()).map(([date, b]) => ({
        date,
        positive: b.positive,
        neutral: b.neutral,
        negative: b.negative,
        avgScore: b.total > 0 ? b.scoreSum / b.total : 0,
      }));

      // Customers whose most recent sentiment reading is negative/very_negative
      const latestByCustomer = new Map<string, typeof scores[number]>();
      for (const s of scores) latestByCustomer.set(s.customerId, s); // scores is ascending, so last write wins = most recent
      const customersNeedingAttention = Array.from(latestByCustomer.values())
        .filter(s => s.sentiment === 'negative' || s.sentiment === 'very_negative')
        .map(s => ({ customerId: s.customerId, name: s.customer?.name || 'Unknown', score: s.score, sentiment: s.sentiment }));

      return res.json({
        total: scores.length,
        averageScore: scores.length > 0 ? scores.reduce((a, b) => a + b.score, 0) / scores.length : 0,
        distribution: {
          ...distribution,
          percentages: {
            positive: scores.length > 0 ? ((distribution.positive + distribution.very_positive) / scores.length) * 100 : 0
          }
        },
        recentTrends,
        customersNeedingAttention
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const analyticsController = new AnalyticsController();

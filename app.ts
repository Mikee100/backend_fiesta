import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import chatRoutes from './src/routes/chat.routes';
import whatsappRoutes from './src/routes/whatsapp.routes';
import instagramRoutes from './src/routes/instagram.routes';
import bookingRoutes from './src/routes/booking.routes';
import { calendarController } from './src/controllers/calendar.controller';
import { customerController } from './src/controllers/customer.controller';
import paymentRoutes from './src/routes/payment.routes';
import customerRoutes from './src/routes/customer.routes';
import conversationRoutes from './src/routes/conversation.routes';
import invoiceRoutes from './src/routes/invoice.routes';
import { analyticsController } from './src/controllers/analytics.controller';
import { whatsappAnalyticsController } from './src/controllers/whatsappAnalytics.controller';
import prisma from './src/config/prisma';
import { cronService } from './src/services/automation/cron.service';
import { notificationEvents } from './src/services/notifications/notification.service';
import dotenv from 'dotenv';
import { validateStartupEnv } from './src/config/env-validation';

// Load .env only if it exists (for local dev)
dotenv.config();

// Fail fast on invalid startup configuration
validateStartupEnv();

console.log('📝 Diagnostic Info:');
console.log('🔹 Node Version:', process.version);
console.log('🔹 Platform:', process.platform);
if (process.env.DATABASE_URL) {
  console.log('🔹 DATABASE_URL is present');
  const maskedUrl = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
  console.log('📡 Using URL:', maskedUrl);
} else {
  console.warn('⚠️ WARNING: DATABASE_URL is missing!');
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', 
    methods: ['GET', 'POST']
  }
});

const unreadCountCache = {
  value: 0,
  expiresAt: 0,
};

const unreadCountTtlMs = 5000;

const invalidateUnreadCountCache = () => {
  unreadCountCache.expiresAt = 0;
};

const getUnreadNotificationCount = async (): Promise<number> => {
  const now = Date.now();
  if (now < unreadCountCache.expiresAt) {
    return unreadCountCache.value;
  }

  const count = await prisma.notification.count({ where: { read: false } });
  unreadCountCache.value = count;
  unreadCountCache.expiresAt = now + unreadCountTtlMs;
  return count;
};

// Middleware
app.use(cors());
// Captures the raw request body alongside the parsed JSON - needed to verify
// Meta's X-Hub-Signature-256 webhook signature, which is computed over the raw bytes.
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf; }
}));

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // The dashboard (Navbar, MessengerPage, etc.) already emits 'join' with a
  // platform name on connect, expecting to be put in that room - this was
  // never actually handled server-side, so those joins were silently no-ops.
  socket.on('join', ({ platform }: { platform?: string }) => {
    if (platform) socket.join(platform);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Forward notifications (e.g. escalations) created anywhere in the backend to
// admin dashboard clients in real time. Event name matches what Navbar.tsx
// already listens for.
notificationEvents.on('notification', (notification) => {
  io.to('admin').emit('newNotification', notification);
  void (async () => {
    try {
      invalidateUnreadCountCache();
      const count = await getUnreadNotificationCount();
      io.to('admin').emit('notificationCountUpdate', { count });
    } catch (err) {
      console.error('Failed to emit notificationCountUpdate:', err);
    }
  })();
});

// Attach io to request for use in controllers
app.use((req: any, _res, next) => {
  req.io = io;
  next();
});

// Main Routes
app.use('/api', chatRoutes);
app.use('/webhooks/whatsapp', whatsappRoutes);
app.use('/webhooks/instagram', instagramRoutes);
app.use('/api/whatsapp', whatsappRoutes); 
app.use('/api/instagram', instagramRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/mpesa', paymentRoutes);

// Calendar Routes
app.get('/api/calendar/events', calendarController.getEvents.bind(calendarController));
app.post('/api/calendar/sync', calendarController.sync.bind(calendarController));

// Analytics Routes
app.get('/api/analytics/booking-status-counts', analyticsController.getBookingStatusCounts.bind(analyticsController));
app.get('/api/analytics/revenue', analyticsController.getRevenue.bind(analyticsController));
app.get('/api/analytics/business-kpis', analyticsController.getBusinessKpis.bind(analyticsController));
app.get('/api/analytics/monthly-revenue', analyticsController.getMonthlyRevenue.bind(analyticsController));
app.get('/api/analytics/revenue-by-package', analyticsController.getRevenueByPackage.bind(analyticsController));
app.get('/api/analytics/seasonal-trends', analyticsController.getSeasonalTrends.bind(analyticsController));

// WhatsApp Channel Analytics Routes
app.get('/api/analytics/total-whatsapp-customers', whatsappAnalyticsController.getTotalCustomers.bind(whatsappAnalyticsController));
app.get('/api/analytics/total-inbound-whatsapp-messages', whatsappAnalyticsController.getTotalInboundMessages.bind(whatsappAnalyticsController));
app.get('/api/analytics/total-outbound-whatsapp-messages', whatsappAnalyticsController.getTotalOutboundMessages.bind(whatsappAnalyticsController));
app.get('/api/analytics/peak-chat-hours', whatsappAnalyticsController.getPeakChatHours.bind(whatsappAnalyticsController));
app.get('/api/analytics/peak-chat-days', whatsappAnalyticsController.getPeakChatDays.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-booking-conversion-rate', whatsappAnalyticsController.getBookingConversionRate.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-sentiment', whatsappAnalyticsController.getSentiment.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-sentiment-trend', whatsappAnalyticsController.getSentimentTrend.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-sentiment-by-topic', whatsappAnalyticsController.getSentimentByTopic.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-most-extreme-messages', whatsappAnalyticsController.getMostExtremeMessages.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-keyword-trends', whatsappAnalyticsController.getKeywordTrends.bind(whatsappAnalyticsController));
app.get('/api/analytics/whatsapp-agent-ai-performance', whatsappAnalyticsController.getAgentAIPerformance.bind(whatsappAnalyticsController));

// Statistics Routes
app.get('/api/statistics/active-users', analyticsController.getActiveUsers.bind(analyticsController));
app.get('/api/statistics/engaged-customers', analyticsController.getEngagedCustomers.bind(analyticsController));
app.get('/api/statistics/package-popularity', analyticsController.getPackagePopularity.bind(analyticsController));
app.get('/api/statistics/customer-emotions', analyticsController.getSentimentAnalysis.bind(analyticsController));
app.get('/api/statistics/comprehensive', analyticsController.getBusinessKpis.bind(analyticsController));
app.get('/api/statistics/ai-performance', analyticsController.getAiPerformance.bind(analyticsController));
app.get('/api/statistics/personalized-responses', analyticsController.getPersonalizedResponses.bind(analyticsController));
app.get('/api/statistics/system', (req, res) => res.json({ customers: { total: 0, active: 0 }, messages: { total: 0, responseRate: 100 }, bookings: { total: 0, completionRate: 100 } }));

// Notifications
app.get('/api/notifications', async (req, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const type = String(req.query.type || '').trim();
    const search = String(req.query.search || '').trim();
    const readQuery = String(req.query.read || '').trim().toLowerCase();

    const where: any = {};

    if (type && type !== 'all') {
      where.type = type;
    }

    if (readQuery === 'true' || readQuery === 'false') {
      where.read = readQuery === 'true';
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { read: false } }),
    ]);

    return res.json({ notifications, total, unreadCount });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/notifications/unread-count', async (req, res) => {
  try {
    const count = await getUnreadNotificationCount();
    return res.json({ count });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.notification.update({
      where: { id },
      data: { read: true },
    });
    invalidateUnreadCountCache();
    const count = await getUnreadNotificationCount();
    io.to('admin').emit('notificationCountUpdate', { count });
    return res.json({ success: true });
  } catch (e: any) {
    if (e?.code === 'P2025') {
      return res.status(404).json({ error: 'Notification not found' });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.patch('/api/notifications/mark-all-read', async (_req, res) => {
  try {
    const result = await prisma.notification.updateMany({
      where: { read: false },
      data: { read: true },
    });
    invalidateUnreadCountCache();
    unreadCountCache.value = 0;
    unreadCountCache.expiresAt = Date.now() + unreadCountTtlMs;
    io.to('admin').emit('notificationCountUpdate', { count: 0 });
    return res.json({ success: true, updated: result.count });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Escalations
app.get('/api/escalations', async (_req, res) => {
  try {
    const escalations = await prisma.escalation.findMany({
      where: { status: 'OPEN' },
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(escalations);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/escalations/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;

    const escalation = await prisma.escalation.update({
      where: { id },
      data: { status: 'RESOLVED' },
      include: {
        customer: {
          select: {
            id: true,
          },
        },
      },
    });

    // As the UI label says "Resolve & Unpause AI", re-enable AI for the
    // affected customer when the escalation is resolved.
    await prisma.customer.update({
      where: { id: escalation.customer.id },
      data: { aiEnabled: true },
    }).catch((err) => {
      console.error('Failed to re-enable AI after escalation resolve:', err);
    });

    io.to('admin').emit('escalationResolved', { escalationId: id });
    return res.json({ success: true });
  } catch (e: any) {
    if (e?.code === 'P2025') {
      return res.status(404).json({ error: 'Escalation not found' });
    }
    return res.status(500).json({ error: e.message });
  }
});

// Messages & Bookings by Customer
app.get('/api/messages/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const messages = await prisma.message.findMany({
      where: { customerId: customerId },
      orderBy: { createdAt: 'asc' }
    });
    return res.json(messages);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const bookings = await prisma.booking.findMany({ 
      where: { customerId: customerId }, 
      orderBy: { dateTime: 'desc' } 
    });
    return res.json(bookings);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({ 
      include: { customer: true }, 
      orderBy: { dateTime: 'desc' } 
    });
    return res.json(bookings);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings/available-hours/:date', async (req, res) => {
  try {
    const { date } = req.params;
    // Standard slots
    return res.json(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/customers/:id/photo-links', (req, res) => res.json([]));
app.get('/api/statistics/:type', (req, res) => res.json({}));

// Knowledge Base CRUD
app.get('/api/knowledge-base', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();

    const where: any = {};
    if (search) {
      where.OR = [
        { question: { contains: search, mode: 'insensitive' } },
        { answer: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (category) {
      where.category = { equals: category, mode: 'insensitive' };
    }

    const [items, total] = await Promise.all([
      prisma.knowledgeBase.findMany({ where, orderBy: { updatedAt: 'desc' } }),
      prisma.knowledgeBase.count({ where }),
    ]);

    return res.json({ items, total });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/knowledge-base', async (req, res) => {
  try {
    const { question, answer, category } = req.body || {};

    if (!question || !answer || !category) {
      return res.status(400).json({ error: 'question, answer and category are required' });
    }

    const created = await prisma.knowledgeBase.create({
      data: {
        question: String(question).trim(),
        answer: String(answer).trim(),
        category: String(category).trim(),
        embedding: [],
        mediaUrls: [],
      },
    });

    return res.status(201).json(created);
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'Knowledge base question already exists' });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.patch('/api/knowledge-base/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { question, answer, category } = req.body || {};

    const data: any = {};
    if (typeof question === 'string') data.question = question.trim();
    if (typeof answer === 'string') data.answer = answer.trim();
    if (typeof category === 'string') data.category = category.trim();

    const updated = await prisma.knowledgeBase.update({ where: { id }, data });
    return res.json(updated);
  } catch (e: any) {
    if (e?.code === 'P2025') {
      return res.status(404).json({ error: 'Knowledge base entry not found' });
    }
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'Knowledge base question already exists' });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.delete('/api/knowledge-base/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.knowledgeBase.delete({ where: { id } });
    return res.json({ success: true });
  } catch (e: any) {
    if (e?.code === 'P2025') {
      return res.status(404).json({ error: 'Knowledge base entry not found' });
    }
    return res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

async function checkDatabaseConnection() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');
  } catch (error: any) {
    console.error('❌ Database connection failed:', error.message);
  }
}

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, async () => {
  console.log(`Backend 2.0 running on http://localhost:${PORT}`);
  
  // Verify database connection
  await checkDatabaseConnection();
  
  // Initialize automation cron jobs
  cronService.init();
});

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import chatRoutes from './src/routes/chat.routes';
import whatsappRoutes from './src/routes/whatsapp.routes';
import bookingRoutes from './src/routes/booking.routes';
import { calendarController } from './src/controllers/calendar.controller';
import { customerController } from './src/controllers/customer.controller';
import customerRoutes from './src/routes/customer.routes';
import { analyticsController } from './src/controllers/analytics.controller';
import prisma from './src/config/prisma';
import { cronService } from './src/services/automation/cron.service';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // Adjust this for production
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Attach io to request for use in controllers
app.use((req: any, _res, next) => {
  req.io = io;
  next();
});

// Main Routes
app.use('/api', chatRoutes);
app.use('/webhooks/whatsapp', whatsappRoutes);
app.use('/api/whatsapp', whatsappRoutes); 
app.use('/api/bookings', bookingRoutes);
app.use('/api/customers', customerRoutes);
// Change 'use' to 'get' or 'post'
app.get('/api/calendar/events', calendarController.getEvents.bind(calendarController));
app.post('/api/calendar/sync', calendarController.sync.bind(calendarController));

// Analytics Routes
app.get('/api/analytics/booking-status-counts', analyticsController.getBookingStatusCounts.bind(analyticsController));
app.get('/api/analytics/revenue', analyticsController.getRevenue.bind(analyticsController));
app.get('/api/analytics/business-kpis', analyticsController.getBusinessKpis.bind(analyticsController));
app.get('/api/analytics/monthly-revenue', analyticsController.getMonthlyRevenue.bind(analyticsController));
app.get('/api/analytics/revenue-by-package', analyticsController.getRevenueByPackage.bind(analyticsController));
app.get('/api/analytics/seasonal-trends', analyticsController.getSeasonalTrends.bind(analyticsController));

// Statistics Routes
app.get('/api/statistics/active-users', analyticsController.getActiveUsers.bind(analyticsController));
app.get('/api/statistics/engaged-customers', analyticsController.getEngagedCustomers.bind(analyticsController));
app.get('/api/statistics/package-popularity', analyticsController.getPackagePopularity.bind(analyticsController));
app.get('/api/statistics/customer-emotions', analyticsController.getSentimentAnalysis.bind(analyticsController));
app.get('/api/statistics/ai-performance', (req, res) => res.json({ responseTime: { average: 1500 }, accuracy: { successRate: 98 }, userSatisfaction: { averageRating: 4.8 }, efficiency: { cacheHitRate: 85 }, byIntent: [] }));
app.get('/api/statistics/personalized-responses', (req, res) => res.json({ totalPersonalizedConversations: 120, overallSuccessRate: 95, averageTimeToResolution: 300, byCommunicationStyle: [] }));
app.get('/api/statistics/system', (req, res) => res.json({ customers: { total: 0, active: 0 }, messages: { total: 0, responseRate: 100 }, bookings: { total: 0, completionRate: 100 } }));

// Misc Placeholders to satisfy frontend
app.get('/api/notifications/unread-count', (req, res) => res.json({ count: 0 }));
app.get('/api/messages/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    let targetId = customerId;
    if (customerId.length >= 10 && /^\d+$/.test(customerId)) {
      const customer = await prisma.customer.findFirst({
        where: { OR: [{ whatsappId: customerId }, { phone: customerId }] }
      });
      if (customer) targetId = customer.id;
    }
    const messages = await prisma.message.findMany({
      where: { customerId: targetId },
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
    let targetId = customerId;
    
    if (customerId.length >= 10 && /^\d+$/.test(customerId)) {
      const customer = await prisma.customer.findFirst({
        where: { OR: [{ whatsappId: customerId }, { phone: customerId }] }
      });
      if (customer) targetId = customer.id;
    }

    const bookings = await prisma.booking.findMany({ 
      where: { customerId: targetId }, 
      orderBy: { dateTime: 'desc' } 
    });
    return res.json(bookings);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});
app.get('/api/invoices', async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({ include: { customer: true } });
    return res.json(invoices);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({ include: { customer: true }, orderBy: { dateTime: 'desc' } });
    return res.json(bookings);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookings/available-hours/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const { service } = req.query;
    // Mocking for now to avoid logic duplication
    return res.json(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/invoices', async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({ 
      include: { customer: true, booking: true },
      orderBy: { createdAt: 'desc' }
    });
    return res.json(invoices);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/statistics/comprehensive', analyticsController.getBusinessKpis.bind(analyticsController));

app.get('/api/invoices/customer/:customerId', (req, res) => res.json([]));
app.get('/api/customers/:id/photo-links', (req, res) => res.json([]));
app.get('/api/statistics/:type', (req, res) => res.json({}));

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

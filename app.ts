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
const serverStartedAt = Date.now();
const DB_LATENCY_HISTORY_LIMIT = 40;
const dbLatencyHistory: Array<{
  checkedAt: string;
  latencyMs: number;
  status: 'healthy' | 'degraded' | 'down';
}> = [];

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

// AI learning rows inspector (admin/debug)
app.get('/api/analytics/conversation-learning/recent', async (req, res) => {
  try {
    const requested = Number(req.query.limit || 50);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 200) : 50;

    const computeLikelyIncorrectSignals = (params: {
      userMessage: string;
      aiResponse: string;
      wasSuccessful: boolean;
      conversationOutcome?: string | null;
      detectedEmotionalTone?: string | null;
      metadata?: Record<string, any>;
    }) => {
      const user = (params.userMessage || '').toLowerCase();
      const ai = (params.aiResponse || '').toLowerCase();
      const tone = (params.detectedEmotionalTone || '').toLowerCase();
      const outcome = (params.conversationOutcome || '').toLowerCase();
      const md = params.metadata || {};
      const reasons: string[] = [];
      let score = 0;

      const intentConfidence = typeof md.intentConfidence === 'number' ? md.intentConfidence : null;
      if (intentConfidence !== null && intentConfidence < 0.6) {
        score += 0.35;
        reasons.push('low_intent_confidence');
      }

      if (/(team member|human|follow up|high demand)/.test(ai) && params.wasSuccessful) {
        score += 0.55;
        reasons.push('escalation_language_marked_success');
      }

      if ((tone === 'negative' || tone === 'very_negative') && (outcome === 'resolved' || params.wasSuccessful)) {
        score += 0.2;
        reasons.push('negative_tone_but_resolved');
      }

      if (/\?/.test(user) && ai.length < 40) {
        score += 0.15;
        reasons.push('very_short_answer_to_question');
      }

      if (/(when|date|time|appointment|booking|session)/.test(user) && !/(am|pm|\d{1,2}:\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)/.test(ai)) {
        score += 0.25;
        reasons.push('possible_missing_date_time_details');
      }

      if (/(balance|receipt|deposit|payment|mpesa)/.test(user) && !/(balance|deposit|receipt|mpesa|pay|paid|after the shoot|stk)/.test(ai)) {
        score += 0.25;
        reasons.push('possible_payment_answer_mismatch');
      }

      const capped = Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
      return {
        likelyIncorrectScore: capped,
        likelyIncorrect: capped >= 0.6,
        likelyIncorrectReasons: reasons,
      };
    };

    const inferIntent = (text: string): { intent: string; confidence: number; rule: string } => {
      const lower = text.toLowerCase();
      if (!lower.trim()) return { intent: 'general_inquiry', confidence: 0.35, rule: 'fallback_default' };

      const hasDateLike = /(\b\d{1,2}(st|nd|rd|th)?\b)|(\b\d{4}-\d{2}-\d{2}\b)/.test(lower);
      const hasTimeLike = /(\b\d{1,2}(:\d{2})?\s?(am|pm)\b)|(\b\d{1,2}:\d{2}\b)/.test(lower);

      if (/^(yes|yep|yeah|ok|okay|confirm|confirmed|go ahead|proceed|continue|ndio|sawa)\b/.test(lower)) {
        return { intent: 'confirmation', confidence: 0.95, rule: 'confirmation_keywords' };
      }
      if (/(invoice|receipt|balance due|deposit receipt|stk|mpesa prompt|m-pesa prompt)/.test(lower)) return { intent: 'payment', confidence: 0.9, rule: 'payment_keywords_strong' };
      if (/(services|service list|list.*service|packages?|which package|what package)/.test(lower)) return { intent: 'pricing', confidence: 0.87, rule: 'pricing_keywords_strong' };
      if ((hasDateLike || hasTimeLike) && /(book|booking|session|slot|available|let'?s do|i want it on|this coming week)/.test(lower)) {
        return { intent: 'booking', confidence: 0.9, rule: 'booking_datetime_combined' };
      }
      if (/(reschedule|change|move|postpone)/.test(lower)) return { intent: 'reschedule', confidence: 0.92, rule: 'reschedule_keywords' };
      if (/(book|booking|appointment|session)/.test(lower)) return { intent: 'booking', confidence: 0.86, rule: 'booking_keywords' };
      if (/(pay|paid|payment|mpesa|deposit|receipt|balance)/.test(lower)) return { intent: 'payment', confidence: 0.88, rule: 'payment_keywords' };
      if (/(price|cost|package|rate)/.test(lower)) return { intent: 'pricing', confidence: 0.83, rule: 'pricing_keywords' };
      if (/(where|location|located|address)/.test(lower)) return { intent: 'location', confidence: 0.9, rule: 'location_keywords' };
      if (/(facebook|instagram|tiktok|social media|handles?)/.test(lower)) return { intent: 'social_info', confidence: 0.9, rule: 'social_keywords' };
      if (/(family|husband|wife|children|kids|sons|daughters|pregnan|weeks in)/.test(lower)) return { intent: 'session_detail', confidence: 0.84, rule: 'session_detail_keywords' };
      if (/(how long|duration|hours|mins|minutes)/.test(lower)) return { intent: 'availability', confidence: 0.84, rule: 'duration_keywords' };
      if (/(time|hours|open|close|availability|available)/.test(lower)) return { intent: 'availability', confidence: 0.8, rule: 'availability_keywords' };
      return { intent: 'general_inquiry', confidence: 0.35, rule: 'fallback_default' };
    };

    const inferTone = (text: string): { tone: string; confidence: number } => {
      const lower = text.toLowerCase();
      const veryPositive = /(thank you so much|amazing|perfect|awesome|excellent|love this)/.test(lower);
      const positive = /(thank you|thanks|great|nice|okay|ok|sawa|ndio)/.test(lower);
      const veryNegative = /(scam|worst|fraud|furious|unacceptable)/.test(lower);
      const negative = /(angry|frustrated|terrible|ridiculous|refund|not happy|disappointed)/.test(lower);

      if (veryNegative) return { tone: 'very_negative', confidence: 0.9 };
      if (negative) return { tone: 'negative', confidence: 0.8 };
      if (veryPositive) return { tone: 'very_positive', confidence: 0.88 };
      if (positive) return { tone: 'positive', confidence: 0.76 };
      return { tone: 'neutral', confidence: 0.45 };
    };

    const rows = await prisma.conversationLearning.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (rows.length > 0) {
      const rowsMissingTelemetry = rows.filter((row) => {
        const metadata = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, any>)
          : {}) as Record<string, any>;
        return (
          typeof metadata.intentConfidence !== 'number' ||
          typeof metadata.intentRule !== 'string' ||
          typeof metadata.toneConfidence !== 'number'
        );
      });

      const enrichedRows = rows.map((row) => {
        const currentMetadata = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, any>)
          : {}) as Record<string, any>;

        const inferredIntent = inferIntent(row.userMessage || '');
        const inferredTone = inferTone(row.userMessage || '');
        const resolvedIntentConfidence =
          typeof currentMetadata.intentConfidence === 'number' ? currentMetadata.intentConfidence : inferredIntent.confidence;
        const resolvedToneConfidence =
          typeof currentMetadata.toneConfidence === 'number' ? currentMetadata.toneConfidence : inferredTone.confidence;
        const qualitySignals = computeLikelyIncorrectSignals({
          userMessage: row.userMessage || '',
          aiResponse: row.aiResponse || '',
          wasSuccessful: row.wasSuccessful,
          conversationOutcome: row.conversationOutcome,
          detectedEmotionalTone: row.detectedEmotionalTone,
          metadata: {
            ...currentMetadata,
            intentConfidence: resolvedIntentConfidence,
            toneConfidence: resolvedToneConfidence,
          },
        });

        return {
          ...row,
          metadata: {
            ...currentMetadata,
            intentConfidence: resolvedIntentConfidence,
            intentRule: typeof currentMetadata.intentRule === 'string' ? currentMetadata.intentRule : inferredIntent.rule,
            toneConfidence: resolvedToneConfidence,
            likelyIncorrectScore: qualitySignals.likelyIncorrectScore,
            likelyIncorrect: qualitySignals.likelyIncorrect,
            likelyIncorrectReasons: qualitySignals.likelyIncorrectReasons,
            classifierVersion: currentMetadata.classifierVersion || 'retrofill-v2',
          },
        };
      });

      if (rowsMissingTelemetry.length > 0) {
        const missingIds = new Set(rowsMissingTelemetry.map((row) => row.id));

        // Best-effort persistence so future reads do not need repeated inference.
        await Promise.all(
          enrichedRows
            .filter((row) => missingIds.has(row.id))
            .map((row) =>
            prisma.conversationLearning.update({
              where: { id: row.id },
              data: { metadata: row.metadata as any },
            })
          )
        ).catch((retroErr) => {
          console.error('Failed to retrofill confidence metadata:', retroErr);
        });
      }

      return res.json({
        items: enrichedRows,
        count: enrichedRows.length,
        limit,
        source: 'conversation_learning',
        retrofilledMetadata: rowsMissingTelemetry.length > 0,
      });
    }

    // Fallback for environments where ConversationLearning was introduced after
    // historical traffic already existed. Derive rows from recent AI messages.
    const outboundAiMessages = await prisma.message.findMany({
      where: { direction: 'outbound', handledBy: 'ai' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        customer: {
          select: { id: true, name: true },
        },
      },
    });

    const derivedRows = await Promise.all(
      outboundAiMessages.map(async (outbound) => {
        const inbound = await prisma.message.findFirst({
          where: {
            customerId: outbound.customerId,
            direction: 'inbound',
            createdAt: { lt: outbound.createdAt },
          },
          orderBy: { createdAt: 'desc' },
        });

        const userMessage = inbound?.content || '';
        const aiResponse = outbound.content || '';
        const isFallback = aiResponse.includes("we're experiencing high demand") || aiResponse.includes("we are experiencing high demand");
        const inferredIntent = inferIntent(userMessage);
        const inferredTone = inferTone(userMessage);

        return {
          id: `derived-${outbound.id}`,
          customerId: outbound.customerId,
          customer: outbound.customer,
          userMessage,
          aiResponse,
          extractedIntent: inferredIntent.intent,
          detectedEmotionalTone: inferredTone.tone,
          wasSuccessful: !isFallback,
          conversationOutcome: isFallback ? 'escalated' : 'resolved',
          conversationLength: 1,
          timeToResolution: null,
          metadata: {
            platform: outbound.platform,
            isFallback,
            derived: true,
            sourceMessageId: outbound.id,
            intentConfidence: inferredIntent.confidence,
            intentRule: inferredIntent.rule,
            toneConfidence: inferredTone.confidence,
            ...computeLikelyIncorrectSignals({
              userMessage,
              aiResponse,
              wasSuccessful: !isFallback,
              conversationOutcome: isFallback ? 'escalated' : 'resolved',
              detectedEmotionalTone: inferredTone.tone,
              metadata: {
                intentConfidence: inferredIntent.confidence,
                intentRule: inferredIntent.rule,
                toneConfidence: inferredTone.confidence,
              },
            }),
            classifierVersion: 'derived-v2',
          },
          createdAt: outbound.createdAt,
        };
      })
    );

    // One-time bootstrap: if the learning table is empty, seed it from recent
    // historical AI messages so analytics can start from real rows instead of
    // staying in "derived" mode until enough new traffic arrives.
    if (derivedRows.length > 0) {
      try {
        await prisma.conversationLearning.createMany({
          data: derivedRows.map((row) => ({
            customerId: row.customerId,
            userMessage: row.userMessage,
            aiResponse: row.aiResponse,
            extractedIntent: row.extractedIntent,
            detectedEmotionalTone: row.detectedEmotionalTone,
            wasSuccessful: row.wasSuccessful,
            conversationOutcome: row.conversationOutcome,
            conversationLength: row.conversationLength,
            timeToResolution: row.timeToResolution,
            metadata: row.metadata,
            createdAt: row.createdAt,
          })),
        });

        const seededRows = await prisma.conversationLearning.findMany({
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: {
            customer: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        return res.json({
          items: seededRows,
          count: seededRows.length,
          limit,
          source: 'conversation_learning',
          seededFromMessages: true,
        });
      } catch (seedError) {
        console.error('Failed to seed conversation learning rows from messages:', seedError);
      }
    }

    return res.json({
      items: derivedRows,
      count: derivedRows.length,
      limit,
      source: 'derived_from_messages',
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/analytics/conversation-learning/:id/qa-label', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const rawLabel = String(req.body?.qaLabel || '').trim().toLowerCase();
    const note = String(req.body?.note || '').trim();

    const allowedLabels = new Set(['correct', 'partially_correct', 'incorrect', 'unsafe']);
    if (!id) return res.status(400).json({ error: 'Missing row id.' });
    if (!allowedLabels.has(rawLabel)) {
      return res.status(400).json({ error: 'Invalid qaLabel. Expected one of: correct, partially_correct, incorrect, unsafe.' });
    }

    const existing = await prisma.conversationLearning.findUnique({
      where: { id },
      select: { id: true, metadata: true },
    });

    if (!existing) return res.status(404).json({ error: 'Conversation learning row not found.' });

    const currentMetadata = (existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, any>)
      : {}) as Record<string, any>;

    const updated = await prisma.conversationLearning.update({
      where: { id },
      data: {
        metadata: {
          ...currentMetadata,
          qaLabel: rawLabel,
          qaNote: note || null,
          qaReviewedAt: new Date().toISOString(),
        } as any,
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return res.json({ item: updated });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

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

app.get('/api/system/status', async (req, res) => {
  const checkedAt = new Date().toISOString();
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const DB_DEGRADED_LATENCY_MS = 700;
  const DB_DOWN_LATENCY_MS = 2000;
  const QA_MIN_SAMPLE = 20;
  const statusRank: Record<'healthy' | 'degraded' | 'down', number> = {
    healthy: 0,
    degraded: 1,
    down: 2,
  };

  const memory = process.memoryUsage();

  const dbStart = Date.now();
  let databaseStatus: 'healthy' | 'degraded' | 'down' = 'healthy';
  let databaseError: string | null = null;
  let databaseLatencyMs = 0;

  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseLatencyMs = Date.now() - dbStart;
    if (databaseLatencyMs >= DB_DOWN_LATENCY_MS) {
      databaseStatus = 'down';
      databaseError = `Database latency is critically high (${databaseLatencyMs} ms).`;
    } else if (databaseLatencyMs >= DB_DEGRADED_LATENCY_MS) {
      databaseStatus = 'degraded';
    }
  } catch (error: any) {
    databaseStatus = 'down';
    databaseError = error?.message || 'Database ping failed';
    databaseLatencyMs = Date.now() - dbStart;
  }

  dbLatencyHistory.push({
    checkedAt,
    latencyMs: databaseLatencyMs,
    status: databaseStatus,
  });
  if (dbLatencyHistory.length > DB_LATENCY_HISTORY_LIMIT) {
    dbLatencyHistory.splice(0, dbLatencyHistory.length - DB_LATENCY_HISTORY_LIMIT);
  }

  const latencyValues = dbLatencyHistory.map((p) => p.latencyMs);
  const minLatencyMs = latencyValues.length > 0 ? Math.min(...latencyValues) : databaseLatencyMs;
  const maxLatencyMs = latencyValues.length > 0 ? Math.max(...latencyValues) : databaseLatencyMs;
  const avgLatencyMs = latencyValues.length > 0
    ? Number((latencyValues.reduce((sum, v) => sum + v, 0) / latencyValues.length).toFixed(1))
    : databaseLatencyMs;
  const previousLatency = latencyValues.length > 1 ? latencyValues[latencyValues.length - 2] : databaseLatencyMs;
  const deltaMs = databaseLatencyMs - previousLatency;
  const trendDirection = Math.abs(deltaMs) <= 50 ? 'stable' : deltaMs > 0 ? 'up' : 'down';

  const [customerCountRes, message24hCountRes, openEscalationsRes, provisionalBookingsRes, learningCountRes, learningSampleRes, unreadCountRes] = await Promise.allSettled([
    prisma.customer.count(),
    prisma.message.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.escalation.count({ where: { status: 'OPEN' } }),
    prisma.booking.count({ where: { status: 'provisional' } }),
    prisma.conversationLearning.count(),
    prisma.conversationLearning.findMany({
      take: 200,
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    }),
    getUnreadNotificationCount(),
  ]);

  const settledValue = <T,>(result: PromiseSettledResult<T>, fallback: T): T => {
    if (result.status === 'fulfilled') return result.value;
    return fallback;
  };

  const sampleRows = settledValue(learningSampleRes, [] as Array<{ metadata: unknown }>);
  const qaLabeledCount = sampleRows.filter((row) => {
    const metadata = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    return typeof metadata.qaLabel === 'string' && metadata.qaLabel.length > 0;
  }).length;

  const qaCoverage = sampleRows.length > 0 ? Number((qaLabeledCount / sampleRows.length).toFixed(2)) : 0;

  const serviceFailures = [
    customerCountRes,
    message24hCountRes,
    openEscalationsRes,
    provisionalBookingsRes,
    learningCountRes,
    learningSampleRes,
    unreadCountRes,
  ].filter((r) => r.status === 'rejected').length;

  const realtimeSocketStatus: 'healthy' | 'degraded' = io.engine.clientsCount > 0 ? 'healthy' : 'degraded';
  const notificationsCacheStatus: 'healthy' | 'degraded' = unreadCountCache.expiresAt > now ? 'healthy' : 'degraded';
  let aiLearningQaStatus: 'healthy' | 'degraded' | 'down' = 'healthy';

  if (sampleRows.length < QA_MIN_SAMPLE) {
    // Small datasets are not enough to treat QA coverage as a hard outage signal.
    aiLearningQaStatus = 'degraded';
  } else if (qaCoverage >= 0.5) {
    aiLearningQaStatus = 'healthy';
  } else if (qaCoverage >= 0.2) {
    aiLearningQaStatus = 'degraded';
  } else {
    aiLearningQaStatus = 'down';
  }

  let overallStatus: 'healthy' | 'degraded' | 'down' = 'healthy';
  const componentStatuses: Array<'healthy' | 'degraded' | 'down'> = [
    databaseStatus,
    realtimeSocketStatus,
    notificationsCacheStatus,
    aiLearningQaStatus,
  ];

  for (const status of componentStatuses) {
    if (statusRank[status] > statusRank[overallStatus]) {
      overallStatus = status;
    }
  }

  if (serviceFailures > 0 && overallStatus === 'healthy') {
    overallStatus = 'degraded';
  }

  return res.json({
    overallStatus,
    checkedAt,
    uptimeSeconds: Math.floor((now - serverStartedAt) / 1000),
    runtime: {
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      pid: process.pid,
      connectedClients: io.engine.clientsCount,
      memory: {
        rssMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
        heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
        heapTotalMb: Number((memory.heapTotal / 1024 / 1024).toFixed(1)),
      },
    },
    database: {
      status: databaseStatus,
      latencyMs: databaseLatencyMs,
      error: databaseError,
      trend: {
        maxPoints: DB_LATENCY_HISTORY_LIMIT,
        points: dbLatencyHistory,
        stats: {
          minMs: minLatencyMs,
          maxMs: maxLatencyMs,
          avgMs: avgLatencyMs,
          deltaMs,
          direction: trendDirection,
        },
      },
    },
    metrics: {
      customers: settledValue(customerCountRes, 0),
      messagesLast24h: settledValue(message24hCountRes, 0),
      openEscalations: settledValue(openEscalationsRes, 0),
      provisionalBookings: settledValue(provisionalBookingsRes, 0),
      conversationLearningRows: settledValue(learningCountRes, 0),
      unreadNotifications: settledValue(unreadCountRes, 0),
      qaCoverageRecent200: qaCoverage,
      sampleSizeForQaCoverage: sampleRows.length,
    },
    services: {
      realtimeSocket: {
        status: realtimeSocketStatus,
        connectedClients: io.engine.clientsCount,
      },
      notificationsCache: {
        status: notificationsCacheStatus,
        expiresInMs: Math.max(0, unreadCountCache.expiresAt - now),
      },
      aiLearningQa: {
        status: aiLearningQaStatus,
        qaCoverageRecent200: qaCoverage,
        sampleSize: sampleRows.length,
        minSampleForStrictHealth: QA_MIN_SAMPLE,
      },
    },
    failedChecks: serviceFailures,
  });
});

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

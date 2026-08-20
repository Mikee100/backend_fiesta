import { EventEmitter } from 'events';
import prisma from '../../config/prisma';

// Decouples notification creation (called from agent.service.ts, which has no
// access to the Socket.io instance living in app.ts) from actually pushing it
// to connected dashboard clients. app.ts subscribes to this once at startup
// and forwards events onto its io instance.
export const notificationEvents = new EventEmitter();

function inferTargetPath(type: string, metadata?: Record<string, any>): string {
  const customerId = metadata?.customerId;
  const bookingId = metadata?.bookingId;

  if (typeof metadata?.targetPath === 'string' && metadata.targetPath.trim()) {
    return metadata.targetPath;
  }

  if (customerId) {
    return `/customers/${customerId}`;
  }

  if (type === 'escalation' || type === 'ai_escalation' || metadata?.escalationType) {
    return '/escalations';
  }

  if (bookingId) {
    return `/bookings?bookingId=${bookingId}`;
  }

  if (type === 'booking' || type === 'reschedule' || type === 'payment' || type === 'reschedule_request') {
    return '/bookings';
  }

  return '/notifications';
}

export async function notifyAdmin(
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    const enrichedMetadata = {
      ...(metadata || {}),
      targetPath: inferTargetPath(type, metadata),
    };

    const notification = await prisma.notification.create({
      data: { type, title, message, metadata: enrichedMetadata }
    });
    notificationEvents.emit('notification', notification);
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
}

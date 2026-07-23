import { EventEmitter } from 'events';
import prisma from '../../config/prisma';

// Decouples notification creation (called from agent.service.ts, which has no
// access to the Socket.io instance living in app.ts) from actually pushing it
// to connected dashboard clients. app.ts subscribes to this once at startup
// and forwards events onto its io instance.
export const notificationEvents = new EventEmitter();

export async function notifyAdmin(
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    const notification = await prisma.notification.create({
      data: { type, title, message, metadata }
    });
    notificationEvents.emit('notification', notification);
  } catch (err) {
    console.error('Failed to create notification:', err);
  }
}

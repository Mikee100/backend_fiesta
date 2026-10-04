import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { ADDON_CATALOG } from '../../config/constants';
import { bookingAddonService } from '../booking/booking-addon.service';
import { notifyAdmin } from '../notifications/notification.service';

export function extractSessionNoteMetadata(note: string, type?: string, category?: string, priority?: string): {
  normalizedType: string;
  category: string;
  priority: string;
  tags: string[];
  details: {
    addOns: string[];
    companions: string[];
    accessibilityNeeds: string[];
    stylingRequests: string[];
    deliveryPreferences: string[];
  };
} {
  const rawNote = (note || '').trim();
  const lower = rawNote.toLowerCase();

  const addOns: string[] = [];
  for (const item of ADDON_CATALOG) {
    if (item.match.test(rawNote)) {
      const itemName = item.name;
      if (!addOns.includes(itemName)) {
        addOns.push(itemName);
      }
    }
  }

  const companions = Array.from(new Set(
    ['husband', 'wife', 'partner', 'sister', 'brother', 'mother', 'father', 'friend', 'child', 'children', 'family', 'mother-in-law', 'father-in-law', 'relative']
      .filter((word) => lower.includes(word))
      .map((word) => word.replace(/-in-law/g, ''))
  ));

  const accessibilityNeeds = Array.from(new Set(
    (['wheelchair', 'mobility', 'accessible', 'accessibility', 'medical', 'allerg', 'injur', 'pregnant'] as const)
      .filter((word) => lower.includes(word))
      .map((word) => word === 'pregnant' ? 'pregnancy-related need' : word)
  ));

  const stylingRequests = Array.from(new Set(
    (['wig', 'makeup', 'hair', 'outfit', 'gown', 'backdrop', 'theme', 'colour', 'color'] as const)
      .filter((word) => lower.includes(word))
      .map((word) => word === 'colour' || word === 'color' ? 'colour/theme request' : word)
  ));

  const deliveryPreferences = Array.from(new Set(
    (['email', 'whatsapp', 'download link', 'delivery', 'secure link'] as const)
      .filter((word) => lower.includes(word))
  ));

  const highlightTags = new Set<string>();
  if (addOns.length > 0) highlightTags.add('addon');
  if (companions.length > 0) highlightTags.add('companion');
  if (accessibilityNeeds.length > 0) highlightTags.add('accessibility');
  if (stylingRequests.length > 0) highlightTags.add('styling');
  if (deliveryPreferences.length > 0) highlightTags.add('delivery');

  let normalizedType = (type || 'other').trim().toLowerCase();
  if (normalizedType === 'other') {
    if (/(list of services|service list|show.*services|send.*services|package list|pricing)/i.test(rawNote)) {
      normalizedType = 'action_request';
    } else if (/(delivery preference|download link|email.*link|whatsapp.*link|thank.*for.*photo|send.*photos?)/i.test(rawNote)) {
      normalizedType = 'special_request';
    } else if (highlightTags.size > 0 || addOns.length > 0 || companions.length > 0 || accessibilityNeeds.length > 0) {
      normalizedType = 'special_request';
    }
  }

  const categoryValue = ['client_wish', 'operational', 'addon', 'accessibility', 'companion', 'styling', 'delivery', 'other'].includes(category || '')
    ? category!
    : addOns.length > 0
      ? 'addon'
      : accessibilityNeeds.length > 0
        ? 'accessibility'
        : companions.length > 0
          ? 'companion'
          : stylingRequests.length > 0
            ? 'styling'
            : deliveryPreferences.length > 0
              ? 'delivery'
              : normalizedType === 'action_request'
                ? 'operational'
                : 'client_wish';

  const prioritySignals = /(urgent|asap|must|important|allerg|medical|mobility|wheelchair|emergency|cannot|can't|need.*soon)/i;
  const priorityValue = ['normal', 'high', 'urgent'].includes(priority || '')
    ? priority!
    : prioritySignals.test(rawNote) || accessibilityNeeds.length > 0 || (companions.length > 0 && addOns.length > 0)
      ? 'high'
      : 'normal';

  const tags = Array.from(highlightTags);
  return {
    normalizedType,
    category: categoryValue,
    priority: priorityValue,
    tags,
    details: {
      addOns,
      companions,
      accessibilityNeeds,
      stylingRequests,
      deliveryPreferences,
    },
  };
}

export async function executeAddNoteTool(
  this: any,
  customerId: string,
  bookingDate: string,
  note: string,
  type: string,
  category?: string,
  priority?: string,
  sourceMessage?: string,
  platform?: string
): Promise<{ created: boolean; reason?: string; type?: string }> {
  const rawNote = (note || '').trim();
  if (!rawNote) {
    return { created: false, reason: 'empty_note' };
  }

  const normalized = rawNote.toLowerCase();
  const nonActionablePatterns = [
    /^no special requests? mentioned$/,
    /^no special requests?$/,
    /^no requests?$/,
    /^none$/,
    /^n\/a$/,
  ];
  if (nonActionablePatterns.some((pattern) => pattern.test(normalized))) {
    return { created: false, reason: 'non_actionable_note' };
  }

  const metadata = this.extractSessionNoteMetadata(rawNote, type, category, priority);
  const normalizedType = metadata.normalizedType;
  const normalizedCategory = metadata.category;
  const normalizedPriority = metadata.priority;

  const duplicateWindowStart = dayjs().subtract(24, 'hour').toDate();
  const duplicate = await prisma.customerSessionNote.findFirst({
    where: {
      customerId,
      status: 'pending',
      type: normalizedType,
      description: rawNote,
      createdAt: { gte: duplicateWindowStart },
    },
    select: { id: true },
  });
  if (duplicate) {
    return { created: false, reason: 'duplicate_pending_note', type: normalizedType };
  }

  const parsedDate = bookingDate ? dayjs(bookingDate) : null;
  const bookingOnDate = parsedDate?.isValid()
    ? await prisma.booking.findFirst({
        where: {
          customerId: customerId,
          status: { not: 'cancelled' },
          dateTime: {
            gte: parsedDate.startOf('day').toDate(),
            lte: parsedDate.endOf('day').toDate()
          }
        }
      })
    : null;
  const booking = bookingOnDate ?? await prisma.booking.findFirst({
    where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
    orderBy: { dateTime: 'asc' }
  });

  const createdNote = await prisma.customerSessionNote.create({
    data: {
      customerId: customerId,
      bookingId: booking?.id,
      description: rawNote,
      type: normalizedType,
      status: 'pending',
      category: normalizedCategory,
      priority: normalizedPriority,
      actionStatus: 'open',
      structuredData: {
        tags: metadata.tags,
        details: metadata.details,
        originalType: type || 'other',
        originalCategory: category || null,
        originalPriority: priority || null,
      },
      sourceMessage,
      platform,
    }
  });

  await bookingAddonService.createFromNote({
    customerId,
    bookingId: booking?.id,
    note: rawNote,
    sessionNoteId: createdNote.id,
  });

  if (normalizedType === 'action_request' || normalizedType === 'special_request') {
    await notifyAdmin(
      'booking',
      `Session note requires review for ${customerId}`,
      `${rawNote}${booking ? ` (Booking: ${booking.service} on ${dayjs(booking.dateTime).format('YYYY-MM-DD HH:mm')})` : ''}`,
      {
        customerId,
        bookingId: booking?.id,
        sessionNoteId: createdNote.id,
        noteType: normalizedType,
        event: 'session_note_review_required',
      }
    );
  }

  return { created: true, type: normalizedType };
}
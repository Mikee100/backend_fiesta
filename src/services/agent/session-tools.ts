import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { ADDON_CATALOG } from '../../config/constants';
import { bookingAddonService } from '../booking/booking-addon.service';
import { notifyAdmin } from '../notifications/notification.service';
import { addonQuantity, addonRecipient, isAdditionalAddonRequest, isAddonInquiry, selectedAddons } from './addon-capture';

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
  platform?: string,
  approvedAddonSkus?: readonly string[]
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
  const noteAddons = ADDON_CATALOG.filter((item) => item.match.test(rawNote));
  const sourceHasAddons = ADDON_CATALOG.some((item) => item.match.test(sourceMessage || ''));
  const approved = approvedAddonSkus || selectedAddons(sourceMessage || rawNote).map((item) => item.sku);
  if (noteAddons.some((item) => item.sku === 'extra_makeup') && !addonRecipient(sourceMessage || rawNote, 'extra_makeup')) {
    return { created: false, reason: 'addon_recipient_requires_confirmation' };
  }
  if ((noteAddons.length || metadata.category === 'addon' || sourceHasAddons) && isAddonInquiry(sourceMessage || rawNote)) {
    return { created: false, reason: 'addon_requires_explicit_choice' };
  }
  if ((noteAddons.length || metadata.category === 'addon')
    && (!noteAddons.length || noteAddons.some((item) => !approved.includes(item.sku)))) {
    return { created: false, reason: 'addon_requires_explicit_choice' };
  }
  try {
    if (noteAddons.some((item) => addonQuantity(rawNote, item) !== addonQuantity(sourceMessage || rawNote, item))) {
      return { created: false, reason: 'addon_quantity_requires_confirmation' };
    }
  } catch {
    return { created: false, reason: 'addon_quantity_requires_confirmation' };
  }
  const normalizedType = metadata.normalizedType;
  const normalizedCategory = metadata.category;
  const normalizedPriority = metadata.priority;

  const duplicateWindowStart = dayjs().subtract(24, 'hour').toDate();
  const incrementalSkus = noteAddons.filter((item) => isAdditionalAddonRequest(sourceMessage || '', item.sku)).map((item) => item.sku);
  const duplicate = await prisma.customerSessionNote.findFirst({
    where: {
      customerId,
      status: 'pending',
      type: normalizedType,
      description: rawNote,
      ...(incrementalSkus.length ? { sourceMessage } : {}),
      createdAt: { gte: duplicateWindowStart },
    },
    select: { id: true },
  });
  if (duplicate) {
    if (noteAddons.length) {
      const recorded = await prisma.bookingAddon.findFirst({ where: { sessionNoteId: duplicate.id, status: { in: ['pending', 'confirmed', 'invoiced'] } } });
      if (!recorded) return { created: false, reason: 'addon_requires_staff_review', type: normalizedType };
    }
    return { created: false, reason: 'duplicate_pending_note', type: normalizedType };
  }

  const addonDraft = noteAddons.length ? await prisma.bookingDraft.findUnique({ where: { customerId } }) : null;
  const pendingNewSession = Boolean(addonDraft && !addonDraft.bookingId);
  const parsedDate = bookingDate && !pendingNewSession ? dayjs(bookingDate) : null;
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
  const booking = pendingNewSession ? null : bookingOnDate ?? await prisma.booking.findFirst({
    where: { customerId, ...(addonDraft?.bookingId ? { id: addonDraft.bookingId } : {}), status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
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

  const addonCount = await bookingAddonService.createFromNote({
    customerId,
    bookingId: booking?.id,
    note: rawNote,
    sessionNoteId: createdNote.id,
    incrementExistingSkus: incrementalSkus,
  });
  if (noteAddons.length && addonCount === 0) {
    return { created: false, reason: 'addon_already_recorded', type: normalizedType };
  }

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

function isPlaceholderContactEmail(email?: string | null): boolean {
  if (!email) return true;
  const value = email.trim().toLowerCase();
  if (!value) return true;
  return value.endsWith('@whatsapp.local') || value.endsWith('@messenger.local') || value.endsWith('@instagram.local');
}

export async function executeSaveDeliveryPreferenceTool(
  customerId: string,
  method: 'email' | 'download_link' | 'whatsapp',
  email?: string,
  whatsappNumber?: string,
  note?: string,
  platform?: string,
) {
  const normalizedMethod = (method || '').toLowerCase();
  if (!['email', 'download_link', 'whatsapp'].includes(normalizedMethod)) {
    throw new Error('Invalid delivery method. Use email, download_link, or whatsapp.');
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    throw new Error('Customer not found while saving delivery preference.');
  }

  const normalizedEmail = email?.trim().toLowerCase();
  const normalizedWhatsappNumber = whatsappNumber?.trim();
  const emailFromCustomer = isPlaceholderContactEmail(customer.email) ? undefined : customer.email?.trim().toLowerCase();
  const resolvedEmail = normalizedEmail || emailFromCustomer;
  const resolvedWhatsappNumber = normalizedWhatsappNumber || customer.phone || customerId;

  if (normalizedMethod === 'email') {
    if (!resolvedEmail) {
      throw new Error('Email delivery requested but no email address is on file. Ask the customer for their exact email address first.');
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(resolvedEmail)) {
      throw new Error('The provided email format looks invalid. Ask the customer to confirm the exact email address.');
    }

    if (customer.email !== resolvedEmail) {
      await prisma.customer.update({ where: { id: customerId }, data: { email: resolvedEmail } });
    }
  }

  const booking = await prisma.booking.findFirst({
    where: { customerId, dateTime: { gte: new Date() }, status: { not: 'cancelled' } },
    orderBy: { dateTime: 'asc' }
  });

  const description = [
    `Delivery preference: ${normalizedMethod}`,
    normalizedMethod === 'email' && resolvedEmail ? `Email: ${resolvedEmail}` : '',
    normalizedMethod === 'whatsapp' && resolvedWhatsappNumber ? `WhatsApp: ${resolvedWhatsappNumber}` : '',
    note ? `Note: ${note}` : ''
  ].filter(Boolean).join(' | ');

  await prisma.customerSessionNote.create({
    data: {
      customerId,
      bookingId: booking?.id,
      type: 'special_request',
      description,
      status: 'pending',
      platform: platform || 'whatsapp',
      sourceMessage: note?.trim() || undefined,
    }
  });

  await notifyAdmin(
    'booking',
    `Delivery preference captured for ${customerId}`,
    `${customer.name || customerId} prefers ${normalizedMethod}${normalizedMethod === 'email' && resolvedEmail ? ` via ${resolvedEmail}` : ''}${normalizedMethod === 'whatsapp' && resolvedWhatsappNumber ? ` via ${resolvedWhatsappNumber}` : ''}.`,
    {
      customerId,
      bookingId: booking?.id,
      event: 'delivery_preference',
      deliveryMethod: normalizedMethod,
      deliveryEmail: normalizedMethod === 'email' ? resolvedEmail : undefined,
      deliveryPhone: normalizedMethod === 'whatsapp' ? resolvedWhatsappNumber : undefined,
    }
  );

  return {
    method: normalizedMethod,
    email: normalizedMethod === 'email' ? resolvedEmail : undefined,
    whatsappNumber: normalizedMethod === 'whatsapp' ? resolvedWhatsappNumber : undefined,
  };
}
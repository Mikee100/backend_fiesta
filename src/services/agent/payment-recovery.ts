import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { mpesaService } from '../payment/mpesa.service';
import { SERVICE_DURATIONS } from '../../config/constants';
import { businessDay, inBusinessTimezone } from '../../utils/time';
import { buildBookingProposalConfirmation, formatCustomerTime } from './replies';
import { editionInText } from './reply-voice';
import { PAYMENT_PROMPT_UNRECORDED_REPLY } from './constants';

export const MAX_PAYMENT_ATTEMPTS = 3;
export const PAYMENT_PROMPT_TIMEOUT_MS = 2 * 60_000;
export const PAYMENT_HOLD_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
export const STUDIO_CONTACT = '0720 111928';

export type PaymentSituationKind = 'none' | 'prompt_sent' | 'prompt_stale' | 'cancelled' | 'failed' | 'hold_expired' | 'unrecorded' | 'paid';
export type PaymentMessageKind = 'not_arrived' | 'paid_claim' | 'receipt' | 'status_check' | 'restart' | 'resend' | 'consent';

type DraftLike = { id: string; step: string; version?: number | null; updatedAt?: Date | string | null; service?: string | null; date?: string | null; time?: string | null };
type PaymentLike = { id: string; amount: number; phone: string; status: string; checkoutRequestId?: string | null; updatedAt?: Date | string | null };

export type PaymentSituation = {
  kind: PaymentSituationKind;
  draft: DraftLike | null;
  payment: PaymentLike | null;
  attempts: number;
  holdEndsAt: Date | null;
  promptAgeMs: number | null;
  paidBooking: { service: string; dateTime: Date } | null;
};

const timeOf = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// BookingDraft.version is bumped once per STK push, so attempts = version - 1.
export function draftVersion(draft: { version?: number | null } | null | undefined): number {
  return Number.isInteger(draft?.version) ? Number(draft?.version) : 1;
}

export function paymentAttempts(draft: DraftLike | null, payment: PaymentLike | null): number {
  return Math.max(draftVersion(draft) - 1, payment ? 1 : 0);
}

export function holdEndsAt(draft: DraftLike | null): Date | null {
  const updated = timeOf(draft?.updatedAt);
  return updated === null ? null : new Date(updated + PAYMENT_HOLD_MS);
}

export async function getPaymentSituation(customerId: string, now = Date.now(), includePaidBooking = true): Promise<PaymentSituation> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } }) as DraftLike | null;
  const base = { draft, payment: null, attempts: 0, holdEndsAt: null, promptAgeMs: null, paidBooking: null };

  if (draft?.step !== 'payment_pending') {
    if (draft || !includePaidBooking) return { ...base, kind: 'none' };
    const paid = await prisma.payment.findFirst({
      where: { status: 'success', booking: { customerId, status: 'confirmed', dateTime: { gte: new Date(now) } } },
      include: { booking: true },
      orderBy: { updatedAt: 'desc' },
    }) as (PaymentLike & { booking?: { service: string; dateTime: Date } | null }) | null;
    return paid?.booking
      ? { ...base, kind: 'paid', payment: paid, paidBooking: { service: paid.booking.service, dateTime: paid.booking.dateTime } }
      : { ...base, kind: 'none' };
  }

  const payment = await prisma.payment.findFirst({ where: { bookingDraftId: draft.id } }) as PaymentLike | null;
  const hold = holdEndsAt(draft);
  const situation = { ...base, payment, attempts: paymentAttempts(draft, payment), holdEndsAt: hold };
  if (payment?.status === 'success') return { ...situation, kind: 'paid' };
  if (hold && now > hold.getTime()) return { ...situation, kind: 'hold_expired' };

  const promptAt = timeOf(payment?.updatedAt) ?? timeOf(draft.updatedAt);
  const promptAgeMs = promptAt === null ? null : now - promptAt;
  if (!payment) {
    // A concurrent first push has claimed the draft but not recorded its payment row yet.
    return promptAgeMs !== null && promptAgeMs < PAYMENT_PROMPT_TIMEOUT_MS
      ? { ...situation, kind: 'prompt_sent', promptAgeMs }
      : { ...situation, kind: 'unrecorded', promptAgeMs };
  }
  if (payment.status === 'cancelled') return { ...situation, kind: 'cancelled', promptAgeMs };
  if (payment.status === 'failed') return { ...situation, kind: 'failed', promptAgeMs };
  return promptAgeMs !== null && promptAgeMs < PAYMENT_PROMPT_TIMEOUT_MS
    ? { ...situation, kind: 'prompt_sent', promptAgeMs }
    : { ...situation, kind: 'prompt_stale', promptAgeMs };
}

export function describeDarajaResult(code: unknown): { status: 'cancelled' | 'failed'; reason: string; waitFirst: boolean } {
  switch (Number(code)) {
    case 1032: return { status: 'cancelled', reason: 'The M-Pesa prompt was cancelled on your phone, so no payment was taken.', waitFirst: false };
    case 1: return { status: 'failed', reason: 'M-Pesa reported insufficient funds, so no payment was taken.', waitFirst: false };
    case 2001: return { status: 'failed', reason: 'The M-Pesa PIN entered was not accepted, so no payment was taken.', waitFirst: false };
    case 1019:
    case 1037: return { status: 'failed', reason: 'The M-Pesa prompt timed out before it was completed, so no payment was taken.', waitFirst: false };
    case 1001: return { status: 'failed', reason: 'M-Pesa says another transaction is already in progress on your line, so no payment was taken.', waitFirst: true };
    default: return { status: 'failed', reason: 'M-Pesa could not complete the payment, so no payment was taken.', waitFirst: false };
  }
}

const holdLine = (hold: Date | null) => hold ? ` Your slot is held until ${inBusinessTimezone(hold).format('h:mm A')}.` : '';
const lastDigits = (phone: string) => phone.replace(/\D/g, '').slice(-3);
export const paymentAttemptsExhaustedReply = () => `I've sent the M-Pesa prompt a few times now, so I won't send another. Please check your M-Pesa line, or contact the studio team on ${STUDIO_CONTACT} to finish your booking.`;
const exhaustedText = paymentAttemptsExhaustedReply;
const resendOffer = (attempts: number) => attempts >= MAX_PAYMENT_ATTEMPTS ? exhaustedText() : "Reply yes and I'll send a new one.";
const slotText = (draft: DraftLike) => draft.date && draft.time
  ? `${businessDay(draft.date).format('dddd, D MMMM')} at ${formatCustomerTime(draft.time)}`
  : 'your requested time';

export function paymentFailureMessage(code: unknown, draft: DraftLike | null): string {
  const { reason, waitFirst } = describeDarajaResult(code);
  if (!draft) return `${reason} The studio team will help you complete the payment.`;
  const attempts = draftVersion(draft) - 1;
  const next = attempts >= MAX_PAYMENT_ATTEMPTS
    ? exhaustedText()
    : waitFirst ? "Please wait a minute, then reply yes and I'll send a new prompt." : "Reply yes and I'll send a new prompt.";
  return `${reason}${holdLine(holdEndsAt(draft))} ${next}`;
}

export function extractReceiptCode(message: string): string | null {
  const match = message.match(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{10}\b/i);
  return match ? match[0].toUpperCase() : null;
}

export function classifyPaymentMessage(message: string): PaymentMessageKind | null {
  const text = message.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return null;
  if (/\b(?:cancel\w*|stop|reschedul\w*|postpone)\b/.test(text)) return null;

  if (/\b(?:has ?n'?t|have ?n'?t|did ?n'?t|not|never|no|nothing)\b[^.?!]{0,30}\b(?:arriv\w*|c[ao]me|receiv\w*|got|gotten|get|pop\w*|show\w*|reach\w*|seen?)\b/.test(text)) return 'not_arrived';
  if (/\b(?:i|we)(?:'ve| have)? (?:already |just )?(?:paid|completed (?:the )?payment|entered (?:my |the )?pin|sent (?:you )?(?:the )?(?:money|payment|deposit|cash))\b|\balready paid\b|\bdone paying\b|\bpayment (?:is )?(?:done|made|complete[d]?)\b/.test(text)) return 'paid_claim';
  if (extractReceiptCode(message) && text.split(' ').length <= 12) return 'receipt';
  if (/\b(?:did|has|have|was|is)\b[^?]{0,25}\b(?:go(?:ne)? through|went through|successful|received|reflect\w*)\b|\bpayment status\b|\bdid you (?:get|receive)\b/.test(text)) return 'status_check';
  if (/\b(?:start (?:again|over|afresh)|begin again|from scratch)\b/.test(text)) return 'restart';

  if (/\b(?:no|not|don'?t|do not|wait|hold on|later)\b/.test(text)) return null;
  if (/\bre-?send\b|\bre-?try\b|\btry (?:it |that |this )?again\b|\b(?:send|do|push) (?:it |that |this |the prompt |the payment |the request )?again\b|\b(?:one more|last|another) time\b|\bnew (?:prompt|one|request)\b/.test(text)) return 'resend';
  if (/^(?:yes+|yeah|yep|yea|ndio|confirm(?:ed)?|go[\s-]?ahead|proceed|please do|sure)\b/.test(text)
    || /\b(?:finish|complete|make|do) (?:the |my |this )?payment\b|\bsend (?:it|the prompt)\b|\bpay (?:now|it|the deposit)\b|^(?:let'?s|let us) do it(?: then)?$/.test(text)) return 'consent';
  return null;
}

function promptSentReply(s: PaymentSituation, phoneFallback: string, alreadySent: boolean): string {
  const amount = s.payment ? ` for Ksh ${s.payment.amount.toLocaleString()}` : '';
  const digits = lastDigits(s.payment?.phone || phoneFallback);
  const lead = alreadySent ? `I’ve already sent the M-Pesa deposit prompt${amount} to the number ending ${digits}.` : `I sent the M-Pesa prompt${amount} to the number ending ${digits}.`;
  return `${lead} Please enter your M-Pesa PIN on your phone to complete it.${holdLine(s.holdEndsAt)} If it hasn't arrived, reply resend.`;
}

function situationReply(s: PaymentSituation, customerId: string): string {
  switch (s.kind) {
    case 'prompt_sent': return promptSentReply(s, customerId, false);
    case 'prompt_stale': return `The M-Pesa prompt${s.payment ? ` for Ksh ${s.payment.amount.toLocaleString()}` : ''} may have timed out without being completed, and I can't see a payment yet.${holdLine(s.holdEndsAt)} ${resendOffer(s.attempts)}`;
    case 'cancelled': return `That M-Pesa prompt was cancelled, so no payment was taken.${holdLine(s.holdEndsAt)} ${resendOffer(s.attempts)}`;
    case 'failed': return `The last M-Pesa prompt did not go through, so no payment was taken.${holdLine(s.holdEndsAt)} ${resendOffer(s.attempts)}`;
    case 'hold_expired': return s.attempts >= MAX_PAYMENT_ATTEMPTS ? exhaustedText() : "Your 15-minute hold on this slot has ended and I can't see a payment. Reply yes and I'll check the slot is still free.";
    case 'unrecorded': return PAYMENT_PROMPT_UNRECORDED_REPLY;
    default: return paidReply(s);
  }
}

function paidReply(s: PaymentSituation): string {
  if (!s.paidBooking) return "Your payment has been received. I'm confirming your booking now and will send the details shortly.";
  const when = inBusinessTimezone(s.paidBooking.dateTime);
  return `Your payment is confirmed and your session for ${editionInText(s.paidBooking.service)} on ${when.format('dddd, D MMMM YYYY')} at ${when.format('h:mm A')} is booked.`;
}

function notArrivedReply(s: PaymentSituation, customerId: string): string {
  if (s.kind !== 'prompt_sent' && s.kind !== 'prompt_stale') return situationReply(s, customerId);
  const next = s.attempts >= MAX_PAYMENT_ATTEMPTS
    ? exhaustedText()
    : `Reply resend and I'll send a new prompt, or reach the studio team on ${STUDIO_CONTACT}.`;
  return `I sent the prompt to the number ending ${lastDigits(s.payment?.phone || customerId)}. Please check that your phone is on, has signal, and that the M-Pesa SIM is active.${holdLine(s.holdEndsAt)} ${next}`;
}

async function escalateAttemptsExhausted(this: any, customerId: string, s: PaymentSituation): Promise<string> {
  const draft = s.draft!;
  await this.escalate(customerId, 'booking', `Payment prompt limit reached: ${s.attempts} M-Pesa prompts for ${draft.service || 'the booking'} on ${draft.date || 'unknown date'} ${draft.time || ''} did not complete (last status: ${s.payment?.status || 'none'}). No further prompts will be sent automatically. Contact the customer to finish the booking.`);
  return exhaustedText();
}

async function recheckExpiredHold(this: any, customerId: string, s: PaymentSituation): Promise<string> {
  if (s.attempts >= MAX_PAYMENT_ATTEMPTS) return escalateAttemptsExhausted.call(this, customerId, s);
  const draft = s.draft!;
  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => draft.service?.toLowerCase().includes(key));
  if (!serviceKey || !draft.date || !draft.time) {
    return `Your 15-minute hold has ended. The studio team will help you rebook on ${STUDIO_CONTACT}.`;
  }
  const slots = await bookingService.getAvailableSlots(draft.date, SERVICE_DURATIONS[serviceKey], undefined, draft.id);
  const available: string[] = Array.isArray(slots) ? slots : [];
  if (available.includes(draft.time)) {
    const deposit = this.getDepositForPackage(await this.getPackageForDeposit(draft.service || ''));
    await prisma.bookingDraft.update({ where: { id: draft.id, step: 'payment_pending' }, data: { step: 'awaiting_confirmation' } });
    return `Your 15-minute hold ended, but ${slotText(draft)} is still free. ${buildBookingProposalConfirmation(draft.service || '', draft.date, draft.time, deposit)}`;
  }
  await prisma.bookingDraft.update({ where: { id: draft.id, step: 'payment_pending' }, data: { step: 'collecting_slots', time: null, dateTimeIso: null } });
  const alternatives = available.slice(0, 3).map(formatCustomerTime);
  const next = alternatives.length
    ? `Available times that day are ${alternatives.join(', ')}. Which would you prefer?`
    : 'That day is now fully booked. Which other date would suit you?';
  return `Your 15-minute hold ended and ${slotText(draft)} has since been booked, so no payment prompt was sent. ${editionInText(draft.service || '')} is still selected for you. ${next}`;
}

async function resendPrompt(this: any, customerId: string, s: PaymentSituation): Promise<string> {
  if (s.attempts >= MAX_PAYMENT_ATTEMPTS) return escalateAttemptsExhausted.call(this, customerId, s);
  const draft = s.draft!;
  const payment = s.payment;
  if (!payment) return PAYMENT_PROMPT_UNRECORDED_REPLY;
  const version = draftVersion(draft);

  // Compare-and-set on the draft version: a duplicate "yes" loses here and never pushes.
  try {
    await prisma.bookingDraft.update({
      where: { id: draft.id, step: 'payment_pending', ...(Number.isInteger(draft.version) ? { version } : {}) },
      data: { version: version + 1, updatedAt: new Date() },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') return promptSentReply({ ...s, kind: 'prompt_sent' }, customerId, true);
    throw error;
  }
  await prisma.payment.update({ where: { id: payment.id }, data: { status: 'pending', checkoutRequestId: null } });

  let checkoutRequestId: string;
  try {
    checkoutRequestId = (await mpesaService.initiateStkPush(customerId, payment.amount, draft.id)).CheckoutRequestID;
  } catch (error) {
    console.error('[PAYMENT_RECOVERY] STK resend failed:', error);
    await prisma.payment.update({ where: { id: payment.id }, data: { status: payment.status, checkoutRequestId: payment.checkoutRequestId ?? null } }).catch(() => {});
    await prisma.bookingDraft.update({ where: { id: draft.id }, data: { version } }).catch(() => {});
    return `I couldn't send a new prompt just now. Please try again in a minute, or contact the studio team on ${STUDIO_CONTACT}.`;
  }
  try {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'pending', checkoutRequestId } });
  } catch (error) {
    console.error('[PAYMENT_RECOVERY] STK resend could not be recorded:', error);
    return PAYMENT_PROMPT_UNRECORDED_REPLY;
  }
  const hold = new Date(Date.now() + PAYMENT_HOLD_MS);
  return `I've sent a new M-Pesa prompt for Ksh ${payment.amount.toLocaleString()} to the number ending ${lastDigits(payment.phone || customerId)}. Please enter your PIN to complete it.${holdLine(hold)}`;
}

async function handlePaidClaim(this: any, customerId: string, message: string, s: PaymentSituation): Promise<string> {
  const code = extractReceiptCode(message);
  const draft = s.draft;
  const context = draft ? `${draft.service || 'booking'} on ${draft.date || 'unknown date'} ${draft.time || ''}` : 'no open booking draft';
  await this.escalate(customerId, 'booking', code
    ? `Customer shared M-Pesa receipt ${code} for ${context}, but no successful M-Pesa callback is recorded. Verify the receipt before confirming the booking.`
    : `Customer says they paid for ${context}, but no successful M-Pesa callback is recorded. Receipt code requested; do not confirm until verified.`);
  return code
    ? `Thank you. I've passed receipt ${code} to the studio team to verify. Your booking will be confirmed once the payment is verified.`
    : "I can't see the payment yet. If you have the M-Pesa confirmation message, please share the receipt code and the team will verify it.";
}

export async function handlePaymentRecovery(this: any, customerId: string, message: string, forcedKind?: PaymentMessageKind): Promise<string | null> {
  const kind = forcedKind || classifyPaymentMessage(message);
  if (!kind) return null;
  const aboutPayment = kind === 'status_check' || kind === 'paid_claim' || /\b(?:pa(?:y|id|yment)\w*|m-?pesa|prompt|stk|deposit)\b/i.test(message);
  const s = await getPaymentSituation(customerId, Date.now(), aboutPayment);

  if (s.draft?.step !== 'payment_pending') {
    if (s.kind === 'paid') return paidReply(s);
    return kind === 'paid_claim' && !s.draft ? handlePaidClaim.call(this, customerId, message, s) : null;
  }
  if (s.kind === 'paid') return paidReply(s);

  switch (kind) {
    case 'paid_claim':
    case 'receipt':
      return handlePaidClaim.call(this, customerId, message, s);
    case 'status_check':
      return situationReply(s, customerId);
    case 'not_arrived':
      return notArrivedReply(s, customerId);
    case 'restart':
      if (s.kind === 'prompt_sent' || s.kind === 'unrecorded') return situationReply(s, customerId);
      return s.attempts >= MAX_PAYMENT_ATTEMPTS
        ? exhaustedText()
        : `Your booking for ${editionInText(s.draft?.service || '')} on ${slotText(s.draft!)} is still open. Reply yes and I'll send a new M-Pesa prompt. If you'd like to change the booking instead, the studio team can help on ${STUDIO_CONTACT}.`;
    default:
      if (s.kind === 'unrecorded') return PAYMENT_PROMPT_UNRECORDED_REPLY;
      if (s.kind === 'hold_expired') return recheckExpiredHold.call(this, customerId, s);
      if (s.kind === 'prompt_sent' && (kind === 'consent' || (s.promptAgeMs ?? 0) < RESEND_COOLDOWN_MS)) {
        return promptSentReply(s, customerId, true);
      }
      return resendPrompt.call(this, customerId, s);
  }
}

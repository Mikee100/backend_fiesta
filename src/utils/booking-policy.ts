export const RESCHEDULE_FORFEITURE_WINDOW_HOURS = 72;

const RESCHEDULE_FORFEITURE_WINDOW_MS = RESCHEDULE_FORFEITURE_WINDOW_HOURS * 60 * 60 * 1000;

export function getBookingPolicyWindow(bookingDateTime: Date, now = new Date()): {
  rescheduleForfeitsDeposit: boolean;
  cancellationRefundEligible: boolean;
} {
  const timeUntilBookingMs = bookingDateTime.getTime() - now.getTime();
  return {
    rescheduleForfeitsDeposit:
      timeUntilBookingMs >= 0 && timeUntilBookingMs < RESCHEDULE_FORFEITURE_WINDOW_MS,
    cancellationRefundEligible: timeUntilBookingMs > RESCHEDULE_FORFEITURE_WINDOW_MS,
  };
}
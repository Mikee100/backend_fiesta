import prisma from '../../config/prisma';

export function isBookingProcessRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(process\s+of\s+booking|booking\s+process|how\s+to\s+book|how\s+does\s+booking\s+work|what\s+does\s+booking\s+entail|steps\s+to\s+book|explain\s+booking)/.test(text);
}

export async function buildBookingProcessReply(this: any): Promise<string> {
  let startingDeposit: number | null = null;
  let location = '4th Avenue Parklands, Diamond Plaza Annex, 2nd Floor, Nairobi';

  try {
    startingDeposit = this.getDepositForPackage(await this.getPackageForDeposit());
  } catch {
    console.warn('Unable to resolve starting deposit for booking process reply.');
  }
  try {
    const studioInfo = await prisma.studioInfo.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { location: true },
    });
    if (studioInfo?.location?.trim()) location = studioInfo.location.trim();
  } catch (error) {
    console.error('Failed to resolve booking process location:', error);
  }

  return [
    'Great question. Booking is simple:',
    '1) Choose your package.',
    '2) Share your preferred date and time (we are closed on Mondays).',
    '3) Choose any optional add-ons if you wish (extra outfit, wig hire, extra photos, etc. — completely optional!).',
    startingDeposit === null
      ? '4) We confirm availability, and the studio team will confirm the deposit amount before any M-Pesa prompt is sent.'
      : `4) We confirm availability and send an M-Pesa deposit prompt (starting from Ksh ${startingDeposit.toLocaleString()}).`,
    '5) Once deposit is received, your booking is confirmed and reminders are scheduled.',
    `6) Come for your session at ${location}.`,
    '7) Pay the remaining balance after the shoot (M-Pesa or cash).',
    '',
    "If you're ready, tell me your package and preferred date/time and I'll check slots now."
  ].join('\n');
}
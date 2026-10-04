import prisma from '../../config/prisma';

export function isBookingProcessRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(process\s+of\s+booking|booking\s+process|how\s+to\s+book|how\s+do\s+i\s+book|how\s+does\s+booking\s+work|what\s+does\s+booking\s+entail|steps\s+to\s+book|explain\s+booking)/.test(text);
}

export async function buildBookingProcessReply(this: any): Promise<string> {
  let depositText = 'We quote your deposit once you choose an edition; the studio team will confirm it before any payment prompt is sent.';
  let editionCount: number | null = null;
  let location = '4th Avenue Parklands, Diamond Plaza Annex, 2nd Floor, Nairobi';

  try {
    const packages = await prisma.package.findMany({ select: { name: true, deposit: true } });
    if (packages.length) {
      editionCount = packages.length;
      const deposits: number[] = packages.map((pkg) => this.getDepositForPackage(pkg));
      const minimum = Math.min(...deposits);
      depositText = deposits.every((deposit) => deposit === minimum)
        ? `We check availability; a Ksh ${minimum.toLocaleString()} deposit secures your slot.`
        : `We check availability; deposits start from Ksh ${minimum.toLocaleString()}, and I'll quote the exact amount for your edition.`;
    }
  } catch {
    console.warn('Unable to validate all edition deposits for booking process reply.');
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
    'Here is how booking works:',
    editionCount === null ? '1. Choose your edition.' : `1. Choose from our ${editionCount} edition${editionCount === 1 ? '' : 's'}.`,
    '2. Share your preferred date and time. We are closed on Mondays.',
    '3. Add any optional extras you would like, such as an extra outfit, wig hire or extra photos.',
    `4. ${depositText}`,
    '5. Once you confirm the proposal, we send the M-Pesa prompt. Your booking is confirmed after the deposit is received.',
    `6. Come for your session at ${location}.`,
    '7. Pay the remaining balance after the shoot by M-Pesa or cash.',
    'Edited photos are ready 10 working days after the shoot and shared through a secure download link.',
    '',
    'Would you like to check available dates?'
  ].join('\n');
}
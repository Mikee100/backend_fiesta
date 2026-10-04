import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { DEFAULT_DURATION, PACKAGE_NAMES_FOR_EXTRACTION, SERVICE_DURATIONS } from '../../config/constants';
import { inBusinessTimezone } from '../../utils/time';
import { getDepositForPackage, getPackageForDeposit } from './booking-tools';

export function buildPackageCard(pkg: {
  name: string;
  price: number;
  duration: string;
  images: number;
  makeup: boolean;
  outfits: number;
  photobook: boolean;
  photobookSize: string | null;
  mount: boolean;
  balloonBackdrop: boolean;
  wig: boolean;
  notes: string | null;
}): string {
  const lowerName = pkg.name.toLowerCase();

  let badge = '';
  if (lowerName.includes('empress')) {
    badge = ' (Signature Edition - Most Loved)';
  } else if (lowerName.includes('goddess')) {
    badge = ' (Flagship Edition)';
  }

  const items: string[] = [];
  if (pkg.duration) items.push(`Session length: ${pkg.duration}`);
  if (pkg.images > 0) items.push(`${pkg.images} final edited photos`);
  if (pkg.makeup) items.push('Professional makeup');

  if (pkg.outfits > 0) {
    if (lowerName.includes('empress') || lowerName.includes('goddess')) {
      items.push(`${pkg.outfits} studio outfits with styling, including the Power Suit`);
    } else {
      items.push(`${pkg.outfits} studio outfit${pkg.outfits > 1 ? 's' : ''} with styling`);
    }
  }

  if (pkg.wig) {
    if (lowerName.includes('empress') || lowerName.includes('goddess')) {
      items.push('2 styled wigs');
    } else {
      items.push('1 styled wig');
    }
  }

  if (pkg.balloonBackdrop) {
    if (lowerName.includes('goddess')) {
      items.push('Custom balloon backdrop or Goddess Sculpture Set');
    } else {
      items.push('Custom balloon backdrop with flowers');
    }
  }

  if (lowerName.includes('goddess')) {
    items.push('1 professionally produced Reel');
  }

  if (pkg.photobook) {
    const size = pkg.photobookSize ? ` (${pkg.photobookSize})` : '';
    items.push(`Hardcover photobook${size}`);
  }

  if (pkg.mount) {
    if (lowerName.includes('goddess')) {
      items.push('1 A2 fine art mount');
    } else {
      items.push('1 A3 fine art mount');
    }
  }

  return `${pkg.name} - Ksh ${pkg.price.toLocaleString()}${badge}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

export async function getPackageCatalogReply(showInclusions = false): Promise<string | null> {
  try {
    const packages = await prisma.package.findMany({
      orderBy: [{ price: 'asc' }, { name: 'asc' }],
      select: {
        name: true,
        price: true,
        duration: true,
        images: true,
        makeup: true,
        outfits: true,
        photobook: true,
        photobookSize: true,
        mount: true,
        balloonBackdrop: true,
        wig: true,
        notes: true,
      }
    });

    if (!packages.length) return null;

    const cards = packages.map((pkg) => buildPackageCard(pkg));
    const introduction = showInclusions ? 'Here is what each package includes:' : 'Here are our maternity packages:';
    const closing = showInclusions
      ? 'If one stands out, I can help you choose a date for it.'
      : 'Tell me which package you are considering, and I can explain its inclusions or help check available dates.';
    return `Fiesta House Maternity - Rate Card 2026\n\n${introduction}\n\n${cards.join('\n\n')}\n\n${closing}`;
  } catch (err) {
    console.error('Failed to build package catalog reply:', err);
    return null;
  }
}

export async function getPackageAdviceReply(userMessage: string): Promise<string | null> {
  const packages = await prisma.package.findMany({
    orderBy: [{ price: 'asc' }, { name: 'asc' }],
    select: {
      name: true,
      price: true,
      duration: true,
      images: true,
      makeup: true,
      outfits: true,
      photobook: true,
      photobookSize: true,
      mount: true,
      balloonBackdrop: true,
      wig: true,
      notes: true,
    },
  });

  const text = userMessage.toLowerCase();
  const mentionedPackages = packages.filter((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
  if (mentionedPackages.length >= 2) {
    const [first, second] = mentionedPackages;
    const differences: string[] = [];
    if (first.price !== second.price) differences.push(`${first.name} is Ksh ${first.price.toLocaleString()}, while ${second.name} is Ksh ${second.price.toLocaleString()}`);
    if (first.images !== second.images) differences.push(`${first.name} includes ${first.images} edited images and ${second.name} includes ${second.images}`);
    if (first.duration !== second.duration) differences.push(`${first.name} is ${first.duration}, while ${second.name} is ${second.duration}`);
    if (first.photobook !== second.photobook) differences.push(second.photobook ? `${second.name} includes an ${second.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook') : `${first.name} includes an ${first.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook'));
    if (first.mount !== second.mount) differences.push(first.mount ? `${first.name} includes an A3 mount` : `${second.name} includes an A3 mount`);

    const higherValuePackage = first.price >= second.price ? first : second;
    const lowerCostPackage = higherValuePackage === first ? second : first;
    return `${differences.join('. ')}. ${higherValuePackage.name} makes sense if its extra inclusions matter to you; ${lowerCostPackage.name} is the lower-cost option. Will your older child be joining you in the shoot?`;
  }

  const higherValue = packages.find((pkg) => ['the empress', 'the goddess', 'the queen', 'the legend'].includes(pkg.name.toLowerCase())) || packages[packages.length - 1];
  const lowerCost = packages.find((pkg) => ['the icon', 'the muse', 'the bloom'].includes(pkg.name.toLowerCase())) || packages[0];
  if (!higherValue || !lowerCost) return null;

  const higherPhotobookInfo = higherValue.photobook ? ` and a photobook` : '';
  return `Congratulations on your pregnancy! I would lean toward ${higherValue.name} if you would enjoy more variety: it includes ${higherValue.images} edited images${higherPhotobookInfo} for Ksh ${higherValue.price.toLocaleString()}. ${lowerCost.name} is Ksh ${lowerCost.price.toLocaleString()} and includes ${lowerCost.images} edited images, so it is a lovely option as well. Will your partner or family be joining you in the shoot?`;
}

export async function getPackageSelectionReply(customerId: string, userMessage: string): Promise<string | null> {
  const text = userMessage.toLowerCase();
  const packages = await prisma.package.findMany({ select: { name: true, deposit: true } });
  const selectedPackage = packages.find((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
  if (!selectedPackage) return null;

  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft?.step === 'awaiting_confirmation' && draft.date && draft.time && draft.dateTimeIso) {
    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => selectedPackage.name.toLowerCase().includes(key));
    const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
    const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);

    if (!Array.isArray(slotsResult)) {
      return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
    }

    if (!slotsResult.includes(draft.time)) {
      const alternatives = slotsResult.slice(0, 3).join(', ');
      return `${selectedPackage.name} needs a different amount of time, and ${draft.time} is not free on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
    }

    let deposit: number;
    try {
      deposit = getDepositForPackage(selectedPackage);
    } catch {
      console.warn('Unable to resolve package-selection deposit.');
      return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The studio team will confirm the deposit before any payment prompt is sent.`;
    }
    await prisma.bookingDraft.update({
      where: { customerId },
      data: { service: selectedPackage.name, step: 'awaiting_confirmation' },
    });

    return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
  }

  return `${selectedPackage.name} is a lovely choice. What date are you considering? Once you have a day in mind, I can check the available times for you.`;
}

export async function getSameBookingSlotReply(
  customerId: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string | null> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft?.step !== 'awaiting_confirmation' || !draft.date || !draft.time || !draft.dateTimeIso || !draft.service) {
    return null;
  }

  const packages = await prisma.package.findMany({ select: { name: true } });
  const selectedPackage = history
    .filter((message) => message.role === 'user')
    .reverse()
    .map((message) => packages.find((pkg) => message.content.toLowerCase().includes(pkg.name.replace(/ package$/i, '').toLowerCase())))
    .find((pkg): pkg is { name: string } => Boolean(pkg));
  const packageToUse = selectedPackage || packages.find((pkg) => pkg.name === draft.service);
  if (!packageToUse) return null;

  let deposit: number;
  try {
    deposit = getDepositForPackage(await getPackageForDeposit(packageToUse.name));
  } catch {
    console.warn('Unable to resolve same-slot package deposit.');
    return 'I have the session details, but the studio team will confirm the deposit before I send a payment proposal.';
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => packageToUse.name.toLowerCase().includes(key));
  const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
  const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);
  if (!Array.isArray(slotsResult)) {
    return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
  }
  if (!slotsResult.includes(draft.time)) {
    const alternatives = slotsResult.slice(0, 3).join(', ');
    return `${packageToUse.name} is not available at ${draft.time} on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
  }

  await prisma.bookingDraft.update({
    where: { customerId },
    data: { service: packageToUse.name, step: 'awaiting_confirmation' },
  });

  return `${packageToUse.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes and I will send the M-Pesa prompt.`;
}

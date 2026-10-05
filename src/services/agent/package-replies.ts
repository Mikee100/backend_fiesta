import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { DEFAULT_DURATION, EDITIONS_PENDING_OWNER_CONFIRMATION, PACKAGE_NAMES_FOR_EXTRACTION, SERVICE_DURATIONS } from '../../config/constants';
import { EDITION_CATALOG_HEADER, EDITION_CATALOG_INTRO, EDITION_CATALOG_FOLLOW_UP, OFFICIAL_WEBSITE_URLS } from './constants';
import { differingInclusionFields, SEED_EDITION_INCLUSIONS } from '../../config/edition-inclusions';
import { inBusinessTimezone } from '../../utils/time';
import { getDepositForPackage, getPackageForDeposit } from './booking-tools';
import { editionInText } from './reply-voice';
import { selectedEdition } from './conversation-flow.matcher';

export function editionSelectedDateQuestion(name: string): string {
  const title = name.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return `${title} it is. What date would suit you? You can see everything included here: ${OFFICIAL_WEBSITE_URLS.packages}`;
}

export function buildPackageCard(pkg: {
  name: string;
  price: number;
  duration: string;
  images: number;
  makeup: boolean;
  outfits: number;
  styling?: boolean;
  photobook: boolean;
  photobookSize: string | null;
  mount: boolean;
  balloonBackdrop: boolean;
  wig: boolean;
  notes: string | null;
  inclusions?: readonly string[] | null;
}): string {
  const inclusions = pkg.inclusions?.length ? pkg.inclusions
    : differingInclusionFields(pkg.name, pkg).length === 0 ? SEED_EDITION_INCLUSIONS[pkg.name]?.inclusions : undefined;
  if (inclusions) {
    const visible = pkg.name === 'THE LEGEND' ? inclusions.filter(item => !/\bwig/i.test(item)) : inclusions;
    return `${pkg.name} - Ksh ${pkg.price.toLocaleString()}\n${visible.map((item) => `- ${item}`).join('\n')}${pkg.name === 'THE LEGEND' ? '\nThe team will confirm the remaining inclusions for you.' : ''}`;
  }
  const items: string[] = [];
  if (pkg.duration) items.push(`Session length: ${pkg.duration}`);
  if (pkg.images > 0) items.push(`${pkg.images} final edited photos`);
  if (pkg.makeup) items.push('Professional makeup');

  if (pkg.outfits > 0) {
    items.push(`${pkg.outfits} outfit${pkg.outfits > 1 ? 's' : ''}`);
  }
  if (pkg.styling) items.push('Styling');

  if (pkg.wig && pkg.name !== 'THE LEGEND') {
    items.push('Styled wig included (quantity to be confirmed)');
  }

  if (pkg.balloonBackdrop) {
    items.push('Balloon backdrop (design to be confirmed)');
  }

  if (pkg.photobook) {
    const size = pkg.photobookSize ? ` (${pkg.photobookSize})` : '';
    items.push(`Photobook${size}`);
  }

  if (pkg.mount) {
    items.push('Photo mount (size to be confirmed)');
  }

  return `${pkg.name} - Ksh ${pkg.price.toLocaleString()}\n${items.map((item) => `- ${item}`).join('\n')}`;
}

export async function getPackageCatalogReply(_showInclusions = false, userMessage = ''): Promise<string | null> {
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
        styling: true,
        photobook: true,
        photobookSize: true,
        mount: true,
        balloonBackdrop: true,
        wig: true,
        notes: true,
      }
    });

    if (!packages.length) return null;

    const editions = packages.filter((pkg) => PACKAGE_NAMES_FOR_EXTRACTION.some((name) => name === pkg.name));
    if (!editions.length) return null;
    const needsReview = (pkg: typeof editions[number]) => {
      const differences = differingInclusionFields(pkg.name, pkg);
      if (differences.length) console.warn('Edition fields disagree with seed inclusion reference:', pkg.name, differences.join(', '));
      return EDITIONS_PENDING_OWNER_CONFIRMATION.includes(pkg.name)
        || differences.length > 0;
    };
    const requested = editions.filter((pkg) => new RegExp(`\\b${pkg.name.replace(/^THE /, '')}\\b`, 'i').test(userMessage));
    if (requested.length === 1) {
      const edition = requested[0];
      return needsReview(edition)
        ? 'The team will confirm the exact inclusions for you.'
        : buildPackageCard({ ...edition, inclusions: SEED_EDITION_INCLUSIONS[edition.name]?.inclusions });
    }
    const overview = editions.map((pkg) => needsReview(pkg)
      ? `${pkg.name} - Ksh ${pkg.price.toLocaleString()} | Ask me for details`
      : `${pkg.name} - Ksh ${pkg.price.toLocaleString()} | ${pkg.duration} | ${pkg.images} edited photos`);
    return `${EDITION_CATALOG_HEADER}\n\n${EDITION_CATALOG_INTRO}\n${overview.join('\n')}\n\n${EDITION_CATALOG_FOLLOW_UP}`;
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
  const mentionedPackages = packages.filter((pkg) => new RegExp(`\\b${pkg.name.replace(/^THE /, '').replace(/ package$/i, '')}\\b`, 'i').test(text));
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
  const chosen = selectedEdition(userMessage);
  const selectedPackage = (chosen && packages.find((pkg) => pkg.name.toUpperCase() === chosen))
    || packages.find((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
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

  if (draft?.step && !['collecting_slots', 'service'].includes(draft.step)) return null;
  if (!draft?.date) return editionSelectedDateQuestion(selectedPackage.name);
  if (!draft.time) return `You've chosen ${editionInText(selectedPackage.name)}. What time would suit you?`;
  return `Your details for ${editionInText(selectedPackage.name)} are noted. Would you like to go ahead?`;
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

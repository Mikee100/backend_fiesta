import prisma from '../src/config/prisma';

type ParsedNote = {
  method?: 'email' | 'whatsapp' | 'download_link';
  email?: string;
  whatsapp?: string;
  note?: string;
};

function isPlaceholderContactEmail(email?: string | null): boolean {
  if (!email) return true;
  const value = email.trim().toLowerCase();
  if (!value) return true;
  return (
    value.endsWith('@whatsapp.local') ||
    value.endsWith('@messenger.local') ||
    value.endsWith('@instagram.local')
  );
}

function parseDeliveryPreference(description: string): ParsedNote {
  const text = description || '';
  const method = text.match(/delivery\s+preference\s*:\s*(email|whatsapp|download_link)/i)?.[1]?.toLowerCase() as
    | 'email'
    | 'whatsapp'
    | 'download_link'
    | undefined;

  const email = text.match(/email\s*:\s*([^|]+)/i)?.[1]?.trim();
  const whatsapp = text.match(/whatsapp\s*:\s*([^|]+)/i)?.[1]?.trim();
  const note = text.match(/note\s*:\s*([^|]+)/i)?.[1]?.trim();

  return { method, email, whatsapp, note };
}

function buildCanonicalDescription(parsed: ParsedNote, customerId: string, customerPhone?: string | null, customerEmail?: string | null): string | null {
  if (!parsed.method) return null;

  if (parsed.method === 'whatsapp') {
    const resolvedPhone = parsed.whatsapp || customerPhone || customerId;
    const parts = [`Delivery preference: whatsapp`, `WhatsApp: ${resolvedPhone}`];
    if (parsed.note) parts.push(`Note: ${parsed.note}`);
    return parts.join(' | ');
  }

  if (parsed.method === 'email') {
    const resolvedEmail = parsed.email || (!isPlaceholderContactEmail(customerEmail) ? customerEmail?.trim().toLowerCase() : undefined);
    const parts = [`Delivery preference: email`];
    if (resolvedEmail) parts.push(`Email: ${resolvedEmail}`);
    if (parsed.note) parts.push(`Note: ${parsed.note}`);
    return parts.join(' | ');
  }

  const parts = [`Delivery preference: download_link`];
  if (parsed.note) parts.push(`Note: ${parsed.note}`);
  return parts.join(' | ');
}

async function main() {
  const shouldApply = process.argv.includes('--apply');

  const notes = await prisma.customerSessionNote.findMany({
    where: {
      type: 'special_request',
      description: {
        contains: 'Delivery preference:',
        mode: 'insensitive',
      },
    },
    include: {
      customer: {
        select: { phone: true, email: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  let inspected = 0;
  let toUpdate = 0;

  for (const note of notes) {
    inspected++;
    const oldDescription = (note.description || '').trim();
    const oldSourceMessage = (note.sourceMessage || '').trim();
    const parsed = parseDeliveryPreference(oldDescription);

    const normalizedDescription = buildCanonicalDescription(
      parsed,
      note.customerId,
      note.customer?.phone,
      note.customer?.email,
    );

    if (!normalizedDescription) continue;

    const nextSourceMessage =
      oldSourceMessage && oldSourceMessage !== oldDescription && !oldSourceMessage.toLowerCase().startsWith('delivery preference:')
        ? oldSourceMessage
        : null;

    const descriptionChanged = normalizedDescription !== oldDescription;
    const sourceChanged = (note.sourceMessage || null) !== nextSourceMessage;

    if (!descriptionChanged && !sourceChanged) continue;

    toUpdate++;

    if (!shouldApply) {
      console.log(`DRY-RUN: ${note.id}`);
      console.log(`  old: ${oldDescription}`);
      console.log(`  new: ${normalizedDescription}`);
      if (sourceChanged) {
        console.log(`  sourceMessage: ${(note.sourceMessage || '').trim() || '<empty>'} -> ${nextSourceMessage || '<null>'}`);
      }
      continue;
    }

    await prisma.customerSessionNote.update({
      where: { id: note.id },
      data: {
        description: normalizedDescription,
        sourceMessage: nextSourceMessage,
      },
    });
  }

  console.log(`Inspected: ${inspected}`);
  console.log(`${shouldApply ? 'Updated' : 'Would update'}: ${toUpdate}`);
  console.log(shouldApply ? 'Applied changes successfully.' : 'Dry-run complete. Re-run with --apply to persist changes.');
}

main()
  .catch((err) => {
    console.error('normalize-delivery-preference-notes failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

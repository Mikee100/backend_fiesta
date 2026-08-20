import prisma from '../src/config/prisma';

function isLikelyPhone(value: string): boolean {
  return /^\+?\d{8,}$/.test(value);
}

async function main() {
  const shouldApply = process.argv.includes('--apply');

  const whatsappMessageRows = await prisma.message.findMany({
    where: { platform: 'whatsapp' },
    select: { customerId: true },
    distinct: ['customerId'],
  });

  const whatsappCustomerIds = whatsappMessageRows.map((r) => r.customerId);
  if (whatsappCustomerIds.length === 0) {
    console.log('No WhatsApp customers found from message history.');
    return;
  }

  const customers = await prisma.customer.findMany({
    where: {
      id: { in: whatsappCustomerIds },
      OR: [
        { phone: null },
        { phone: '' },
        { whatsappId: null },
        { whatsappId: '' },
      ],
    },
    select: {
      id: true,
      phone: true,
      whatsappId: true,
      name: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  let inspected = 0;
  let updated = 0;
  let skipped = 0;

  for (const customer of customers) {
    inspected++;

    const fallbackPhone = customer.whatsappId || (isLikelyPhone(customer.id) ? customer.id : undefined);
    const currentPhone = customer.phone?.trim() || undefined;
    const currentWhatsappId = customer.whatsappId?.trim() || undefined;

    const nextPhone = currentPhone || fallbackPhone;
    const nextWhatsappId = currentWhatsappId || (isLikelyPhone(customer.id) ? customer.id : undefined);

    if (!nextPhone && !nextWhatsappId) {
      skipped++;
      console.log(`SKIP: ${customer.id} (${customer.name}) has no safe WhatsApp identifier to backfill.`);
      continue;
    }

    const phoneChanged = (currentPhone || null) !== (nextPhone || null);
    const whatsappChanged = (currentWhatsappId || null) !== (nextWhatsappId || null);

    if (!phoneChanged && !whatsappChanged) continue;

    if (!shouldApply) {
      console.log(`DRY-RUN: ${customer.id}`);
      console.log(`  phone: ${currentPhone || '<null>'} -> ${nextPhone || '<null>'}`);
      console.log(`  whatsappId: ${currentWhatsappId || '<null>'} -> ${nextWhatsappId || '<null>'}`);
      updated++;
      continue;
    }

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        phone: nextPhone,
        whatsappId: nextWhatsappId,
      },
    });

    updated++;
  }

  console.log(`Inspected: ${inspected}`);
  console.log(`${shouldApply ? 'Updated' : 'Would update'}: ${updated}`);
  console.log(`Skipped (unsafe): ${skipped}`);
  console.log(shouldApply ? 'Applied successfully.' : 'Dry-run complete. Re-run with --apply to persist.');
}

main()
  .catch((err) => {
    console.error('backfill-whatsapp-customers failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

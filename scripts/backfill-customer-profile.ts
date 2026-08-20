import prisma from '../src/config/prisma';

async function main() {
  const id = process.argv[2];
  if (!id) {
    throw new Error('Usage: ts-node scripts/backfill-customer-profile.ts <customerId>');
  }

  const updated = await prisma.customer.update({
    where: { id },
    data: {
      phone: id,
      whatsappId: id,
    },
  });

  console.log('Updated customer:', {
    id: updated.id,
    phone: updated.phone,
    whatsappId: updated.whatsappId,
  });
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

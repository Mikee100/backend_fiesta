import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DIRECT_URL,
    },
  },
});

async function checkStatus() {
  console.log('--- Recent Payments ---');
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { bookingDraft: true, booking: true }
  });
  console.log(JSON.stringify(payments, null, 2));

  console.log('\n--- Recent Booking Drafts ---');
  const drafts = await prisma.bookingDraft.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(drafts, null, 2));

  console.log('\n--- Recent Confirmed Bookings ---');
  const bookings = await prisma.booking.findMany({
    where: { status: 'confirmed' },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(bookings, null, 2));
}

checkStatus()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

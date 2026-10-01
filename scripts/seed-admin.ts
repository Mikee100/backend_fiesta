import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../src/config/prisma';

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || 'Fiesta House Admin';

  if (!email || !password) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD before running the admin seed command');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters long');
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, password: hashedPassword, name, role: 'admin' },
    update: { password: hashedPassword, name, role: 'admin', isActive: true },
    select: { email: true, name: true },
  });

  console.log(`Admin account ready for ${user.email}. Password was not printed.`);
}

seedAdmin()
  .catch((error: unknown) => {
    console.error('Admin account setup failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
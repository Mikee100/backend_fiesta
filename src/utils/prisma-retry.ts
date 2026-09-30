type PrismaConnectionLifecycle = {
  $disconnect: () => Promise<void>;
  $connect: () => Promise<void>;
};

export async function retryOnPrismaDisconnect<T>(
  prisma: PrismaConnectionLifecycle,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if ((error as { code?: string })?.code !== 'P1017') throw error;

    await prisma.$disconnect().catch(() => undefined);
    await prisma.$connect();
    return operation();
  }
}
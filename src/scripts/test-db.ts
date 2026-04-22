import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function testConnection() {
  console.log('🔍 Testing Database Connection...');
  console.log('📡 DATABASE_URL:', process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ':****@')); // Hide password

  try {
    // Attempt to connect and run a simple query
    await prisma.$connect();
    console.log('✅ Successfully connected to the database.');

    const count = await prisma.customer.count();
    console.log(`📊 Current Customer count: ${count}`);

    const bookingCount = await prisma.booking.count();
    console.log(`📊 Current Booking count: ${bookingCount}`);

    console.log('🚀 Database connectivity test PASSED.');
  } catch (error: any) {
    console.error('❌ Database connectivity test FAILED.');
    console.error('📝 Error Message:', error.message);
    
    if (error.message.includes('TLS connection')) {
      console.error('💡 Suggestion: Check if sslmode=require is needed in your DATABASE_URL.');
    }
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();

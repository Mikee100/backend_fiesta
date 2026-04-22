import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const prisma = new PrismaClient();

async function testConnection() {
  console.log('🔍 Testing Database Connection...');
  console.log('📡 DATABASE_URL:', process.env.DATABASE_URL?.replace(/:([^:@]+)@/, ':****@')); // Hide password

  try {
    // Attempt to connect and run a simple query
    await prisma.$connect();
    console.log('✅ Successfully connected to the database.');
    const count = await prisma.customer.count();
    console.log(`📊 Connection verified. Data found.`);
  } catch (error: any) {
    console.error('❌ Database connectivity test FAILED.');
    console.error('--------------------------------------------------');
    console.error('ERROR CODE:', error.code || 'N/A');
    console.error('MESSAGE:', error.message);
    console.error('--------------------------------------------------');
    
    if (error.message.includes('TLS connection') || error.message.includes('OpenSSL')) {
      console.error('💡 ANALYSIS: This is an SSL/TLS Handshake error.');
      console.error('👉 ACTION: In Render, try changing sslmode=require to sslmode=prefer or sslmode=no-verify (as a last resort).');
    } else if (error.message.includes('Authentication failed')) {
      console.error('💡 ANALYSIS: Password or Username is incorrect.');
    } else if (error.message.includes('reach database')) {
      console.error('💡 ANALYSIS: Network timeout. The database host might be blocked or wrong.');
    }
    
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();

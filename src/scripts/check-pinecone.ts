import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';

dotenv.config();

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!
});

async function checkIndex() {
  const indexName = process.env.PINECONE_INDEX_NAME || 'ai-business';
  try {
    const description = await pc.describeIndex(indexName);
    console.log('Index Description:', JSON.stringify(description, null, 2));
  } catch (err) {
    console.error('Failed to describe index:', err);
  }
}

checkIndex();

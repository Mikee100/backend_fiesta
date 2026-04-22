import fs from 'fs';
import path from 'path';
import { pineconeService } from '../services/knowledge/pinecone.service';

const EMBEDDINGS_FILE = path.resolve(__dirname, '../../docs/business_knowledge_embeddings.json');

async function migrate() {
  if (!fs.existsSync(EMBEDDINGS_FILE)) {
    console.error('Embeddings file not found at:', EMBEDDINGS_FILE);
    return;
  }

  const embeddingsDB = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf-8'));
  console.log(`Read ${embeddingsDB.length} chunks from local JSON.`);

  const pineconeVectors = embeddingsDB.map((item: any) => ({
    id: item.id,
    values: item.embedding,
    metadata: {
      content: item.content,
      source: item.source
    }
  }));

  console.log('Uploading to Pinecone...');
  // Pinecone recommends upserting in batches of 100
  const batchSize = 100;
  for (let i = 0; i < pineconeVectors.length; i += batchSize) {
    const batch = pineconeVectors.slice(i, i + batchSize);
    console.log(`Upserting batch ${i / batchSize + 1} (${batch.length} vectors)...`);
    await pineconeService.upsertVectors(batch);
  }

  console.log('Migration Complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', JSON.stringify(err, null, 2) || err);
});

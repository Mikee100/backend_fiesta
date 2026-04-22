import { Pinecone } from '@pinecone-database/pinecone';
import dotenv from 'dotenv';

dotenv.config();

const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!
});

const indexName = process.env.PINECONE_INDEX_NAME || 'ai-business';
const index = pc.index(indexName);

export interface VectorMetadata {
  content: string;
  source: string;
  [key: string]: any;
}

export class PineconeService {
  /**
   * Upserts vectors into Pinecone
   */
  async upsertVectors(vectors: { id: string, values: number[], metadata: VectorMetadata }[]) {
    console.log(`Upserting ${vectors.length} vectors to Pinecone index: ${indexName}...`);
    
    // Pinecone likes chunks for large upserts, but for small ones we can do all at once
    await index.upsert(vectors);
    
    console.log('Upsert successful.');
  }

  /**
   * Queries Pinecone for the top K most relevant vectors
   */
  async queryVectors(queryVector: number[], topK: number = 5) {
    const queryResponse = await index.query({
      vector: queryVector,
      topK: topK,
      includeMetadata: true,
    });

    return queryResponse.matches.map(match => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata as unknown as VectorMetadata
    }));
  }
}

export const pineconeService = new PineconeService();

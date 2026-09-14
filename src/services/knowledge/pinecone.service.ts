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
   * Upserts vectors into Pinecone (batched for larger corpora).
   */
  async upsertVectors(vectors: { id: string, values: number[], metadata: VectorMetadata }[]) {
    console.log(`Upserting ${vectors.length} vectors to Pinecone index: ${indexName}...`);

    const BATCH = 100;
    for (let i = 0; i < vectors.length; i += BATCH) {
      await index.upsert(vectors.slice(i, i + BATCH));
    }

    console.log('Upsert successful.');
  }

  /**
   * Lists all vector IDs currently in the index (paginated).
   */
  async listAllIds(): Promise<string[]> {
    const ids: string[] = [];
    let paginationToken: string | undefined;

    do {
      const page = await index.listPaginated({
        limit: 100,
        paginationToken,
      });
      for (const v of page.vectors || []) {
        if (v.id) ids.push(v.id);
      }
      paginationToken = page.pagination?.next;
    } while (paginationToken);

    return ids;
  }

  /**
   * Deletes specific vector IDs (batched). Prefer this over deleteAll for zero-downtime rebuilds.
   */
  async deleteIds(ids: string[]) {
    if (ids.length === 0) return;
    console.log(`Deleting ${ids.length} stale vectors from Pinecone index: ${indexName}...`);
    const BATCH = 1000;
    for (let i = 0; i < ids.length; i += BATCH) {
      await index.deleteMany(ids.slice(i, i + BATCH));
    }
  }

  /** @deprecated Prefer upsert-then-delete-orphans via replaceVectors() */
  async deleteAllVectors() {
    console.log(`Deleting existing vectors from Pinecone index: ${indexName}...`);
    await index.deleteAll();
  }

  /**
   * Non-destructive replace: upsert the new set first, then remove IDs that
   * are no longer present. Retrieval stays available throughout the rebuild.
   */
  async replaceVectors(vectors: { id: string, values: number[], metadata: VectorMetadata }[]) {
    const newIds = new Set(vectors.map((v) => v.id));
    let existingIds: string[] = [];
    try {
      existingIds = await this.listAllIds();
    } catch (err) {
      console.warn('Could not list existing Pinecone IDs before replace; proceeding with upsert only.', err);
    }

    await this.upsertVectors(vectors);

    const staleIds = existingIds.filter((id) => !newIds.has(id));
    if (staleIds.length > 0) {
      await this.deleteIds(staleIds);
      console.log(`Removed ${staleIds.length} orphaned vectors.`);
    } else {
      console.log('No orphaned vectors to remove.');
    }
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

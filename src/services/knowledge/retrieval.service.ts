import fs from 'fs';
import path from 'path';
import { pipeline as hfPipeline } from '@xenova/transformers';
import { pineconeService } from './pinecone.service';

export class KnowledgeRetrievalService {
  private embedder: any = null;

  async initEmbedder() {
    if (!this.embedder) {
      console.log('Loading Xenova Model for Retrieval...');
      this.embedder = await hfPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
  }

  /**
   * Searches the Pinecone vector database for the top K most relevant chunks.
   * Matches below minScore are dropped so weakly-related chunks don't get fed
   * to the LLM as if they were reliable business facts.
   *
   * The default was empirically measured against this dataset with
   * Xenova/all-MiniLM-L6-v2 (a small local embedding model that runs "cooler"
   * than commercial ones): genuinely unrelated queries score ~0.08-0.10, while
   * even the best possible exact-match answer tops out around 0.42-0.48.
   * 0.5 was filtering out real answers; 0.22 sits safely above the noise floor
   * without excluding legitimate matches.
   */
  async search(query: string, topK: number = 5, minScore: number = 0.22) {
    await this.initEmbedder();

    const queryOutput = await this.embedder(query, { pooling: 'mean', normalize: true });
    const queryVector = Array.from(queryOutput.data) as number[];

    const matches = await pineconeService.queryVectors(queryVector, topK);

    return matches
      .filter(match => (match.score || 0) >= minScore)
      .map(match => ({
        content: match.metadata.content,
        source: match.metadata.source,
        score: match.score || 0
      }));
  }
}

export const knowledgeRetrieval = new KnowledgeRetrievalService();

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
   * Searches the Pinecone vector database for the top K most relevant chunks
   */
  async search(query: string, topK: number = 5) {
    await this.initEmbedder();

    const queryOutput = await this.embedder(query, { pooling: 'mean', normalize: true });
    const queryVector = Array.from(queryOutput.data) as number[];

    const matches = await pineconeService.queryVectors(queryVector, topK);

    return matches.map(match => ({
      content: match.metadata.content,
      source: match.metadata.source,
      score: match.score || 0
    }));
  }
}

export const knowledgeRetrieval = new KnowledgeRetrievalService();

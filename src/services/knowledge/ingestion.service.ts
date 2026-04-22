import { pipeline as hfPipeline } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';
import { websiteScraper } from '../scraper/website.scraper';
import { socialScraper } from '../scraper/social.scraper';
import { chunkText } from '../../utils/chunking';
import { loadFaqChunks } from './faq_ingest';
import { pineconeService } from './pinecone.service';

const EMBEDDINGS_FILE = path.resolve(__dirname, '../../../docs/business_knowledge_embeddings.json');

export class KnowledgeIngestionService {
  private embedder: any = null;

  async initEmbedder() {
    if (!this.embedder) {
      console.log('Loading Xenova Model...');
      // All-MiniLM-L6-v2 is small, fast, and good for semantic search
      this.embedder = await hfPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
  }

  /**
   * Scrapes sources, chunks the text, creates embeddings, and saves them locally.
   * Can be hooked up to a cron job or manual trigger.
   */
  async runIngestion() {
    await this.initEmbedder();

    console.log('Step 1/3: Scraping Content...');
    const webData = await websiteScraper.scrapeAll();
    const socialData = await socialScraper.scrapeRecentPosts();

    const allSources = [...webData, ...socialData];
    const embeddingsDB: { id: string, content: string, embedding: number[], source: string }[] = [];

    console.log('Step 2/3: Chunking Text and Generating Embeddings...');
    let chunkId = 0;
    for (const data of allSources) {
      const chunks = chunkText(data.content);
      
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;

        const output = await this.embedder(chunk, { pooling: 'mean', normalize: true });
        const vector = Array.from(output.data) as number[];

        embeddingsDB.push({
          id: `chunk_${chunkId++}`,
          content: chunk,
          embedding: vector,
          source: data.url
        });
      }
    }

    // Load FAQ chunks
    const faqChunks = await loadFaqChunks(this.embedder, chunkText, chunkId);
    if (faqChunks.length > 0) {
      embeddingsDB.push(...faqChunks);
      chunkId += faqChunks.length;
      console.log(`Loaded ${faqChunks.length} FAQ chunks.`);
    }

    console.log('Step 3/3: Saving to Vector Databases...');
    
    // --- Pinecone Upsert ---
    try {
      const pineconeVectors = embeddingsDB.map(item => ({
        id: item.id,
        values: item.embedding,
        metadata: {
          content: item.content,
          source: item.source
        }
      }));

      await pineconeService.upsertVectors(pineconeVectors);
      console.log('Successfully upserted vectors to Pinecone.');
    } catch (error) {
      console.error('Failed to upsert to Pinecone:', error);
    }

    // --- Local JSON Backup ---
    const docsDir = path.dirname(EMBEDDINGS_FILE);
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(embeddingsDB, null, 2));
    console.log(`Ingestion Complete! Saved ${embeddingsDB.length} chunks to JSON and Pinecone.`);
    return embeddingsDB.length;
  }
}

export const knowledgeIngestion = new KnowledgeIngestionService();

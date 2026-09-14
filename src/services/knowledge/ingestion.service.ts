import { createHash } from 'crypto';
import { pipeline as hfPipeline } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';
import { websiteScraper } from '../scraper/website.scraper';
import { socialScraper } from '../scraper/social.scraper';
import { chunkText } from '../../utils/chunking';
import { loadFaqChunks } from './faq_ingest';
import { pineconeService } from './pinecone.service';

const EMBEDDINGS_FILE = path.resolve(__dirname, '../../../docs/business_knowledge_embeddings.json');

function stableVectorId(source: string, content: string, prefix: string): string {
  const hash = createHash('sha256').update(`${source}\n${content}`).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

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
   * Pinecone is updated with upsert-then-delete-orphans (no empty-index gap).
   */
  async runIngestion() {
    await this.initEmbedder();

    console.log('Step 1/3: Scraping Content...');
    const webData = await websiteScraper.scrapeAll();
    const socialData = await socialScraper.scrapeRecentPosts();
    // Guard: never embed synthetic placeholder social text into RAG
    const usableSocial = socialData.filter(
      (s) => s.content?.trim() && !/placeholder content for/i.test(s.content)
    );
    if (usableSocial.length < socialData.length) {
      console.warn(
        `[ingestion] Dropped ${socialData.length - usableSocial.length} placeholder/empty social chunk(s).`
      );
    }

    const allSources = [
      ...webData.map((d) => ({ url: d.url, content: d.content })),
      ...usableSocial.map((d) => ({ url: d.url, content: d.content })),
    ];
    const embeddingsDB: { id: string, content: string, embedding: number[], source: string }[] = [];
    const seenIds = new Set<string>();

    console.log('Step 2/3: Chunking Text and Generating Embeddings...');
    for (const data of allSources) {
      const chunks = chunkText(data.content);

      for (const chunk of chunks) {
        if (!chunk.trim()) continue;

        const id = stableVectorId(data.url, chunk, 'chunk');
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const output = await this.embedder(chunk, { pooling: 'mean', normalize: true });
        const vector = Array.from(output.data) as number[];

        embeddingsDB.push({
          id,
          content: chunk,
          embedding: vector,
          source: data.url
        });
      }
    }

    // Load FAQ chunks (stable hashed IDs from faq_ingest)
    const faqChunks = await loadFaqChunks(this.embedder, chunkText);
    for (const faq of faqChunks) {
      if (seenIds.has(faq.id)) continue;
      seenIds.add(faq.id);
      embeddingsDB.push(faq);
    }
    console.log(`Loaded ${faqChunks.length} FAQ chunks.`);

    console.log('Step 3/3: Saving to Vector Databases...');

    // --- Pinecone: upsert first, then delete orphans (non-destructive) ---
    try {
      const pineconeVectors = embeddingsDB.map(item => ({
        id: item.id,
        values: item.embedding,
        metadata: {
          content: item.content,
          source: item.source
        }
      }));

      await pineconeService.replaceVectors(pineconeVectors);
      console.log('Successfully replaced vectors in Pinecone (zero-downtime).');
    } catch (error) {
      console.error('Failed to upsert to Pinecone:', error);
      throw error;
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

import fs from 'fs';
import path from 'path';

export async function loadFaqChunks(embedder: any, chunkText: (text: string) => string[], startChunkId: number = 10000) {
  const faqPath = path.resolve(__dirname, '../../../knowledge_base_rows.json');
  if (!fs.existsSync(faqPath)) {
    console.log('No FAQ JSON found, skipping FAQ ingestion.');
    return [];
  }
  const faqData = JSON.parse(fs.readFileSync(faqPath, 'utf-8'));
  const faqChunks = [];
  let chunkId = startChunkId;
  for (const row of faqData) {
    const q = row.question?.trim();
    const a = row.answer?.trim();
    if (!q || !a) continue;
    // Optionally chunk long answers
    const answerChunks = chunkText(a);
    for (const chunk of answerChunks) {
      if (!chunk.trim()) continue;
      const output = await embedder(chunk, { pooling: 'mean', normalize: true });
      const vector = Array.from(output.data);
      faqChunks.push({
        id: `faq_${chunkId++}`,
        content: `${q}\n${chunk}`,
        embedding: vector,
        source: 'faq'
      });
    }
  }
  return faqChunks;
}

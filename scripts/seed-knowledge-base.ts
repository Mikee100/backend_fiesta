import fs from 'fs';
import path from 'path';
import prisma from '../src/config/prisma';

type RawKbRow = {
  question: string;
  answer: string;
  category: string;
  embedding?: string | number[];
  mediaUrls?: string | string[];
};

function parseEmbedding(value: RawKbRow['embedding']): number[] {
  if (Array.isArray(value)) return value.map(Number).filter((n) => Number.isFinite(n));
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function parseMediaUrls(value: RawKbRow['mediaUrls']): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function main() {
  const filePath = path.join(__dirname, 'knowledge_base_rows.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = JSON.parse(raw) as RawKbRow[];

  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const question = String(row.question || '').trim();
    const answer = String(row.answer || '').trim();
    const category = String(row.category || 'General').trim() || 'General';

    if (!question || !answer) continue;

    const record = {
      question,
      answer,
      category,
      embedding: parseEmbedding(row.embedding),
      mediaUrls: parseMediaUrls(row.mediaUrls),
    };

    const existing = await prisma.knowledgeBase.findUnique({ where: { question }, select: { id: true } });
    if (existing) {
      await prisma.knowledgeBase.update({ where: { question }, data: record });
      updated += 1;
    } else {
      await prisma.knowledgeBase.create({ data: record });
      created += 1;
    }
  }

  const total = await prisma.knowledgeBase.count();
  console.log(`Knowledge base seed complete. Created: ${created}, Updated: ${updated}, Total: ${total}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Knowledge base seed failed:', error);
  process.exit(1);
});

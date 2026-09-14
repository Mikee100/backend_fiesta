/**
 * Refresh knowledge end-to-end:
 *   1) Seed PostgreSQL KnowledgeBase from scripts/knowledge_base_rows.json
 *   2) Re-ingest into Pinecone (+ local embeddings backup)
 *
 * Always run both — seeding alone leaves RAG stale.
 *
 * Usage:
 *   npx ts-node scripts/refresh-knowledge.ts
 *   npm run knowledge:refresh
 */
import { spawn } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '..');

function run(label: string, scriptRelative: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label} ===`);
    // Avoid shell:true (DEP0190) — pass the executable + args directly.
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register', path.join(root, scriptRelative)],
      { cwd: root, stdio: 'inherit', env: process.env }
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  await run('1/2 Seed PostgreSQL knowledge base', 'scripts/seed-knowledge-base.ts');
  await run('2/2 Pinecone / embeddings ingestion', 'run_ingestion.ts');
  console.log('\nKnowledge refresh complete. Postgres + Pinecone are in sync.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

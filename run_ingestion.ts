import { knowledgeIngestion } from './src/services/knowledge/ingestion.service';

async function main() {
  try {
    console.log('Starting Knowledge Ingestion...');
    await knowledgeIngestion.runIngestion();
    console.log('Knowledge Ingestion finished successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Error running ingestion:', error);
    process.exit(1);
  }
}

main();

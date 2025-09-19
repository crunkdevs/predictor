import { ingestBatch } from '../src/utils/ingest.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestBatch().catch((e) => {
    console.error('ingest failed:', e);
    process.exit(1);
  });
}

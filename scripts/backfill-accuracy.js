import 'dotenv/config';
import { backfillPredictionCorrectness } from '../src/services/outcome.service.js';

async function run() {
  const days = process.argv[2] ? parseInt(process.argv[2], 10) : 30;

  if (!Number.isFinite(days) || days < 1 || days > 90) {
    console.error('Usage: node scripts/backfill-accuracy.js [days]');
    console.error('  days: Number of days to look back (1-90, default: 30)');
    process.exit(1);
  }

  console.log(`🔄 Starting accuracy backfill for last ${days} days...`);

  try {
    const stats = await backfillPredictionCorrectness(days, console);

    console.log('\n✅ Backfill complete!');
    console.log('Statistics:');
    console.log(`  Total predictions: ${stats.total}`);
    console.log(`  Updated: ${stats.updated}`);
    console.log(`  Unchanged: ${stats.unchanged}`);
    console.log(`  Errors: ${stats.errors}`);
    console.log(`  Correct: ${stats.correct}`);
    console.log(`  Wrong: ${stats.wrong}`);
    console.log(`  Accuracy: ${stats.accuracy_pct}%`);

    process.exit(0);
  } catch (e) {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  }
}

run();

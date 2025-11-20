import 'dotenv/config';
import { pool } from '../src/config/db.config.js';

const EXCLUDED_NUMBERS = [0, 1, 2, 3, 24, 25, 26, 27]; // Red + Orange

/**
 * Calculate if a prediction is correct (same logic as outcome.service.js)
 */
function calculatePredictionCorrectness(predictionJson, actualResult) {
  const pj = predictionJson || {};

  // Get hot numbers (top 5)
  let hotNumbers = [];
  if (Array.isArray(pj.top5) && pj.top5.length > 0) {
    hotNumbers = pj.top5.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  } else if (Array.isArray(pj.top_candidates) && pj.top_candidates.length > 0) {
    hotNumbers = pj.top_candidates
      .slice(0, 5)
      .map((c) => Number(c?.result ?? c))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  }

  // Get cold numbers (pool - numbers ranked 6-13)
  let coldNumbers = [];
  if (Array.isArray(pj.pool) && pj.pool.length > 0) {
    coldNumbers = pj.pool.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  } else if (Array.isArray(pj.top_candidates) && pj.top_candidates.length > 5) {
    coldNumbers = pj.top_candidates
      .slice(5)
      .map((c) => Number(c?.result ?? c))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 27);
  }

  // Combine hot and cold numbers, remove duplicates
  const allPredictedNumbers = Array.from(new Set([...hotNumbers, ...coldNumbers]));

  // Prediction is correct if actual result is in either hot or cold numbers
  return allPredictedNumbers.length > 0 && allPredictedNumbers.includes(actualResult);
}

/**
 * Cleanup script to remove Orange/Red numbers from existing predictions
 * Run with: node scripts/cleanup-red-orange.js
 */
async function cleanupPredictions() {
  console.log('🧹 Starting cleanup of Red/Orange numbers from predictions...\n');

  try {
    // Get all predictions that have been evaluated (have correct field and evaluated_on)
    const { rows: predictions } = await pool.query(
      `SELECT 
        id, 
        prediction, 
        summary,
        COALESCE(
          (summary->>'evaluated_on')::bigint,
          (summary->>'evaluated_on_image_id')::bigint
        ) AS evaluated_on_image_id
       FROM predictions
       WHERE prediction IS NOT NULL
         AND prediction ? 'correct'
         AND (summary ? 'evaluated_on' OR summary ? 'evaluated_on_image_id')
       ORDER BY id`
    );

    console.log(`Found ${predictions.length} evaluated predictions to check...\n`);

    let updated = 0;
    let removed = 0;
    let correctnessChanged = 0;
    let correctToIncorrect = 0;
    let incorrectToCorrect = 0;

    for (const pred of predictions) {
      const prediction = pred.prediction;
      const evaluatedOnImageId = pred.evaluated_on_image_id;
      let needsUpdate = false;
      const updates = {};

      // Get actual result from image_stats
      let actualResult = null;
      if (Number.isFinite(Number(evaluatedOnImageId))) {
        const { rows: imgRows } = await pool.query(
          `SELECT result::int AS actual FROM image_stats WHERE image_id = $1 LIMIT 1`,
          [evaluatedOnImageId]
        );
        if (imgRows && imgRows.length) {
          actualResult = Number(imgRows[0].actual);
        }
      }

      // Store old correctness
      const oldCorrect = prediction.correct === true;

      // Check top5 array
      if (Array.isArray(prediction.top5)) {
        const filteredTop5 = prediction.top5.filter((n) => !EXCLUDED_NUMBERS.includes(Number(n)));
        if (filteredTop5.length !== prediction.top5.length) {
          updates.top5 = filteredTop5;
          needsUpdate = true;
          removed += prediction.top5.length - filteredTop5.length;
        }
      }

      // Check pool array
      if (Array.isArray(prediction.pool)) {
        const filteredPool = prediction.pool.filter((n) => !EXCLUDED_NUMBERS.includes(Number(n)));
        if (filteredPool.length !== prediction.pool.length) {
          updates.pool = filteredPool;
          needsUpdate = true;
          removed += prediction.pool.length - filteredPool.length;
        }
      }

      // Check top_candidates array
      if (Array.isArray(prediction.top_candidates)) {
        const filteredCandidates = prediction.top_candidates.filter((c) => {
          const num = Number(c?.result ?? c);
          return !EXCLUDED_NUMBERS.includes(num);
        });
        if (filteredCandidates.length !== prediction.top_candidates.length) {
          updates.top_candidates = filteredCandidates;
          needsUpdate = true;
          removed += prediction.top_candidates.length - filteredCandidates.length;
        }
      }

      // Check predicted_numbers array
      if (Array.isArray(prediction.predicted_numbers)) {
        const filteredPredicted = prediction.predicted_numbers.filter(
          (n) => !EXCLUDED_NUMBERS.includes(Number(n))
        );
        if (filteredPredicted.length !== prediction.predicted_numbers.length) {
          updates.predicted_numbers = filteredPredicted;
          needsUpdate = true;
          removed += prediction.predicted_numbers.length - filteredPredicted.length;
        }
      }

      // Re-evaluate correctness if we have actual result
      if (Number.isFinite(actualResult) && needsUpdate) {
        const updatedPrediction = { ...prediction, ...updates };
        const newCorrect = calculatePredictionCorrectness(updatedPrediction, actualResult);
        updates.correct = newCorrect;

        if (oldCorrect !== newCorrect) {
          correctnessChanged++;
          if (oldCorrect && !newCorrect) {
            correctToIncorrect++;
          } else if (!oldCorrect && newCorrect) {
            incorrectToCorrect++;
          }
        }
      }

      if (needsUpdate) {
        // Merge updates into existing prediction
        const updatedPrediction = { ...prediction, ...updates };

        await pool.query(
          `UPDATE predictions
           SET prediction = $1::jsonb,
               updated_at = now()
           WHERE id = $2`,
          [JSON.stringify(updatedPrediction), pred.id]
        );

        updated++;
        if (updated % 100 === 0) {
          console.log(`  Processed ${updated} predictions...`);
        }
      }
    }

    console.log(`\n✅ Cleanup complete!`);
    console.log(`   - Updated predictions: ${updated}`);
    console.log(`   - Removed Red/Orange numbers: ${removed}`);
    console.log(`   - Correctness re-evaluated: ${correctnessChanged}`);
    console.log(`     • Changed from correct → incorrect: ${correctToIncorrect}`);
    console.log(`     • Changed from incorrect → correct: ${incorrectToCorrect}`);
    console.log(`   - Excluded numbers: ${EXCLUDED_NUMBERS.join(', ')}`);
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  }
}

/**
 * Cleanup overdue_events table - remove Red/Orange entries
 */
async function cleanupOverdueEvents() {
  console.log('🧹 Cleaning up overdue_events table...\n');

  try {
    const { rows: stats } = await pool.query(
      `SELECT COUNT(*) as total, 
              COUNT(*) FILTER (WHERE number = ANY($1)) as excluded_count
       FROM overdue_events`,
      [EXCLUDED_NUMBERS]
    );

    const total = Number(stats[0].total);
    const excludedCount = Number(stats[0].excluded_count);

    console.log(`   Total overdue events: ${total}`);
    console.log(`   Red/Orange events to remove: ${excludedCount}`);

    if (excludedCount > 0) {
      const { rowCount } = await pool.query(`DELETE FROM overdue_events WHERE number = ANY($1)`, [
        EXCLUDED_NUMBERS,
      ]);

      console.log(`   ✅ Removed ${rowCount} overdue events\n`);
      return rowCount;
    }

    console.log(`   ✅ No Red/Orange events found\n`);
    return 0;
  } catch (error) {
    console.error('❌ Error cleaning overdue_events:', error);
    throw error;
  }
}

/**
 * Show statistics about Red/Orange numbers in predictions
 */
async function showStats() {
  console.log('📊 Statistics:\n');

  const { rows: stats } = await pool.query(
    `SELECT 
      COUNT(*) as total_predictions,
      COUNT(*) FILTER (
        WHERE prediction->'top5' @> ANY(ARRAY[
          '0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb,
          '24'::jsonb, '25'::jsonb, '26'::jsonb, '27'::jsonb
        ])
        OR prediction->'pool' @> ANY(ARRAY[
          '0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb,
          '24'::jsonb, '25'::jsonb, '26'::jsonb, '27'::jsonb
        ])
      ) as predictions_with_excluded
    FROM predictions
    WHERE prediction IS NOT NULL`
  );

  console.log(`   Total predictions: ${stats[0].total_predictions}`);
  console.log(`   Predictions with Red/Orange: ${stats[0].predictions_with_excluded}`);
  console.log(`   Excluded numbers: ${EXCLUDED_NUMBERS.join(', ')}\n`);
}

// Main execution
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const showOnly = process.argv.includes('--stats');

  if (showOnly) {
    await showStats();
    process.exit(0);
  }

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
    await showStats();
    console.log('\nRun without --dry-run to apply changes.');
    process.exit(0);
  }

  console.log('⚠️  This will modify existing predictions in the database.');
  console.log('   Excluded numbers:', EXCLUDED_NUMBERS.join(', '));
  console.log('   Use --dry-run to preview changes first.\n');

  await showStats();
  await cleanupPredictions();
  await cleanupOverdueEvents();

  console.log('\n📊 Statistics after cleanup:');
  await showStats();
}

main()
  .then(() => {
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });

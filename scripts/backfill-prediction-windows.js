import { pool } from '../src/config/db.config.js';

/**
 * Backfill window_id for predictions that don't have it
 * Matches predictions to windows based on created_at timestamp
 */
async function backfill() {
  console.log('🔄 Backfilling window_id for predictions...\n');

  // Find predictions without window_id
  const { rows: missing } = await pool.query(`
    SELECT COUNT(*) as total
    FROM predictions
    WHERE window_id IS NULL
  `);
  console.log(`📊 Predictions without window_id: ${missing[0].total}`);

  if (missing[0].total === 0) {
    console.log('✅ All predictions already have window_id!');
    await pool.end();
    return;
  }

  // Update predictions by matching created_at to window time ranges
  const { rows: updated } = await pool.query(`
    UPDATE predictions p
    SET window_id = w.id,
        source = COALESCE(p.source, 'local'),
        updated_at = now()
    FROM windows w
    WHERE p.window_id IS NULL
      AND p.created_at >= w.start_at
      AND p.created_at < w.end_at
    RETURNING p.id, p.window_id, p.source
  `);

  console.log(`✅ Updated ${updated.length} predictions with window_id`);

  // Check remaining
  const { rows: remaining } = await pool.query(`
    SELECT COUNT(*) as total
    FROM predictions
    WHERE window_id IS NULL
  `);
  console.log(`⚠️  Still missing window_id: ${remaining[0].total}`);

  if (remaining[0].total > 0) {
    console.log('\n💡 These predictions might be outside any window time range.');
    console.log('   They may need manual review or window creation.');
  }

  await pool.end();
}

backfill().catch(console.error);

import { pool } from '../src/config/db.config.js';

async function diagnose() {
  console.log('🔍 Diagnosing prediction data...\n');

  // 1. Check total predictions
  const { rows: totalPreds } = await pool.query(`
    SELECT COUNT(*) as total FROM predictions
  `);
  console.log(`📊 Total predictions: ${totalPreds[0].total}`);

  // 2. Check predictions with/without window_id
  const { rows: windowStats } = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE window_id IS NOT NULL) as with_window,
      COUNT(*) FILTER (WHERE window_id IS NULL) as without_window,
      COUNT(*) FILTER (WHERE source = 'local') as local,
      COUNT(*) FILTER (WHERE source = 'ai') as ai,
      COUNT(*) FILTER (WHERE source IS NULL) as null_source
    FROM predictions
  `);
  console.log('\n📈 Window ID Stats:');
  console.log(`  With window_id: ${windowStats[0].with_window}`);
  console.log(`  Without window_id: ${windowStats[0].without_window}`);
  console.log(
    `  Source: local=${windowStats[0].local}, ai=${windowStats[0].ai}, null=${windowStats[0].null_source}`
  );

  // 3. Check recent predictions
  const { rows: recent } = await pool.query(`
    SELECT id, created_at, window_id, source, based_on_image_id
    FROM predictions
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\n🕐 Recent 5 predictions:');
  recent.forEach((p, i) => {
    console.log(
      `  ${i + 1}. ID=${p.id}, window_id=${p.window_id || 'NULL'}, source=${p.source || 'NULL'}, created=${p.created_at}`
    );
  });

  // 4. Check windows
  const { rows: windows } = await pool.query(`
    SELECT COUNT(*) as total, 
           COUNT(*) FILTER (WHERE status = 'open') as open,
           COUNT(*) FILTER (WHERE status = 'closed') as closed
    FROM windows
  `);
  console.log(
    `\n🪟 Windows: total=${windows[0].total}, open=${windows[0].open}, closed=${windows[0].closed}`
  );

  // 5. Check if windowAccuracy query would return anything
  const { rows: accuracyTest } = await pool.query(`
    SELECT
      w.window_idx,
      COUNT(*) AS total_predictions
    FROM predictions p
    JOIN windows w ON w.id = p.window_id
    WHERE p.created_at >= now() - interval '30 days'
    GROUP BY w.window_idx
    ORDER BY w.window_idx
  `);
  console.log(`\n🎯 windowAccuracy would return: ${accuracyTest.length} rows`);
  if (accuracyTest.length > 0) {
    accuracyTest.forEach((row) => {
      console.log(`  Window ${row.window_idx}: ${row.total_predictions} predictions`);
    });
  }

  // 6. Check images with stats but no predictions
  const { rows: missingPreds } = await pool.query(`
    SELECT COUNT(*) as total
    FROM image_stats is2
    WHERE NOT EXISTS (
      SELECT 1 FROM predictions p WHERE p.based_on_image_id = is2.image_id
    )
  `);
  console.log(`\n📸 Images with stats but no predictions: ${missingPreds[0].total}`);

  await pool.end();
}

diagnose().catch(console.error);

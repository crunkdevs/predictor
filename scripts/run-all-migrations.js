import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/config/db.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runAllMigrations() {
  const migrationsDir = path.join(__dirname, '../src/migrations');

  try {
    // Get all SQL files in migrations directory
    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files
      .filter((f) => f.endsWith('.sql'))
      .sort() // Sort alphabetically (which should be chronological based on date prefix)
      .map((f) => path.join(migrationsDir, f));

    if (sqlFiles.length === 0) {
      console.log('ℹ️  No migration files found in src/migrations/');
      process.exit(0);
    }

    console.log(`📦 Found ${sqlFiles.length} migration file(s):\n`);
    sqlFiles.forEach((f, i) => {
      console.log(`  ${i + 1}. ${path.basename(f)}`);
    });
    console.log('');

    let successCount = 0;
    let failCount = 0;

    for (const file of sqlFiles) {
      const fileName = path.basename(file);
      try {
        console.log(`🔄 Running: ${fileName}...`);
        const sql = await fs.readFile(file, 'utf8');
        await pool.query(sql);
        console.log(`✅ Success: ${fileName}\n`);
        successCount++;
      } catch (e) {
        console.error(`❌ Failed: ${fileName}`);
        console.error(`   Error: ${e.message}\n`);
        failCount++;
        // Continue with next migration even if one fails
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 Summary: ${successCount} succeeded, ${failCount} failed`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (failCount > 0) {
      console.error('\n⚠️  Some migrations failed. Please review the errors above.');
      process.exit(1);
    } else {
      console.log('\n✨ All migrations completed successfully!');
      process.exit(0);
    }
  } catch (e) {
    console.error('❌ Error reading migrations directory:', e.message);
    process.exit(1);
  }
}

runAllMigrations();

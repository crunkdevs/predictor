import 'dotenv/config';
import fs from 'fs/promises';
import { pool } from '../src/config/db.config.js';

async function run() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/run-sql.js <path-to-sql>');
  const sql = await fs.readFile(file, 'utf8');
  await pool.query(sql);
  console.log('✅ Migration applied:', file);
  process.exit(0);
}

run().catch((e) => {
  console.error('❌ Migration failed:', e);
  process.exit(1);
});

/**
 * Quick migration runner
 * Run with: node run-migration.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

async function runMigration() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'docuchat',
    user: process.env.DB_USER || 'docuchat',
    password: process.env.DB_PASSWORD || 'docuchat_dev_password',
  });

  try {
    console.log('🔌 Connecting to database...');
    const client = await pool.connect();

    console.log('📄 Reading migration file...');
    const sqlPath = path.join(__dirname, 'migrations', '002_add_document_summary.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('🚀 Executing migration...');
    await client.query(sql);

    console.log('✅ Migration completed successfully!');

    // Verify columns were added
    console.log('\n📊 Verifying new columns...');
    const result = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'documents'
        AND column_name IN ('summary', 'key_topics', 'document_type')
      ORDER BY column_name;
    `);

    console.log('New columns:');
    result.rows.forEach(row => {
      console.log(`  ✓ ${row.column_name} (${row.data_type})`);
    });

    client.release();
    await pool.end();
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();

import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function fixConstraint() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database. Dropping constraint...');

    await client.query(`
      ALTER TABLE vendors 
      DROP CONSTRAINT IF EXISTS vendors_gst_number_key CASCADE;
    `);

    console.log('Successfully dropped vendors_gst_number_key constraint!');
  } catch (err) {
    console.error('Error dropping constraint:', err);
  } finally {
    await client.end();
  }
}

fixConstraint();
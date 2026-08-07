import pool from '../DbConnect';

async function run() {
  try {
    await pool.query(`
      ALTER TABLE delivery_agent_kyc 
      ADD COLUMN IF NOT EXISTS id_doc_image_url VARCHAR(1000);
    `);
    console.log("Successfully added id_doc_image_url column to delivery_agent_kyc table.");
    process.exit(0);
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  }
}

run();

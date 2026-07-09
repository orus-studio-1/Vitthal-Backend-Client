import pool from "../DbConnect";

async function run() {
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ DEFAULT NULL");
    console.log("Successfully added column 'deletion_requested_at' to 'users' table!");
  } catch (err) {
    console.error("Error altering table:", err);
  } finally {
    await pool.end();
  }
}

void run();

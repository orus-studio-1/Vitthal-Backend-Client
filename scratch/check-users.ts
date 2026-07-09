import pool from "../DbConnect";

async function checkUsers() {
  try {
    const res = await pool.query(
      "SELECT id, name, email, role, is_active, deletion_requested_at, refresh_token FROM users ORDER BY deletion_requested_at DESC NULLS LAST LIMIT 10"
    );
    console.log("=== Last 10 Users ===");
    console.log(JSON.stringify(res.rows, null, 2));
    await pool.end();
  } catch (err) {
    console.error("Database connection/query failed:", err);
  }
}

checkUsers();

import pool from "../DbConnect";

async function testRecover() {
  const userId = "18b8d08d-db14-4909-8e9a-f4edf2f10bda";
  try {
    const result = await pool.query(
      "UPDATE users SET is_active = TRUE, deletion_requested_at = NULL WHERE id = $1 RETURNING id",
      [userId]
    );
    console.log("Success! Updated row ID:", result.rows[0]?.id);
  } catch (err) {
    console.error("Database query failed:", err);
  } finally {
    await pool.end();
  }
}

testRecover();

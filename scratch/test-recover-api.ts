import pool from "../DbConnect";
import { generateAccessToken, generateRefreshToken } from "../helpers/jwt.helper";
import fetch from "node-fetch";

async function testRecoverAPI() {
  const userId = "18b8d08d-db14-4909-8e9a-f4edf2f10bda";
  
  // Retrieve user details
  const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  const user = userRes.rows[0];
  if (!user) {
    console.error("User not found");
    await pool.end();
    return;
  }
  
  // Generate token
  const accessToken = generateAccessToken(user.id, user.name, user.email, user.role, "product");
  const refreshToken = generateRefreshToken(user.id, user.name, user.email, user.role, "product");
  
  // Update database refresh token
  await pool.query("UPDATE users SET refresh_token = $1 WHERE id = $2", [refreshToken, user.id]);
  
  // Send request
  try {
    const res = await fetch("http://localhost:9000/api/auth/recover-account", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-from": "vendor",
        "Authorization": `Bearer ${accessToken}`,
        "x-refresh-token": refreshToken
      }
    });
    
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
  } catch (err) {
    console.error("Fetch failed:", err);
  } finally {
    await pool.end();
  }
}

testRecoverAPI();

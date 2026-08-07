import pool from '../DbConnect';

async function checkDBSchema() {
  try {
    console.log("=== Checking Database Tables and Columns ===");
    
    // Check delivery_agents columns
    const daCols = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'delivery_agents'
      ORDER BY ordinal_position;
    `);
    console.log("\n1. delivery_agents columns:", daCols.rows.map(r => `${r.column_name} (${r.data_type})`));

    // Check delivery_agent_kyc columns
    const kycCols = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'delivery_agent_kyc'
      ORDER BY ordinal_position;
    `);
    console.log("\n2. delivery_agent_kyc columns:", kycCols.rows.map(r => `${r.column_name} (${r.data_type})`));

    // Check rider_earnings columns
    const earningsCols = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'rider_earnings'
      ORDER BY ordinal_position;
    `);
    console.log("\n3. rider_earnings columns:", earningsCols.rows.map(r => `${r.column_name} (${r.data_type})`));

    process.exit(0);
  } catch (err) {
    console.error("DB Check Error:", err);
    process.exit(1);
  }
}

checkDBSchema();

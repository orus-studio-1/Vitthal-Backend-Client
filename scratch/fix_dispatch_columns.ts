import pool from "../DbConnect";

async function run() {
  try {
    console.log("Altering order_dispatch_details to make document URLs and lr_number nullable...");
    await pool.query(
      ALTER TABLE order_dispatch_details 
        ALTER COLUMN eway_bill_url DROP NOT NULL,
        ALTER COLUMN delivery_challan_url DROP NOT NULL,
        ALTER COLUMN invoice_url DROP NOT NULL,
        ALTER COLUMN lr_number DROP NOT NULL;
    );
    console.log("Successfully made order_dispatch_details columns NULLABLE!");
  } catch (err) {
    console.error("Error altering order_dispatch_details:", err);
  } finally {
    await pool.end();
  }
}

void run();

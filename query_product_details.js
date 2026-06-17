const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: "postgresql://postgres:%23Radhasoami9811@localhost:5432/vitthal_db"
  });
  await client.connect();
  const pid = "37ef64b7-cc4f-49e7-b853-79e51ec4660d";
  try {
    const variants = await client.query("SELECT * FROM product_variants WHERE product_id = $1;", [pid]);
    console.log("Product Variants:", variants.rows);

    const vendorProducts = await client.query("SELECT * FROM vendor_products WHERE product_id = $1;", [pid]);
    console.log("Vendor Products:", vendorProducts.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

run();

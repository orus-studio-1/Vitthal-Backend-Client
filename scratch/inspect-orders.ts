import fs from 'fs';
import path from 'path';
import pg from 'pg';

const envPath = path.resolve(__dirname, '../.env');
let databaseUrl = '';
if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
        if (line.trim().startsWith('DATABASE_URL=')) {
            databaseUrl = line.split('DATABASE_URL=')[1].replace(/"/g, '').trim();
            break;
        }
    }
}

const pool = new pg.Pool({ connectionString: databaseUrl });

async function main() {
    try {
        console.log("--- RECENT ORDERS ---");
        const res = await pool.query(`
            SELECT id, order_reference, status, pickup_otp, pickup_qr_token 
            FROM orders 
            ORDER BY created_at DESC 
            LIMIT 5;
        `);
        console.log(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

main();

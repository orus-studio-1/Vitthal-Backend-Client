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
    const client = await pool.connect();
    try {
        console.log("Testing inserting a notification with reference_type = 'service_quotation'...");
        
        // Find a valid user first to avoid foreign key failure on user_id
        const userRes = await client.query("SELECT id FROM users LIMIT 1");
        if (userRes.rows.length === 0) {
            console.error("No user found in DB to run test!");
            return;
        }
        const userId = userRes.rows[0].id;
        
        const result = await client.query(
            `INSERT INTO notifications (user_id, type, title, body, reference_type, reference_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, type, reference_type`,
            [userId, 'quotation_request_received', 'Test Title', 'Test Body', 'service_quotation', '40039590-c806-44c3-a531-8d1cbddd4bb7']
        );
        console.log("Insert success! Row inserted:", result.rows[0]);
        
        // Delete the test notification
        await client.query("DELETE FROM notifications WHERE id = $1", [result.rows[0].id]);
        console.log("Test notification cleaned up successfully.");
        
    } catch (err) {
        console.error("Insert failed with error:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

main();

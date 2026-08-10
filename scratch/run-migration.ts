import fs from 'fs';
import path from 'path';
import pg from 'pg';

const envPath = path.resolve(__dirname, '../.env');
console.log("Reading environment from:", envPath);
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

if (!databaseUrl) {
    console.error("Could not find DATABASE_URL in .env");
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

async function main() {
    const migrations = [
        '2026-07-02_vendor_type.sql',
        '2026-07-02_services_subsystem.sql',
        '2026-07-02_secure_booking_otp.sql',
        '2026-07-02_service_quotation_messages.sql',
        '2026-07-02_service_reviews.sql',
        '2026-07-02_services_media.sql',
        '2026-07-03_service_notification_types.sql',
        'add_service_cart.sql',
        'add_service_wishlist.sql',
        '2026-07-04_pickup_flow.sql',
        '2026-07-06_verification_keys.sql',
        '2026-07-16_service_subcategories.sql',
        '2026-08-06_kyc_and_earnings.sql',
        '2026-08-06_rider_push_token.sql'
    ];
    
    const client = await pool.connect();
    try {
        for (const migration of migrations) {
            const migrationPath = path.resolve(__dirname, `../migrations/${migration}`);
            console.log("Reading migration file from:", migrationPath);
            
            if (!fs.existsSync(migrationPath)) {
                console.error("Migration file does not exist at:", migrationPath);
                continue;
            }
            
            const sql = fs.readFileSync(migrationPath, 'utf8');
            console.log(`Running migration SQL (${migration}) against database...`);
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
            console.log(`Migration ${migration} executed successfully! 🎉`);
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error executing migrations:", error);
    } finally {
        client.release();
        await pool.end();
    }
}

main();

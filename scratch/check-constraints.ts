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
        console.log("Dropping and re-adding constraint chk_notification_reference_type...");
        await client.query("ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_reference_type;");
        await client.query(`
            ALTER TABLE notifications
            ADD CONSTRAINT chk_notification_reference_type
            CHECK (reference_type IS NULL OR reference_type IN ('quotation', 'order', 'product', 'service_quotation', 'service_booking'));
        `);
        console.log("Constraint updated successfully!");

        console.log("Dropping and re-adding constraint chk_notification_type...");
        await client.query("ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_type;");
        await client.query(`
            ALTER TABLE notifications
            ADD CONSTRAINT chk_notification_type
            CHECK (type IN (
                'quotation_request_received', 'quotation_offer_received', 'quotation_counter_received',
                'quotation_accepted', 'quotation_rejected', 'admin_confirmation_sent',
                'admin_confirmation_accepted', 'admin_confirmation_rejected', 'product_approved',
                'product_rejected', 'image_approved', 'image_rejected', 'vendor_product_approved',
                'vendor_product_rejected', 'general'
            ));
        `);
        console.log("chk_notification_type constraint updated successfully!");

        const res = await client.query(`
            SELECT conname, pg_get_constraintdef(c.oid)
            FROM pg_constraint c
            JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE conrelid = 'notifications'::regclass;
        `);
        console.log("Current constraints on table notifications:");
        for (const row of res.rows) {
            console.log(`- ${row.conname}: ${row.pg_get_constraintdef}`);
        }
    } catch (err) {
        console.error("Error executing constraint updates:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

main();

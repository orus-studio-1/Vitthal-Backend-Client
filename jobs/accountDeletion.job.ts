import pool from "../DbConnect";
import { CronJob } from "cron";

async function processAccountDeletions(): Promise<number> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Fetch users scheduled for deletion (older than 14 days)
        const eligibleUsers = await client.query(
            `SELECT id FROM users 
             WHERE deletion_requested_at IS NOT NULL 
               AND deletion_requested_at <= NOW() - INTERVAL '14 days'
               AND is_active = FALSE`
        );

        const count = eligibleUsers.rows.length;
        if (count === 0) {
            await client.query("COMMIT");
            return 0;
        }

        const userIds = eligibleUsers.rows.map(row => row.id);

        for (const userId of userIds) {
            // Delete user addresses (safe to clear completely)
            await client.query("DELETE FROM addresses WHERE user_id = $1", [userId]);

            // Anonymize/Clear Vendor details
            await client.query(
                `UPDATE vendors 
                 SET company_name = 'Deleted Vendor',
                     phone = NULL,
                     alternative_number = NULL,
                     company_website = NULL,
                     gst_number = NULL,
                     gst_certificate_link = NULL,
                     vendor_signature_image_link = NULL,
                     business_description = NULL,
                     is_active = FALSE,
                     is_blocked = TRUE,
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [userId]
            );

            // Anonymize User account to strip PII and release original email for future signups
            await client.query(
                `UPDATE users 
                 SET name = 'Deleted User',
                     email = $1,
                     password_hash = 'deleted_account_placeholder',
                     refresh_token = NULL,
                     otp = NULL,
                     is_active = FALSE,
                     updated_at = NOW()
                 WHERE id = $2`,
                [`deleted_${userId}@vitthal.com`, userId]
            );
        }

        await client.query("COMMIT");
        return count;
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("[account-deletion] Failed processing account deletions:", error);
        throw error;
    } finally {
        client.release();
    }
}

let jobStarted = false;

export function startAccountDeletionJob() {
    if (jobStarted) {
        return;
    }

    jobStarted = true;

    const runJob = async () => {
        try {
            const processed = await processAccountDeletions();
            if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
                console.log(`[account-deletion] Scheduled run complete. Accounts anonymized/purged: ${processed}`);
            }
        } catch (error) {
            console.error("[account-deletion] Job execution failed:", error);
        }
    };

    // Run 15 seconds after startup to avoid load contention
    setTimeout(() => {
        void runJob();
    }, 15000);

    // Run every day at midnight
    const scheduleExpression = "0 0 * * *";
    const cronJob = new CronJob(scheduleExpression, () => {
        void runJob();
    });

    cronJob.start();
    if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
        console.log(`[account-deletion] Cron scheduled with expression ${scheduleExpression}`);
    }
}

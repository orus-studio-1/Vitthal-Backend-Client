import pool from "../DbConnect";
import { buildAbandonedReminderEmailHtml, type ReminderItem } from "../helpers/abandonedReminderEmailTemplate";
import { CronJob } from "cron";

type ReminderSourceRow = {
    source_type: "cart" | "wishlist";
    source_item_id: string;
    created_at: string;
    user_id: string;
    user_name: string;
    user_email: string;
    product_id: string;
    product_name: string;
    vendor_name: string | null;
    price: string | number | null;
    moq: number | null;
    quantity: number | null;
    image_url: string | null;
};

const BATCH_SIZE = 50;
const REMINDER_TYPE = "24h_abandoned_reminder";

function buildCursorClause(cursorCreatedAt: string | null, cursorId: string | null): { clause: string; params: unknown[] } {
    if (!cursorCreatedAt || !cursorId) {
        return { clause: "", params: [] };
    }

    return {
        clause: ` AND (source_items.created_at > $2 OR (source_items.created_at = $2 AND source_items.source_item_id > $3))`,
        params: [cursorCreatedAt, cursorId],
    };
}

async function fetchReminderBatch(cursorCreatedAt: string | null, cursorId: string | null): Promise<ReminderSourceRow[]> {
    const hasCursor = Boolean(cursorCreatedAt && cursorId);
    const { clause } = buildCursorClause(cursorCreatedAt, cursorId);
    const queryParams = hasCursor
        ? [REMINDER_TYPE, cursorCreatedAt as string, cursorId as string, BATCH_SIZE]
        : [REMINDER_TYPE, BATCH_SIZE];

    const query = `
        WITH source_items AS (
            SELECT
                'cart'::text AS source_type,
                ci.id::text AS source_item_id,
                ci.created_at,
                c.user_id::text AS user_id,
                u.name AS user_name,
                u.email AS user_email,
                p.id::text AS product_id,
                p.name AS product_name,
                v.company_name AS vendor_name,
                vp.price,
                vp.moq,
                ci.quantity,
                (
                    SELECT image_url
                    FROM products_images pi
                    WHERE pi.product_id = p.id
                    ORDER BY pi.is_primary DESC, pi.display_order ASC, pi.created_at ASC
                    LIMIT 1
                ) AS image_url
            FROM cart_items ci
            JOIN carts c ON c.id = ci.cart_id AND c.status = 'active'
            JOIN users u ON u.id = c.user_id
            JOIN products p ON p.id = ci.product_id
            JOIN vendors v ON v.id = ci.vendor_id
            LEFT JOIN vendor_products vp ON vp.product_id = ci.product_id AND vp.vendor_id = ci.vendor_id
            WHERE ci.created_at <= NOW() - INTERVAL '24 hours'
              AND NOT EXISTS (
                    SELECT 1
                    FROM order_items oi
                    JOIN orders o ON o.id = oi.order_id
                    WHERE o.user_id = c.user_id
                      AND oi.product_id = ci.product_id
                      AND oi.vendor_id = ci.vendor_id
                      AND o.created_at >= ci.created_at
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM abandoned_reminder_logs arl
                    WHERE arl.source_type = 'cart'
                      AND arl.source_item_id = ci.id
                      AND arl.reminder_type = $1
              )

            UNION ALL

            SELECT
                'wishlist'::text AS source_type,
                wi.id::text AS source_item_id,
                wi.created_at,
                w.user_id::text AS user_id,
                u.name AS user_name,
                u.email AS user_email,
                p.id::text AS product_id,
                p.name AS product_name,
                v.company_name AS vendor_name,
                vp.price,
                vp.moq,
                NULL::integer AS quantity,
                (
                    SELECT image_url
                    FROM products_images pi
                    WHERE pi.product_id = p.id
                    ORDER BY pi.is_primary DESC, pi.display_order ASC, pi.created_at ASC
                    LIMIT 1
                ) AS image_url
            FROM wishlist_items wi
            JOIN wishlists w ON w.id = wi.wishlist_id AND w.status = 'active'
            JOIN users u ON u.id = w.user_id
            JOIN products p ON p.id = wi.product_id
            LEFT JOIN vendors v ON v.id = wi.vendor_id
            LEFT JOIN vendor_products vp ON vp.product_id = wi.product_id AND vp.vendor_id = wi.vendor_id
            WHERE wi.created_at <= NOW() - INTERVAL '24 hours'
              AND NOT EXISTS (
                    SELECT 1
                    FROM order_items oi
                    JOIN orders o ON o.id = oi.order_id
                    WHERE o.user_id = w.user_id
                      AND oi.product_id = wi.product_id
                      AND (wi.vendor_id IS NULL OR oi.vendor_id = wi.vendor_id)
                      AND o.created_at >= wi.created_at
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM abandoned_reminder_logs arl
                    WHERE arl.source_type = 'wishlist'
                      AND arl.source_item_id = wi.id
                      AND arl.reminder_type = $1
              )
        )
        SELECT *
        FROM source_items
        WHERE 1 = 1
        ${clause}
        ORDER BY created_at ASC, source_item_id ASC
        LIMIT ${hasCursor ? "$4" : "$2"}
    `;
    const result = await pool.query(query, queryParams);
    return result.rows as ReminderSourceRow[];
}

async function persistReminderLog(userId: string, sourceType: "cart" | "wishlist", sourceItemId: string) {
    await pool.query(
        `
            INSERT INTO abandoned_reminder_logs (user_id, source_type, source_item_id, reminder_type)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (source_type, source_item_id, reminder_type) DO NOTHING
        `,
        [userId, sourceType, sourceItemId, REMINDER_TYPE]
    );
}

async function processReminderBatch(): Promise<number> {
    let totalRows = 0;
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;

    while (true) {
        const rows = await fetchReminderBatch(cursorCreatedAt, cursorId);
        if (rows.length === 0) {
            break;
        }

        totalRows += rows.length;

        const groupedByUser = new Map<string, { userName: string; userEmail: string; items: ReminderItem[] }>();

        for (const row of rows) {
            const userGroup = groupedByUser.get(row.user_id) ?? {
                userName: row.user_name,
                userEmail: row.user_email,
                items: [],
            };

            userGroup.items.push({
                sourceType: row.source_type,
                productName: row.product_name,
                productId: row.product_id,
                vendorName: row.vendor_name,
                price: row.price == null ? null : Number(row.price),
                moq: row.moq ?? null,
                quantity: row.quantity ?? null,
                imageUrl: row.image_url,
                createdAt: row.created_at,
            });

            groupedByUser.set(row.user_id, userGroup);
        }

        for (const [userId, group] of groupedByUser.entries()) {
            const html = buildAbandonedReminderEmailHtml({
                userName: group.userName,
                userEmail: group.userEmail,
                items: group.items,
            });

            if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
                console.log("[abandoned-reminder] mock email ready", {
                    userId,
                    email: group.userEmail,
                    itemCount: group.items.length,
                    items: group.items.map((item) => ({
                        sourceType: item.sourceType,
                        productId: item.productId,
                        productName: item.productName,
                    })),
                });
                console.log("[abandoned-reminder] html preview", html.slice(0, 1200));
            }

            for (const item of group.items) {
                const matchingRow = rows.find((row) => row.user_id === userId && row.product_id === item.productId && row.source_type === item.sourceType);
                if (matchingRow) {
                    await persistReminderLog(userId, item.sourceType, matchingRow.source_item_id);
                }
            }
        }

        const lastRow = rows[rows.length - 1];
        cursorCreatedAt = lastRow.created_at;
        cursorId = lastRow.source_item_id;

        if (rows.length < BATCH_SIZE) {
            break;
        }
    }

    return totalRows;
}

let jobStarted = false;

export function startAbandonedReminderJob() {
    if (jobStarted) {
        return;
    }

    jobStarted = true;

    const runJob = async () => {
        try {
            const processed = await processReminderBatch();
            if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
                console.log(`[abandoned-reminder] batch run complete. rowsProcessed=${processed}`);
            }
        } catch (error) {
            console.error("[abandoned-reminder] job failed:", error);
        }
    };

    // Delay startup run to allow schema setup/migrations to finish and avoid database lock contention/deadlocks
    setTimeout(() => {
        void runJob();
    }, 10000);

    const scheduleExpression = "0 * * * *";
    const cronJob = new CronJob(scheduleExpression, () => {
        void runJob();
    });

    cronJob.start();
    if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
        console.log(`[abandoned-reminder] cron scheduled with expression ${scheduleExpression}`);
    }
}
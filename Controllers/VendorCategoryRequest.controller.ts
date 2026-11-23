import type { Request, Response } from "express";
import pool from "../DbConnect";

/**
 * Product vendors request extra product categories. A vendor only sees catalogue products from its
 * own categories, so this is how it gets access to new ones (for example after a bulk import).
 * The admin backend reviews each requested category on its own.
 */

const MAX_CATEGORIES_PER_REQUEST = 10;
const MIN_REASON_LENGTH = 15;
const MAX_REASON_LENGTH = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getProductVendor(userId: string) {
    const result = await pool.query(
        `SELECT id, vendor_type FROM vendors WHERE user_id = $1 LIMIT 1`,
        [userId]
    );
    return result.rows[0] as { id: string; vendor_type: string | null } | undefined;
}

function isProductVendor(vendor: { vendor_type: string | null }) {
    return vendor.vendor_type === "product" || vendor.vendor_type === "both" || !vendor.vendor_type;
}

/** GET /api/vendors/category-requests — the vendor's categories, what it can still request, and its request history. */
export const getVendorCategoryRequestsController = async (req: Request, res: Response): Promise<Response> => {
    const { userId } = (req as any).user;

    try {
        const vendor = await getProductVendor(userId);
        if (!vendor || !isProductVendor(vendor)) {
            return res.status(403).json({ message: "Only product vendors can request product categories." });
        }

        const [assigned, available, requests] = await Promise.all([
            pool.query(
                `SELECT pc.id, pc.code, pc.label
                 FROM vendor_categories vc
                 JOIN product_category pc ON pc.id = vc.category_id
                 WHERE vc.vendor_id = $1 AND pc.is_active = TRUE
                 ORDER BY pc.label ASC`,
                [vendor.id]
            ),
            pool.query(
                `SELECT pc.id, pc.code, pc.label, pc.description
                 FROM product_category pc
                 WHERE pc.is_active = TRUE
                   AND (pc.category_type = 'product' OR pc.category_type IS NULL)
                   AND NOT EXISTS (SELECT 1 FROM vendor_categories vc WHERE vc.vendor_id = $1 AND vc.category_id = pc.id)
                 ORDER BY pc.label ASC`,
                [vendor.id]
            ),
            pool.query(
                `SELECT r.id, r.reason, r.status, r.admin_note, r.reviewed_at, r.created_at,
                        COALESCE(json_agg(json_build_object(
                            'category_id', pc.id, 'code', pc.code, 'label', pc.label, 'status', i.status
                        ) ORDER BY pc.label) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
                 FROM vendor_category_requests r
                 LEFT JOIN vendor_category_request_items i ON i.request_id = r.id
                 LEFT JOIN product_category pc ON pc.id = i.category_id
                 WHERE r.vendor_id = $1
                 GROUP BY r.id
                 ORDER BY r.created_at DESC
                 LIMIT 50`,
                [vendor.id]
            ),
        ]);

        // Categories already waiting for a decision cannot be requested again.
        const pendingCategoryIds = new Set<string>();
        for (const request of requests.rows) {
            for (const item of request.items as Array<{ category_id: string; status: string }>) {
                if (item.status === "pending") pendingCategoryIds.add(item.category_id);
            }
        }

        return res.status(200).json({
            message: "Category requests fetched successfully",
            data: {
                assigned: assigned.rows,
                available: available.rows.map((category) => ({
                    ...category,
                    pending: pendingCategoryIds.has(category.id),
                })),
                requests: requests.rows,
            },
        });
    } catch (error) {
        console.error("Error fetching vendor category requests:", error);
        return res.status(500).json({ message: "Could not load your category requests. Please try again." });
    }
};

/** POST /api/vendors/category-requests — body { categoryIds: string[], reason: string } */
export const createVendorCategoryRequestController = async (req: Request, res: Response): Promise<Response> => {
    const { userId } = (req as any).user;
    const rawIds = (req.body as { categoryIds?: unknown })?.categoryIds;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    const categoryIds = Array.isArray(rawIds)
        ? [...new Set(rawIds.filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id)))]
        : [];

    if (categoryIds.length === 0) {
        return res.status(400).json({ message: "Select at least one category to request." });
    }
    if (categoryIds.length > MAX_CATEGORIES_PER_REQUEST) {
        return res.status(400).json({ message: `You can request up to ${MAX_CATEGORIES_PER_REQUEST} categories at a time.` });
    }
    if (reason.length < MIN_REASON_LENGTH) {
        return res.status(400).json({ message: `Please explain why you need these categories (at least ${MIN_REASON_LENGTH} characters).` });
    }
    if (reason.length > MAX_REASON_LENGTH) {
        return res.status(400).json({ message: `The reason can be at most ${MAX_REASON_LENGTH} characters.` });
    }

    const client = await pool.connect();
    try {
        const vendor = await getProductVendor(userId);
        if (!vendor || !isProductVendor(vendor)) {
            return res.status(403).json({ message: "Only product vendors can request product categories." });
        }

        await client.query("BEGIN");
        // Serialize requests from the same vendor so two quick submits cannot both pass the checks below.
        await client.query(`SELECT id FROM vendors WHERE id = $1 FOR UPDATE`, [vendor.id]);

        const categories = await client.query(
            `SELECT pc.id, pc.label,
                    EXISTS (SELECT 1 FROM vendor_categories vc WHERE vc.vendor_id = $2 AND vc.category_id = pc.id) AS assigned,
                    EXISTS (
                        SELECT 1 FROM vendor_category_request_items i
                        JOIN vendor_category_requests r ON r.id = i.request_id
                        WHERE r.vendor_id = $2 AND i.category_id = pc.id AND i.status = 'pending'
                    ) AS pending
             FROM product_category pc
             WHERE pc.id = ANY($1::uuid[])
               AND pc.is_active = TRUE
               AND (pc.category_type = 'product' OR pc.category_type IS NULL)`,
            [categoryIds, vendor.id]
        );

        if (categories.rows.length !== categoryIds.length) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "One or more selected categories are no longer available. Refresh and try again." });
        }
        const assigned = categories.rows.filter((c) => c.assigned).map((c) => c.label);
        if (assigned.length > 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: `You already have access to: ${assigned.join(", ")}.` });
        }
        const pending = categories.rows.filter((c) => c.pending).map((c) => c.label);
        if (pending.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: `A request is already awaiting review for: ${pending.join(", ")}.` });
        }

        const created = await client.query(
            `INSERT INTO vendor_category_requests (vendor_id, reason) VALUES ($1, $2) RETURNING id, status, created_at`,
            [vendor.id, reason]
        );
        const requestId = created.rows[0].id as string;
        await client.query(
            `INSERT INTO vendor_category_request_items (request_id, category_id)
             SELECT $1, unnest($2::uuid[])`,
            [requestId, categoryIds]
        );

        await client.query("COMMIT");
        return res.status(201).json({
            message: "Your category request has been sent to the admin team for review.",
            data: { id: requestId, status: created.rows[0].status, created_at: created.rows[0].created_at },
        });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("Error creating vendor category request:", error);
        return res.status(500).json({ message: "Could not submit your request. Please try again." });
    } finally {
        client.release();
    }
};

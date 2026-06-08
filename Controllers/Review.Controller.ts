import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

type ReviewPayload = {
    orderItemId?: unknown;
    vendorId?: unknown;
    rating?: unknown;
    reviewTitle?: unknown;
    reviewText?: unknown;
    images?: unknown;
};

function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseRating(value: unknown): number | null {
    const rating = Number(value);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return null;
    }

    return rating;
}

async function updateProductAggregate(client: PoolClient, productId: string, rating: number) {
    return client.query(
        `
            UPDATE products
            SET rating = ROUND((((COALESCE(rating, 0.0) * COALESCE(review_count, 0)) + $1)::numeric / (COALESCE(review_count, 0) + 1)), 1),
                review_count = COALESCE(review_count, 0) + 1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING rating, review_count
        `,
        [rating, productId]
    );
}

async function updateVendorAggregate(client: PoolClient, vendorId: string, rating: number) {
    return client.query(
        `
            UPDATE vendors
            SET rating = ROUND((((COALESCE(rating, 0.0) * COALESCE(review_count, 0)) + $1)::numeric / (COALESCE(review_count, 0) + 1)), 1),
                review_count = COALESCE(review_count, 0) + 1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING rating, review_count
        `,
        [rating, vendorId]
    );
}

export const getReviewableOrderController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser?.role !== "client") {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ message: "Order ID is required" });
    }

    try {
        const orderResult = await pool.query(
            `
                SELECT
                    o.id AS order_id,
                    o.status,
                    o.payment_status,
                    o.total_amount,
                    o.created_at,
                    o.updated_at,
                    o.address_line,
                    o.city,
                    o.state,
                    o.country,
                    o.pincode,
                    u.name AS customer_name,
                    u.email AS customer_email,
                    COALESCE(COUNT(oi.id), 0) AS item_count,
                    COALESCE(COUNT(DISTINCT oi.vendor_id), 0) AS vendor_count
                FROM orders o
                JOIN users u ON o.user_id = u.id
                LEFT JOIN order_items oi ON oi.order_id = o.id
                WHERE o.id = $1 AND o.user_id = $2
                GROUP BY o.id, u.name, u.email
                LIMIT 1
            `,
            [id, authUser.userId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ message: "Order not found" });
        }

        const itemsResult = await pool.query(
            `
                SELECT
                    oi.id AS order_item_id,
                    oi.product_id,
                    oi.vendor_id,
                    oi.quantity,
                    oi.price,
                    p.name AS product_name,
                    p.description AS product_description,
                    (
                        SELECT image_url
                        FROM products_images pi
                        WHERE pi.product_id = p.id AND pi.is_primary = true
                        LIMIT 1
                    ) AS image_url,
                    v.company_name AS vendor_name,
                    oir.id AS product_review_id,
                    oir.rating AS product_rating,
                    oir.review_title AS product_review_title,
                    oir.review_text AS product_review_text,
                    oir.images AS product_review_images,
                    oir.created_at AS product_reviewed_at,
                    vr.id AS vendor_review_id,
                    vr.rating AS vendor_rating,
                    vr.review_title AS vendor_review_title,
                    vr.review_text AS vendor_review_text,
                    vr.created_at AS vendor_reviewed_at
                FROM order_items oi
                JOIN products p ON p.id = oi.product_id
                JOIN vendors v ON v.id = oi.vendor_id
                LEFT JOIN order_item_reviews oir ON oir.order_item_id = oi.id
                LEFT JOIN vendor_reviews vr ON vr.order_id = oi.order_id AND vr.vendor_id = oi.vendor_id AND vr.user_id = $2
                WHERE oi.order_id = $1
                ORDER BY v.company_name ASC, oi.created_at ASC, p.name ASC
            `,
            [id, authUser.userId]
        );

        const order = orderResult.rows[0];
        const canReview = order.status === "delivered";

        const items = itemsResult.rows;
        for (const item of items) {
            if (item.product_review_images && Array.isArray(item.product_review_images)) {
                item.product_review_images = await Promise.all(
                    item.product_review_images.map((img: string) => getPresignedUrlOrOriginal(img))
                );
            }
        }

        return res.status(200).json({
            data: {
                order,
                items,
                canReview,
                reviewLockReason: canReview ? null : "Reviews are available after the order is delivered.",
            },
        });
    } catch (error) {
        console.error("Error fetching reviewable order:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const submitOrderReviewsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser?.role !== "client") {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const payload = req.body as { productReviews?: ReviewPayload[]; vendorReviews?: ReviewPayload[] };

    if (!id) {
        return res.status(400).json({ message: "Order ID is required" });
    }

    const productReviews = Array.isArray(payload.productReviews) ? payload.productReviews : [];
    const vendorReviews = Array.isArray(payload.vendorReviews) ? payload.vendorReviews : [];

    if (productReviews.length === 0 && vendorReviews.length === 0) {
        return res.status(400).json({ message: "At least one review is required" });
    }

    const orderResult = await pool.query(
        `SELECT id, user_id, status FROM orders WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, authUser.userId]
    );

    if (orderResult.rows.length === 0) {
        return res.status(404).json({ message: "Order not found" });
    }

    const order = orderResult.rows[0];
    if (order.status !== "delivered") {
        return res.status(400).json({ message: "Reviews can only be submitted after delivery" });
    }

    const itemsResult = await pool.query(
        `
            SELECT id AS order_item_id, product_id, vendor_id
            FROM order_items
            WHERE order_id = $1
        `,
        [id]
    );

    const orderItemsById = new Map<string, { product_id: string; vendor_id: string }>();
    const vendorIdsInOrder = new Set<string>();

    for (const item of itemsResult.rows) {
        orderItemsById.set(item.order_item_id, item);
        vendorIdsInOrder.add(item.vendor_id);
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        for (const review of productReviews) {
            const orderItemId = typeof review.orderItemId === "string" ? review.orderItemId : "";
            const rating = parseRating(review.rating);
            if (!orderItemId || rating === null) {
                throw new Error("Invalid product review payload");
            }

            const item = orderItemsById.get(orderItemId);
            if (!item) {
                throw new Error("Invalid order item selected for review");
            }

            const reviewTitle = normalizeText(review.reviewTitle);
            const reviewText = normalizeText(review.reviewText);
            const images = Array.isArray(review.images)
                ? review.images.filter((img): img is string => typeof img === "string")
                : [];

            await client.query(
                `
                    INSERT INTO order_item_reviews (
                        order_id,
                        order_item_id,
                        user_id,
                        product_id,
                        vendor_id,
                        rating,
                        review_title,
                        review_text,
                        images
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `,
                [id, orderItemId, authUser.userId, item.product_id, item.vendor_id, rating, reviewTitle, reviewText, images]
            );

            await updateProductAggregate(client, item.product_id, rating);
        }

        for (const review of vendorReviews) {
            const vendorId = typeof review.vendorId === "string" ? review.vendorId : "";
            const rating = parseRating(review.rating);
            if (!vendorId || rating === null) {
                throw new Error("Invalid vendor review payload");
            }

            if (!vendorIdsInOrder.has(vendorId)) {
                throw new Error("Vendor does not belong to this order");
            }

            const reviewTitle = normalizeText(review.reviewTitle);
            const reviewText = normalizeText(review.reviewText);

            await client.query(
                `
                    INSERT INTO vendor_reviews (
                        order_id,
                        user_id,
                        vendor_id,
                        rating,
                        review_title,
                        review_text
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `,
                [id, authUser.userId, vendorId, rating, reviewTitle, reviewText]
            );

            await updateVendorAggregate(client, vendorId, rating);
        }

        await client.query("COMMIT");
        return res.status(201).json({ message: "Reviews submitted successfully" });
    } catch (error) {
        await client.query("ROLLBACK");

        const code = (error as { code?: string }).code;
        if (code === "23505") {
            return res.status(409).json({ message: "One or more reviews were already submitted for this order" });
        }

        if (error instanceof Error) {
            return res.status(400).json({ message: error.message });
        }

        console.error("Error submitting reviews:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};
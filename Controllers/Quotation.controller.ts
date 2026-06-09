import type { Request, Response } from "express";
import pool from "../DbConnect";
import { sendQuotationRequestEmail, sendQuotationUpdateEmail } from "../helpers/emailService.helper";
import { createNotification, notifyAllAdmins } from "./Notification.controller";
import { generateBaseQuotationDocument, generateVendorQuotationDocument } from "../services/quotationDocument.service";
import { getPresignedUrl } from "../services/s3.service";
import Razorpay from "razorpay";
import crypto from "crypto";

type QuotationAction = "offer" | "counter" | "accept" | "reject";

type QuotationRow = {
    id: string;
    user_id: string;
    vendor_id: string;
    product_id: string;
    requested_quantity: number;
    requested_price: number | null;
    status: string;
    current_offer_price: number | null;
    current_offer_quantity: number | null;
    current_offer_by: string | null;
    accepted_price: number | null;
    accepted_quantity: number | null;
    quotation_group_id: string | null;
    delivery_days: number | null;
    token_percentage: number | null;
    token_amount: number | null;
    vendor_document_url: string | null;
    vendor_document_s3_key: string | null;
};

function normalizeAction(value: unknown): QuotationAction | null {
    if (value === "offer" || value === "counter" || value === "accept" || value === "reject") {
        return value;
    }
    return null;
}

async function getVendorIdForUser(userId: string): Promise<string | null> {
    const result = await pool.query(`SELECT id FROM vendors WHERE user_id = $1`, [userId]);
    return result.rows[0]?.id || null;
}

export const createQuotationFromCartController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can request quotations" });
    }

    const { userId } = authUser;
    const { requestNote } = req.body as { requestNote?: string };

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const addressResult = await client.query(
            `SELECT city, state, country, pincode FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );

        if (addressResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Please add your address before requesting a quotation." });
        }

        const address = addressResult.rows[0];

        const cartResult = await client.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = 'quotation'`,
            [userId]
        );

        if (cartResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "No quotation cart found" });
        }

        const cartId = cartResult.rows[0].id as string;

        // Get cart items (vendor_id here is just the "viewing" vendor, we'll broadcast to all)
        const cartItemsResult = await client.query(
            `
                SELECT DISTINCT ON (ci.product_id)
                    ci.product_id,
                    ci.quantity,
                    ci.price_at_added,
                    p.name AS product_name,
                    p.description AS product_description,
                    pc.label AS product_category
                FROM cart_items ci
                JOIN products p ON ci.product_id = p.id
                LEFT JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)
                WHERE ci.cart_id = $1
            `,
            [cartId]
        );

        if (cartItemsResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Quotation cart is empty" });
        }

        const createdQuotationIds: string[] = [];

        for (const item of cartItemsResult.rows) {
            // Find ALL vendors serving this product with quotation_enabled = true
            // AND stock_quantity >= product quotation_limit
            const eligibleVendorsResult = await client.query(
                `
                    SELECT
                        vp.vendor_id,
                        v.company_name AS vendor_name,
                        u.email AS vendor_email,
                        u.id AS vendor_user_id
                    FROM vendor_products vp
                    JOIN vendors v ON vp.vendor_id = v.id
                    JOIN users u ON v.user_id = u.id
                    JOIN products p ON vp.product_id = p.id
                    WHERE vp.product_id = $1
                      AND vp.quotation_enabled = true
                      AND vp.is_active = true
                      AND v.approval_status = 'approved'
                      AND v.is_active = true
                      AND v.is_blocked = false
                      AND u.is_active = true
                      AND (p.quotation_limit IS NULL OR vp.stock_quantity >= p.quotation_limit)
                `,
                [item.product_id]
            );

            if (eligibleVendorsResult.rows.length === 0) {
                // Skip this product if no eligible vendors
                continue;
            }

            // Generate a group ID for this product's quotation requests
            const groupIdResult = await client.query(`SELECT gen_random_uuid() AS group_id`);
            const quotationGroupId = groupIdResult.rows[0].group_id as string;

            // Create a quotation_request for EACH eligible vendor
            for (const vendor of eligibleVendorsResult.rows) {
                const quotationResult = await client.query(
                    `
                        INSERT INTO quotation_requests (
                            user_id,
                            vendor_id,
                            product_id,
                            requested_quantity,
                            requested_price,
                            status,
                            request_note,
                            buyer_city,
                            buyer_state,
                            buyer_country,
                            buyer_pincode,
                            quotation_group_id
                        ) VALUES ($1, $2, $3, $4, $5, 'pending_vendor', $6, $7, $8, $9, $10, $11)
                        RETURNING id
                    `,
                    [
                        userId,
                        vendor.vendor_id,
                        item.product_id,
                        item.quantity,
                        item.price_at_added,
                        requestNote || null,
                        address.city,
                        address.state,
                        address.country,
                        address.pincode,
                        quotationGroupId,
                    ]
                );

                const quotationId = quotationResult.rows[0].id as string;
                createdQuotationIds.push(quotationId);

                await client.query(
                    `
                        INSERT INTO quotation_messages (
                            quotation_id,
                            sender_user_id,
                            sender_role,
                            action,
                            offer_price,
                            offer_quantity,
                            note
                        ) VALUES ($1, $2, 'client', 'request', $3, $4, $5)
                    `,
                    [quotationId, userId, item.price_at_added, item.quantity, requestNote || null]
                );

                if (vendor.vendor_email) {
                    await sendQuotationRequestEmail({
                        vendorEmail: vendor.vendor_email,
                        vendorName: vendor.vendor_name || "Vendor",
                        buyerId: userId,
                        buyerCity: address.city,
                        productName: item.product_name,
                        quantity: item.quantity,
                        requestedPrice: item.price_at_added,
                        note: requestNote || undefined,
                    });
                }

                // Notify the vendor
                await createNotification({
                    userId: vendor.vendor_user_id,
                    type: "quotation_request_received",
                    title: "New quotation request",
                    body: `You received a quotation request for ${item.product_name} (${item.quantity} units)`,
                    referenceType: "quotation",
                    referenceId: quotationId,
                });
            }
        }

        if (createdQuotationIds.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "No eligible vendors found for the products in your quotation cart." });
        }

        await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);

        await client.query("COMMIT");

        // Generate base quotation documents (after commit, non-blocking)
        // We do this outside the transaction so failures don't rollback the quotation
        const documentGenerationJobs: Array<{ groupId: string; item: any }> = [];
        const groupsCreated = new Set<string>();
        for (const item of cartItemsResult.rows) {
            // Find the group ID for this product's quotation requests
            const groupResult = await pool.query(
                `SELECT quotation_group_id FROM quotation_requests
                 WHERE product_id = $1 AND user_id = $2 AND quotation_group_id IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1`,
                [item.product_id, userId]
            );
            if (groupResult.rows.length > 0) {
                const groupId = groupResult.rows[0].quotation_group_id;
                if (!groupsCreated.has(groupId)) {
                    groupsCreated.add(groupId);
                    documentGenerationJobs.push({ groupId, item });
                }
            }
        }

        // Generate documents in parallel (fire-and-forget with error logging)
        for (const job of documentGenerationJobs) {
            generateBaseQuotationDocument({
                quotationGroupId: job.groupId,
                userId,
                productId: job.item.product_id,
                productName: job.item.product_name,
                productDescription: job.item.product_description || undefined,
                productCategory: job.item.product_category || undefined,
                requestedQuantity: job.item.quantity,
                requestedPrice: Number(job.item.price_at_added) || 0,
                clientCity: address.city || "",
                clientState: address.state || "",
                clientPincode: address.pincode || "",
                clientCountry: address.country || "India",
            }).catch((err) => {
                console.error(`[QuotationDocument] Failed to generate document for group ${job.groupId}:`, err);
            });
        }

        return res.status(201).json({ message: "Quotation requests submitted to all eligible vendors", data: { quotationIds: createdQuotationIds } });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error creating quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const getClientQuotationsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can view quotations" });
    }

    try {
        // Return quotations grouped by product (quotation_group_id)
        const result = await pool.query(
            `
                SELECT
                    qr.quotation_group_id,
                    qr.product_id,
                    p.name AS product_name,
                    p.quotation_limit,
                    (SELECT image_url FROM products_images WHERE product_id = qr.product_id AND is_primary = true LIMIT 1) AS product_image,
                    qr.requested_quantity,
                    qr.requested_price,
                    MIN(qr.created_at) AS created_at,
                    MAX(qr.updated_at) AS updated_at,
                    COUNT(qr.id)::int AS total_vendors,
                    COUNT(qr.id) FILTER (WHERE qr.current_offer_by = 'vendor')::int AS vendors_responded,
                    COUNT(qr.id) FILTER (
                        WHERE qr.status IN ('client_accepted', 'admin_confirmation_pending', 'admin_confirmed')
                    )::int AS accepted_count,
                    COUNT(qr.id) FILTER (WHERE qr.status IN ('client_rejected', 'vendor_rejected'))::int AS rejected_count,
                    -- Best offer from vendors
                    MIN(qr.current_offer_price) FILTER (WHERE qr.current_offer_by = 'vendor' AND qr.current_offer_price IS NOT NULL) AS best_offer_price,
                    -- Overall group status
                    CASE
                        WHEN COUNT(qr.id) FILTER (
                            WHERE qr.status IN ('client_accepted', 'admin_confirmation_pending', 'admin_confirmed')
                        ) > 0 THEN 'accepted'
                        WHEN COUNT(qr.id) FILTER (WHERE qr.status IN ('client_rejected', 'vendor_rejected', 'cancelled', 'expired')) = COUNT(qr.id) THEN 'closed'
                        WHEN COUNT(qr.id) FILTER (WHERE qr.current_offer_by = 'vendor') > 0 THEN 'offers_received'
                        ELSE 'pending'
                    END AS group_status
                FROM quotation_requests qr
                JOIN products p ON qr.product_id = p.id
                WHERE qr.user_id = $1 AND qr.quotation_group_id IS NOT NULL
                GROUP BY qr.quotation_group_id, qr.product_id, p.name, p.quotation_limit, qr.requested_quantity, qr.requested_price
                ORDER BY MAX(qr.updated_at) DESC
            `,
            [authUser.userId]
        );

        // Also fetch any legacy quotations without group_id (backward compatibility)
        const legacyResult = await pool.query(
            `
                SELECT
                    qr.id AS quotation_group_id,
                    qr.product_id,
                    p.name AS product_name,
                    p.quotation_limit,
                    (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) AS product_image,
                    qr.requested_quantity,
                    qr.requested_price,
                    qr.created_at,
                    qr.updated_at,
                    1 AS total_vendors,
                    CASE WHEN qr.current_offer_by = 'vendor' THEN 1 ELSE 0 END AS vendors_responded,
                    CASE WHEN qr.status IN ('client_accepted', 'admin_confirmation_pending', 'admin_confirmed') THEN 1 ELSE 0 END AS accepted_count,
                    CASE WHEN qr.status IN ('client_rejected', 'vendor_rejected') THEN 1 ELSE 0 END AS rejected_count,
                    qr.current_offer_price AS best_offer_price,
                    CASE
                        WHEN qr.status IN ('client_accepted', 'admin_confirmation_pending', 'admin_confirmed') THEN 'accepted'
                        WHEN qr.status IN ('client_rejected', 'vendor_rejected', 'cancelled', 'expired') THEN 'closed'
                        WHEN qr.current_offer_by = 'vendor' THEN 'offers_received'
                        ELSE 'pending'
                    END AS group_status
                FROM quotation_requests qr
                JOIN products p ON qr.product_id = p.id
                WHERE qr.user_id = $1 AND qr.quotation_group_id IS NULL
                ORDER BY qr.updated_at DESC
            `,
            [authUser.userId]
        );

        const allGroups = [...result.rows, ...legacyResult.rows];
        allGroups.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

        return res.status(200).json({ data: allGroups });
    } catch (error) {
        console.error("Error fetching client quotations:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getClientQuotationByIdController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can view quotations" });
    }

    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ message: "Quotation group ID is required" });
    }

    try {
        // id can be a quotation_group_id or a single quotation id (legacy)
        // First try to find by quotation_group_id
        let vendorQuotations = await pool.query(
            `
                SELECT
                    qr.*,
                    p.name AS product_name,
                    p.quotation_limit,
                    v.company_name AS vendor_name,
                    (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) AS product_image
                FROM quotation_requests qr
                JOIN products p ON qr.product_id = p.id
                JOIN vendors v ON qr.vendor_id = v.id
                WHERE qr.quotation_group_id = $1 AND qr.user_id = $2
                ORDER BY
                    CASE WHEN qr.status = 'client_accepted' THEN 0 ELSE 1 END,
                    qr.current_offer_price ASC NULLS LAST,
                    qr.updated_at DESC
            `,
            [id, authUser.userId]
        );

        // Fallback: try as a single quotation ID (legacy)
        if (vendorQuotations.rows.length === 0) {
            vendorQuotations = await pool.query(
                `
                    SELECT
                        qr.*,
                        p.name AS product_name,
                        p.quotation_limit,
                        v.company_name AS vendor_name,
                        (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) AS product_image
                    FROM quotation_requests qr
                    JOIN products p ON qr.product_id = p.id
                    JOIN vendors v ON qr.vendor_id = v.id
                    WHERE qr.id = $1 AND qr.user_id = $2
                `,
                [id, authUser.userId]
            );
        }

        if (vendorQuotations.rows.length === 0) {
            return res.status(404).json({ message: "Quotation not found" });
        }

        // Get messages for ALL quotations in this group
        const quotationIds = vendorQuotations.rows.map((q: any) => q.id);
        const messagesResult = await pool.query(
            `
                SELECT qm.id, qm.quotation_id, qm.sender_role, qm.action, qm.offer_price, qm.offer_quantity, qm.note, qm.reason, qm.created_at,
                       v.company_name AS vendor_name
                FROM quotation_messages qm
                LEFT JOIN quotation_requests qr ON qm.quotation_id = qr.id
                LEFT JOIN vendors v ON qr.vendor_id = v.id
                WHERE qm.quotation_id = ANY($1)
                ORDER BY qm.created_at ASC
            `,
            [quotationIds]
        );

        // Group messages by quotation_id for convenience
        const messagesByQuotation: Record<string, any[]> = {};
        for (const msg of messagesResult.rows) {
            if (!messagesByQuotation[msg.quotation_id]) {
                messagesByQuotation[msg.quotation_id] = [];
            }
            messagesByQuotation[msg.quotation_id].push(msg);
        }

        // Build response with product info and vendor quotations
        const firstQuotation = vendorQuotations.rows[0];

        // Get base quotation document
        const groupId = firstQuotation.quotation_group_id || id;
        const docResult = await pool.query(
            `SELECT quotation_number, document_url, s3_key, valid_until, created_at
             FROM quotation_documents WHERE quotation_group_id = $1 LIMIT 1`,
            [groupId]
        );
        const docRow = docResult.rows.length > 0 ? docResult.rows[0] : null;
        let document = null;
        if (docRow) {
            let documentUrl = docRow.document_url;
            if (docRow.s3_key) {
                try {
                    documentUrl = await getPresignedUrl(docRow.s3_key);
                } catch (s3Err) {
                    console.error("Failed to generate presigned URL for base doc:", s3Err);
                }
            }
            document = {
                quotation_number: docRow.quotation_number,
                document_url: documentUrl,
                valid_until: docRow.valid_until,
                created_at: docRow.created_at,
            };
        }

        const mappedVendorQuotations = [];
        for (const q of vendorQuotations.rows) {
            let vendorDocUrl = q.vendor_document_url;
            if (q.vendor_document_s3_key) {
                try {
                    vendorDocUrl = await getPresignedUrl(q.vendor_document_s3_key);
                } catch (s3Err) {
                    console.error(`Failed to generate presigned URL for vendor doc of request ${q.id}:`, s3Err);
                }
            }
            mappedVendorQuotations.push({
                ...q,
                vendor_document_url: vendorDocUrl,
                messages: messagesByQuotation[q.id] || [],
            });
        }

        return res.status(200).json({
            data: {
                product_id: firstQuotation.product_id,
                product_name: firstQuotation.product_name,
                product_image: firstQuotation.product_image,
                quotation_limit: firstQuotation.quotation_limit,
                requested_quantity: firstQuotation.requested_quantity,
                requested_price: firstQuotation.requested_price,
                quotation_group_id: groupId,
                document: document ? {
                    quotation_number: document.quotation_number,
                    document_url: document.document_url,
                    valid_until: document.valid_until,
                    created_at: document.created_at,
                } : null,
                vendor_quotations: mappedVendorQuotations,
            }
        });
    } catch (error) {
        console.error("Error fetching quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const respondClientQuotationController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can respond to quotations" });
    }

    const { id } = req.params;
    const action = normalizeAction(req.body?.action);
    const offerPrice = req.body?.offerPrice;
    const offerQuantity = req.body?.offerQuantity;
    const reason = req.body?.reason;
    const note = req.body?.note;

    if (!id || !action) {
        return res.status(400).json({ message: "Quotation ID and action are required" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const quotationResult = await client.query(
            `SELECT * FROM quotation_requests WHERE id = $1 AND user_id = $2 LIMIT 1`,
            [id, authUser.userId]
        );

        if (quotationResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Quotation not found" });
        }

        const quotation = quotationResult.rows[0] as QuotationRow;

        if (["client_accepted", "client_rejected", "vendor_rejected", "cancelled", "expired"].includes(quotation.status)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Quotation is closed and cannot be updated" });
        }

        if (quotation.current_offer_by !== "vendor") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Waiting for vendor response before you can act on this quotation" });
        }

        if (action === "counter") {
            if (!offerPrice || !offerQuantity || !reason) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Offer price, quantity, and reason are required for counter offers" });
            }

            await client.query(
                `
                    UPDATE quotation_requests
                    SET status = 'client_countered',
                        current_offer_price = $1,
                        current_offer_quantity = $2,
                        current_offer_by = 'client',
                        updated_at = NOW()
                    WHERE id = $3
                `,
                [offerPrice, offerQuantity, id]
            );

            await client.query(
                `
                    INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, offer_price, offer_quantity, note, reason)
                    VALUES ($1, $2, 'client', 'counter', $3, $4, $5, $6)
                `,
                [id, authUser.userId, offerPrice, offerQuantity, note || null, reason]
            );
        } else if (action === "accept") {
            if (quotation.current_offer_by !== "vendor" || !quotation.current_offer_price || !quotation.current_offer_quantity) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Vendor offer is required before accepting" });
            }

            const addressResult = await client.query(
                `SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [authUser.userId]
            );
            if (addressResult.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "No address found for client" });
            }

            const address = addressResult.rows[0];

            const orderResult = await client.query(
                `
                    INSERT INTO orders (
                        user_id, vendor_id, status, payment_status, total_amount,
                        address_line, city, state, country, pincode, latitude, langitude,
                        source, order_type
                    ) VALUES ($1, $2, 'pending', 'pending', $3, $4, $5, $6, $7, $8, $9, $10, 'client', 'quotation')
                    RETURNING id
                `,
                [
                    authUser.userId,
                    quotation.vendor_id,
                    Number(quotation.current_offer_price) * Number(quotation.current_offer_quantity),
                    address.address,
                    address.city,
                    address.state,
                    address.country,
                    address.pincode,
                    address.latitude,
                    address.longitude || address.latitude,
                ]
            );

            const orderId = orderResult.rows[0].id as string;

            await client.query(
                `
                    INSERT INTO vendor_payouts (order_id, vendor_id, status)
                    VALUES ($1, $2, 'pending')
                    ON CONFLICT (order_id) DO NOTHING
                `,
                [orderId, quotation.vendor_id]
            );

            await client.query(
                `
                    INSERT INTO order_items (order_id, product_id, vendor_id, quantity, price)
                    VALUES ($1, $2, $3, $4, $5)
                `,
                [orderId, quotation.product_id, quotation.vendor_id, quotation.current_offer_quantity, quotation.current_offer_price]
            );

            await client.query(
                `
                    INSERT INTO order_status_history (order_id, status, note, created_at)
                    VALUES ($1, 'pending', 'Quotation accepted by client', CURRENT_TIMESTAMP)
                `,
                [orderId]
            );

            await client.query(
                `
                    UPDATE quotation_requests
                    SET status = 'client_accepted',
                        accepted_price = $1,
                        accepted_quantity = $2,
                        order_id = $3,
                        updated_at = NOW()
                    WHERE id = $4
                `,
                [quotation.current_offer_price, quotation.current_offer_quantity, orderId, id]
            );

            // Auto-reject other vendors in the same group
            if (quotation.quotation_group_id) {
                const otherVendorQuotations = await client.query(
                    `SELECT id, vendor_id FROM quotation_requests
                     WHERE quotation_group_id = $1 AND id != $2
                       AND status NOT IN ('client_rejected', 'vendor_rejected', 'cancelled', 'expired')`,
                    [quotation.quotation_group_id, id]
                );

                for (const otherQ of otherVendorQuotations.rows) {
                    await client.query(
                        `UPDATE quotation_requests
                         SET status = 'client_rejected',
                             rejection_reason = 'Another vendor was selected for this quotation',
                             updated_at = NOW()
                         WHERE id = $1`,
                        [otherQ.id]
                    );

                    await client.query(
                        `INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, reason, note)
                         VALUES ($1, $2, 'client', 'reject', 'Another vendor was selected', 'Auto-rejected: client accepted another vendor offer')`,
                        [otherQ.id, authUser.userId]
                    );

                    // Notify rejected vendor
                    const rejectedVendorUser = await client.query(
                        `SELECT user_id FROM vendors WHERE id = $1`, [otherQ.vendor_id]
                    );
                    if (rejectedVendorUser.rows.length) {
                        await createNotification({
                            userId: rejectedVendorUser.rows[0].user_id,
                            type: "quotation_rejected",
                            title: "Quotation closed — another vendor selected",
                            body: `The client selected a different vendor for this quotation.`,
                            referenceType: "quotation",
                            referenceId: otherQ.id,
                        });
                    }
                }
            }

            await client.query(
                `
                    INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, note)
                    VALUES ($1, $2, 'client', 'accept', $3)
                `,
                [id, authUser.userId, note || null]
            );
        } else if (action === "reject") {
            if (!reason) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Reason is required for rejection" });
            }

            await client.query(
                `
                    UPDATE quotation_requests
                    SET status = 'client_rejected',
                        rejection_reason = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `,
                [reason, id]
            );

            await client.query(
                `
                    INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, reason, note)
                    VALUES ($1, $2, 'client', 'reject', $3, $4)
                `,
                [id, authUser.userId, reason, note || null]
            );
        }

        const vendorResult = await client.query(
            `
                SELECT u.email AS vendor_email, v.company_name AS vendor_name
                FROM vendors v
                JOIN users u ON v.user_id = u.id
                WHERE v.id = $1
            `,
            [quotation.vendor_id]
        );

        if (vendorResult.rows.length) {
            await sendQuotationUpdateEmail({
                recipientEmail: vendorResult.rows[0].vendor_email,
                recipientName: vendorResult.rows[0].vendor_name || "Vendor",
                quotationId: id as string,
                status: action === "counter" ? "client_countered" : action === "accept" ? "client_accepted" : "client_rejected",
                note: note || undefined,
                reason: reason || undefined,
            });
        }

        // --- Notifications ---
        // Get the vendor's user_id for notification
        const vendorUserResult = await client.query(
            `SELECT user_id FROM vendors WHERE id = $1`, [quotation.vendor_id]
        );
        const vendorUserId = vendorUserResult.rows[0]?.user_id;

        if (action === "counter" && vendorUserId) {
            await createNotification({
                userId: vendorUserId,
                type: "quotation_counter_received",
                title: "Client sent a counter offer",
                body: `Client countered with ₹${offerPrice} × ${offerQuantity}`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        } else if (action === "accept") {
            if (vendorUserId) {
                await createNotification({
                    userId: vendorUserId,
                    type: "quotation_accepted",
                    title: "Quotation accepted!",
                    body: `Client accepted your offer of ₹${quotation.current_offer_price} × ${quotation.current_offer_quantity}`,
                    referenceType: "quotation",
                    referenceId: id as string,
                });
            }
            // Notify all admins
            await notifyAllAdmins({
                type: "quotation_accepted",
                title: "Quotation accepted by client",
                body: `A client accepted a quotation for ₹${quotation.current_offer_price} × ${quotation.current_offer_quantity}. Admin confirmation is required.`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        } else if (action === "reject" && vendorUserId) {
            await createNotification({
                userId: vendorUserId,
                type: "quotation_rejected",
                title: "Quotation rejected",
                body: `Client rejected the quotation. Reason: ${reason}`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        }

        await client.query("COMMIT");

        // Generate updated vendor-specific document on client counter (non-blocking)
        if (action === "counter" && quotation.quotation_group_id) {
            const vendorNameResult = await pool.query(
                `SELECT company_name FROM vendors WHERE id = $1`, [quotation.vendor_id]
            );
            const vendorName = vendorNameResult.rows[0]?.company_name || "Vendor";

            generateVendorQuotationDocument({
                quotationGroupId: quotation.quotation_group_id,
                vendorId: quotation.vendor_id,
                vendorName,
                offerPrice: Number(offerPrice),
                offerQuantity: Number(offerQuantity),
                deliveryDays: quotation.delivery_days || 1,
                tokenPercentage: Number(quotation.token_percentage) || 0,
            }).then(async (result) => {
                await pool.query(
                    `UPDATE quotation_requests SET vendor_document_url = $1, vendor_document_s3_key = $2 WHERE id = $3`,
                    [result.documentUrl, result.s3Key, id]
                );
            }).catch((err) => {
                console.error(`[QuotationDocument] Failed to generate vendor document on client counter for quotation ${id}:`, err);
            });
        }

        return res.status(200).json({ message: "Quotation response saved" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error responding to quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const getVendorQuotationsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Only vendors can view quotations" });
    }

    try {
        const vendorId = await getVendorIdForUser(authUser.userId);
        if (!vendorId) {
            return res.status(404).json({ message: "Vendor not found" });
        }

        const result = await pool.query(
            `
                SELECT
                    qr.id,
                    qr.status,
                    qr.requested_quantity,
                    qr.requested_price,
                    qr.current_offer_price,
                    qr.current_offer_quantity,
                    qr.current_offer_by,
                    qr.accepted_price,
                    qr.accepted_quantity,
                    qr.rejection_reason,
                    qr.buyer_city,
                    qr.buyer_state,
                    qr.buyer_country,
                    qr.buyer_pincode,
                    qr.user_id AS buyer_id,
                    qr.created_at,
                    qr.updated_at,
                    p.name AS product_name
                FROM quotation_requests qr
                JOIN products p ON qr.product_id = p.id
                WHERE qr.vendor_id = $1
                ORDER BY qr.updated_at DESC
            `,
            [vendorId]
        );

        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching vendor quotations:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getVendorQuotationByIdController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Only vendors can view quotations" });
    }

    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ message: "Quotation ID is required" });
    }

    try {
        const vendorId = await getVendorIdForUser(authUser.userId);
        if (!vendorId) {
            return res.status(404).json({ message: "Vendor not found" });
        }

        const quotationResult = await pool.query(
            `
                SELECT
                    qr.*,
                    p.name AS product_name,
                    p.description AS product_description,
                    p.quotation_limit
                FROM quotation_requests qr
                JOIN products p ON qr.product_id = p.id
                WHERE qr.id = $1 AND qr.vendor_id = $2
                LIMIT 1
            `,
            [id, vendorId]
        );

        if (quotationResult.rows.length === 0) {
            return res.status(404).json({ message: "Quotation not found" });
        }

        const quotation = quotationResult.rows[0];

        const messagesResult = await pool.query(
            `
                SELECT id, sender_role, action, offer_price, offer_quantity, note, reason, created_at
                FROM quotation_messages
                WHERE quotation_id = $1
                ORDER BY created_at ASC
            `,
            [id]
        );

        // Get base quotation document
        const groupId = quotation.quotation_group_id;
        let document = null;
        if (groupId) {
            const docResult = await pool.query(
                `SELECT quotation_number, document_url, s3_key, valid_until, created_at
                 FROM quotation_documents WHERE quotation_group_id = $1 LIMIT 1`,
                [groupId]
            );
            if (docResult.rows.length > 0) {
                const docRow = docResult.rows[0];
                let documentUrl = docRow.document_url;
                if (docRow.s3_key) {
                    try {
                        documentUrl = await getPresignedUrl(docRow.s3_key);
                    } catch (s3Err) {
                        console.error("Failed to generate presigned URL for base doc (vendor):", s3Err);
                    }
                }
                document = {
                    quotation_number: docRow.quotation_number,
                    document_url: documentUrl,
                    valid_until: docRow.valid_until,
                    created_at: docRow.created_at,
                };
            }
        }

        // Generate presigned URL for the vendor's own quotation document if it exists
        if (quotation.vendor_document_s3_key) {
            try {
                quotation.vendor_document_url = await getPresignedUrl(quotation.vendor_document_s3_key);
            } catch (s3Err) {
                console.error("Failed to generate presigned URL for vendor own doc:", s3Err);
            }
        }

        return res.status(200).json({
            data: {
                quotation,
                messages: messagesResult.rows,
                document,
            }
        });
    } catch (error) {
        console.error("Error fetching vendor quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const respondVendorQuotationController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Only vendors can respond to quotations" });
    }

    const { id } = req.params;
    const action = normalizeAction(req.body?.action);
    const offerPrice = req.body?.offerPrice;
    const offerQuantity = req.body?.offerQuantity;
    const reason = req.body?.reason;
    const note = req.body?.note;
    const deliveryDays = req.body?.deliveryDays ? Number(req.body.deliveryDays) : null;
    const tokenPercentage = req.body?.tokenPercentage != null ? Number(req.body.tokenPercentage) : null;

    if (!id || !action) {
        return res.status(400).json({ message: "Quotation ID and action are required" });
    }

    if (action === "offer" || action === "counter") {
        if (!offerPrice || !offerQuantity) {
            return res.status(400).json({ message: "Offer price and quantity are required" });
        }
        if (action === "counter" && !reason) {
            return res.status(400).json({ message: "Reason is required for counter offer" });
        }
    }

    if (action === "reject" && !reason) {
        return res.status(400).json({ message: "Reason is required for rejection" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const vendorId = await getVendorIdForUser(authUser.userId);
        if (!vendorId) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Vendor not found" });
        }

        const quotationResult = await client.query(
            `SELECT * FROM quotation_requests WHERE id = $1 AND vendor_id = $2 LIMIT 1`,
            [id, vendorId]
        );

        if (quotationResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Quotation not found" });
        }

        const quotation = quotationResult.rows[0] as QuotationRow;

        if (["client_accepted", "client_rejected", "vendor_rejected", "cancelled", "expired"].includes(quotation.status)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Quotation is closed and cannot be updated" });
        }

        if (quotation.current_offer_by === "vendor" && quotation.status !== "client_countered") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Vendor has already responded. Wait for the client to counter before replying again." });
        }

        if (action === "offer" || action === "counter") {
            const nextStatus = action === "offer" ? "vendor_offered" : "vendor_countered";

            // On first offer, delivery_days and token_percentage are required
            if (action === "offer" && (deliveryDays == null || tokenPercentage == null)) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Delivery days and token money percentage are required for the first offer" });
            }

            // Calculate token amount
            const totalAmount = Number(offerPrice) * Number(offerQuantity);
            const gstAmount = totalAmount * 0.18; // 18% GST
            const grandTotal = totalAmount + gstAmount;
            const tokenAmount = tokenPercentage != null ? (tokenPercentage / 100) * grandTotal : null;

            await client.query(
                `
                    UPDATE quotation_requests
                    SET status = $1,
                        current_offer_price = $2,
                        current_offer_quantity = $3,
                        current_offer_by = 'vendor',
                        delivery_days = COALESCE($5, delivery_days),
                        token_percentage = COALESCE($6, token_percentage),
                        token_amount = COALESCE($7, token_amount),
                        updated_at = NOW()
                    WHERE id = $4
                `,
                [nextStatus, offerPrice, offerQuantity, id, deliveryDays, tokenPercentage, tokenAmount]
            );

            await client.query(
                `
                    INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, offer_price, offer_quantity, note, reason)
                    VALUES ($1, $2, 'vendor', $3, $4, $5, $6, $7)
                `,
                [id, authUser.userId, action, offerPrice, offerQuantity, note || null, reason || null]
            );
        } else if (action === "accept") {
            if (quotation.current_offer_by !== "client" || !quotation.current_offer_price || !quotation.current_offer_quantity) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Client counter offer is required before accepting" });
            }

            const addressResult = await client.query(
                `SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [quotation.user_id]
            );
            if (addressResult.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "No shipping address found for client" });
            }

            const address = addressResult.rows[0];

            const orderResult = await client.query(
                `
                    INSERT INTO orders (
                        user_id, vendor_id, status, payment_status, total_amount,
                        address_line, city, state, country, pincode, latitude, langitude,
                        source, order_type
                    ) VALUES ($1, $2, 'pending', 'pending', $3, $4, $5, $6, $7, $8, $9, $10, 'vendor', 'quotation')
                    RETURNING id
                `,
                [
                    quotation.user_id,
                    quotation.vendor_id,
                    Number(quotation.current_offer_price) * Number(quotation.current_offer_quantity),
                    address.address,
                    address.city,
                    address.state,
                    address.country,
                    address.pincode,
                    address.latitude,
                    address.longitude || address.latitude,
                ]
            );

            const orderId = orderResult.rows[0].id as string;

            await client.query(
                `
                    INSERT INTO order_items (order_id, product_id, vendor_id, quantity, price)
                    VALUES ($1, $2, $3, $4, $5)
                `,
                [orderId, quotation.product_id, quotation.vendor_id, quotation.current_offer_quantity, quotation.current_offer_price]
            );

            await client.query(
                `
                    INSERT INTO order_status_history (order_id, status, note, created_at)
                    VALUES ($1, 'pending', 'Client counter offer accepted by vendor', CURRENT_TIMESTAMP)
                `,
                [orderId]
            );

            await client.query(
                `
                    UPDATE quotation_requests
                    SET status = 'client_accepted',
                        accepted_price = $1,
                        accepted_quantity = $2,
                        order_id = $3,
                        updated_at = NOW()
                    WHERE id = $4
                `,
                [quotation.current_offer_price, quotation.current_offer_quantity, orderId, id]
            );

            if (quotation.quotation_group_id) {
                const otherVendorQuotations = await client.query(
                    `SELECT id, vendor_id FROM quotation_requests
                     WHERE quotation_group_id = $1 AND id != $2
                       AND status NOT IN ('client_rejected', 'vendor_rejected', 'cancelled', 'expired')`,
                    [quotation.quotation_group_id, id]
                );

                for (const otherQ of otherVendorQuotations.rows) {
                    await client.query(
                        `UPDATE quotation_requests
                         SET status = 'client_rejected',
                             rejection_reason = 'Another vendor was selected for this quotation',
                             updated_at = NOW()
                         WHERE id = $1`,
                        [otherQ.id]
                    );

                    await client.query(
                        `INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, reason, note)
                         VALUES ($1, $2, 'vendor', 'reject', 'Another vendor was selected', 'Auto-rejected: another vendor counter offer accepted')`,
                        [otherQ.id, authUser.userId]
                    );

                    const rejectedVendorUser = await client.query(
                        `SELECT user_id FROM vendors WHERE id = $1`, [otherQ.vendor_id]
                    );
                    if (rejectedVendorUser.rows.length) {
                        await createNotification({
                            userId: rejectedVendorUser.rows[0].user_id,
                            type: "quotation_rejected",
                            title: "Quotation closed — another vendor selected",
                            body: `The client selected a different vendor for this quotation.`,
                            referenceType: "quotation",
                            referenceId: otherQ.id,
                        });
                    }
                }
            }

            await client.query(
                `
                    INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, note)
                    VALUES ($1, $2, 'vendor', 'accept', $3)
                `,
                [id, authUser.userId, note || null]
            );
        } else if (action === "reject") {
            await client.query(
                `
                    UPDATE quotation_requests
                    SET status = 'vendor_rejected',
                        rejection_reason = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `,
                [reason, id]
            );

            await client.query(
                `
                    INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, reason, note)
                    VALUES ($1, $2, 'vendor', 'reject', $3, $4)
                `,
                [id, authUser.userId, reason, note || null]
            );
        }

        const clientResult = await client.query(
            `SELECT u.email AS client_email, u.name AS client_name FROM users u WHERE u.id = $1`,
            [quotation.user_id]
        );

        if (clientResult.rows.length) {
            await sendQuotationUpdateEmail({
                recipientEmail: clientResult.rows[0].client_email,
                recipientName: clientResult.rows[0].client_name || "Client",
                quotationId: id as string,
                status: action === "offer" ? "vendor_offered" : action === "counter" ? "vendor_countered" : action === "accept" ? "client_accepted" : "vendor_rejected",
                note: note || undefined,
                reason: reason || undefined,
            });
        }

        // --- Notifications ---
        if (action === "offer" || action === "counter") {
            await createNotification({
                userId: quotation.user_id,
                type: action === "offer" ? "quotation_offer_received" : "quotation_counter_received",
                title: action === "offer" ? "Vendor sent an offer" : "Vendor sent a counter offer",
                body: `Vendor offered ₹${offerPrice} × ${offerQuantity}`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        } else if (action === "accept") {
            await createNotification({
                userId: quotation.user_id,
                type: "quotation_accepted",
                title: "Vendor accepted your counter offer!",
                body: `Vendor accepted your counter offer of ₹${quotation.current_offer_price} × ${quotation.current_offer_quantity}`,
                referenceType: "quotation",
                referenceId: id as string,
            });
            await notifyAllAdmins({
                type: "quotation_accepted",
                title: "Vendor accepted client counter offer",
                body: `A vendor accepted a client's counter offer for ₹${quotation.current_offer_price} × ${quotation.current_offer_quantity}. Admin confirmation is required.`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        } else if (action === "reject") {
            await createNotification({
                userId: quotation.user_id,
                type: "quotation_rejected",
                title: "Vendor rejected the quotation",
                body: `Vendor rejected your quotation request. Reason: ${reason}`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        }

        await client.query("COMMIT");

        // Generate vendor-specific document on offer or counter (non-blocking)
        const finalDeliveryDays = deliveryDays !== null ? deliveryDays : quotation.delivery_days;
        const finalTokenPercentage = tokenPercentage !== null ? tokenPercentage : quotation.token_percentage;

        if ((action === "offer" || action === "counter") && quotation.quotation_group_id && finalDeliveryDays != null && finalTokenPercentage != null) {
            const vendorNameResult = await pool.query(
                `SELECT company_name FROM vendors WHERE id = $1`, [vendorId]
            );
            const vendorName = vendorNameResult.rows[0]?.company_name || "Vendor";

            generateVendorQuotationDocument({
                quotationGroupId: quotation.quotation_group_id,
                vendorId,
                vendorName,
                offerPrice: Number(offerPrice),
                offerQuantity: Number(offerQuantity),
                deliveryDays: finalDeliveryDays,
                tokenPercentage: Number(finalTokenPercentage),
            }).then(async (result) => {
                // Save vendor document URL to quotation_requests
                await pool.query(
                    `UPDATE quotation_requests SET vendor_document_url = $1, vendor_document_s3_key = $2 WHERE id = $3`,
                    [result.documentUrl, result.s3Key, id]
                );
            }).catch((err) => {
                console.error(`[QuotationDocument] Failed to generate vendor document for quotation ${id}:`, err);
            });
        }

        return res.status(200).json({ message: "Quotation response saved" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error responding to vendor quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const respondToAdminConfirmationController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can respond to admin confirmations" });
    }

    const { id } = req.params;
    const { action, note } = req.body as { action?: string; note?: string };

    if (!id || (action !== "accept" && action !== "reject")) {
        return res.status(400).json({ message: "Quotation ID and action (accept/reject) are required" });
    }

    if (action === "accept") {
        return res.status(400).json({
            message: "Direct acceptance is disabled. You must pay the token money to confirm this quotation."
        });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const quotationResult = await client.query(
            `SELECT * FROM quotation_requests WHERE id = $1 AND user_id = $2 LIMIT 1`,
            [id, authUser.userId]
        );

        if (quotationResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Quotation not found" });
        }

        const quotation = quotationResult.rows[0];

        if (quotation.admin_confirmation_status !== "pending") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "No pending admin confirmation to respond to" });
        }

        // reject
        await client.query(
            `UPDATE quotation_requests
             SET admin_confirmation_status = 'rejected',
                 status = 'admin_confirmation_rejected',
                 updated_at = NOW()
             WHERE id = $1`,
            [id]
        );

        await client.query(
            `INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, note)
             VALUES ($1, $2, 'client', 'admin_rejected', $3)`,
            [id, authUser.userId, note || null]
        );

        // Notify admin
        if (quotation.admin_user_id) {
            await createNotification({
                userId: quotation.admin_user_id,
                type: "admin_confirmation_rejected",
                title: "Client rejected the confirmation",
                body: `Client rejected the admin confirmation for the quotation.`,
                referenceType: "quotation",
                referenceId: id as string,
            });
        }
        await notifyAllAdmins({
            type: "admin_confirmation_rejected",
            title: "Quotation confirmation rejected",
            body: `Client rejected the admin confirmation.`,
            referenceType: "quotation",
            referenceId: id as string,
        });

        await client.query("COMMIT");
        return res.status(200).json({ message: `Admin confirmation ${action}ed successfully` });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error responding to admin confirmation:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const createTokenPaymentController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can make payments" });
    }
    const { userId } = authUser;
    const id = req.params.id as string;

    if (!id) {
        return res.status(400).json({ message: "Quotation ID is required" });
    }

    try {
        // Fetch quotation request
        const quotationResult = await pool.query(
            `SELECT * FROM quotation_requests WHERE id = $1 AND user_id = $2 LIMIT 1`,
            [id, userId]
        );

        if (quotationResult.rows.length === 0) {
            return res.status(404).json({ message: "Quotation request not found" });
        }

        const quotation = quotationResult.rows[0];

        if (quotation.status !== "admin_confirmation_pending" || quotation.admin_confirmation_status !== "pending") {
            return res.status(400).json({ message: "Quotation is not pending admin confirmation response" });
        }

        // Fetch token details
        let tokenAmount = quotation.token_amount ? Number(quotation.token_amount) : null;
        if (tokenAmount === null || tokenAmount <= 0) {
            const acceptedPrice = quotation.accepted_price ? Number(quotation.accepted_price) : Number(quotation.current_offer_price);
            const acceptedQty = quotation.accepted_quantity ? Number(quotation.accepted_quantity) : Number(quotation.current_offer_quantity);
            const tokenPct = quotation.token_percentage ? Number(quotation.token_percentage) : 10;
            if (!acceptedPrice || !acceptedQty) {
                return res.status(400).json({ message: "Quotation pricing details are incomplete" });
            }
            const total = acceptedPrice * acceptedQty * 1.18;
            tokenAmount = (tokenPct / 100) * total;
        }

        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            return res.status(400).json({
                message: "Razorpay credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured in the backend .env file."
            });
        }

        const razorpayInstance = new Razorpay({
            key_id: keyId,
            key_secret: keySecret,
        });

        const razorpayAmount = Math.round(tokenAmount * 100);

        const razorpayOrder = await (razorpayInstance.orders.create({
            amount: razorpayAmount,
            currency: "INR",
            receipt: `receipt_token_${Date.now()}`,
            notes: {
                userId,
                quotationRequestId: id,
            }
        }) as any);

        // Fetch user profile details
        const userProfileQuery = await pool.query(
            `SELECT u.name, u.email, c.phone FROM users u LEFT JOIN client c ON c.user_id = u.id WHERE u.id = $1`,
            [userId]
        );
        const userProfile = userProfileQuery.rows[0];

        // Store payment record as pending
        const orderIds = quotation.order_id ? [quotation.order_id] : [];
        await pool.query(
            `INSERT INTO payments (
                user_id, amount, status, payment_method, razorpay_order_id, order_ids, quotation_request_id, split_number, split_percentage
            ) VALUES ($1, $2, 'pending', 'razorpay', $3, $4, $5, 1, $6)`,
            [userId, tokenAmount, razorpayOrder.id, orderIds, id, quotation.token_percentage || 100.00]
        );

        return res.status(200).json({
            keyId: keyId,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            razorpayOrderId: razorpayOrder.id,
            quotationRequestId: id,
            tokenAmount: tokenAmount,
            userProfile: {
                name: userProfile?.name || "",
                email: userProfile?.email || "",
                phone: userProfile?.phone || ""
            }
        });

    } catch (error: any) {
        console.error("Create token payment order error:", error);
        let message = "Failed to initiate token payment.";
        if (error?.error?.description) {
            message = error.error.description;
        } else if (error?.description) {
            message = error.description;
        } else if (error?.message) {
            message = error.message;
        }
        return res.status(error?.statusCode || 500).json({ message });
    }
};

export const verifyTokenPaymentController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can verify payments" });
    }
    const { userId } = authUser;
    const id = req.params.id as string;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, note } = req.body;

    if (!id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ message: "Missing required payment verification details." });
    }

    try {
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keySecret) {
            return res.status(500).json({ message: "Razorpay credentials are not configured on the server." });
        }

        // 1. Verify signature
        const hmac = crypto.createHmac("sha256", keySecret);
        hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
        const generatedSignature = hmac.digest("hex");

        if (generatedSignature !== razorpay_signature) {
            await pool.query(
                `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE razorpay_order_id = $1`,
                [razorpay_order_id]
            );
            return res.status(400).json({ message: "Payment verification failed. Invalid signature." });
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            // 2. Fetch payment details to verify
            const paymentQuery = await client.query(
                `SELECT id, amount FROM payments WHERE razorpay_order_id = $1 AND quotation_request_id = $2`,
                [razorpay_order_id, id]
            );

            if (paymentQuery.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Payment record not found for this quotation." });
            }

            // 3. Update payment record to successful
            await client.query(
                `UPDATE payments 
                 SET status = 'successful', razorpay_payment_id = $2, razorpay_signature = $3, updated_at = NOW()
                 WHERE razorpay_order_id = $1`,
                [razorpay_order_id, razorpay_payment_id, razorpay_signature]
            );

            // 4. Fetch the quotation request to confirm it
            const quotationResult = await client.query(
                `SELECT * FROM quotation_requests WHERE id = $1 LIMIT 1`,
                [id]
            );

            if (quotationResult.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Quotation request not found" });
            }

            const quotation = quotationResult.rows[0];

            // 5. Update quotation request status
            await client.query(
                `UPDATE quotation_requests
                 SET admin_confirmation_status = 'confirmed',
                     admin_confirmed_at = NOW(),
                     status = 'admin_confirmed',
                     updated_at = NOW()
                 WHERE id = $1`,
                [id]
            );

            // 6. Update associated order status to processing and payment_status to paid
            if (quotation.order_id) {
                await client.query(
                    `UPDATE orders 
                     SET status = 'processing', payment_status = 'paid', updated_at = NOW() 
                     WHERE id = $1`,
                    [quotation.order_id]
                );

                await client.query(
                    `INSERT INTO order_status_history (order_id, status, note, created_at)
                     VALUES ($1, 'processing', 'Admin confirmation accepted and token money paid by client.', CURRENT_TIMESTAMP)`,
                    [quotation.order_id]
                );

                // Deduct stock for order items
                const orderItemsQuery = await client.query(
                    `SELECT product_id, vendor_id, quantity FROM order_items WHERE order_id = $1`,
                    [quotation.order_id]
                );

                for (const item of orderItemsQuery.rows) {
                    await client.query(
                        `UPDATE vendor_products     
                         SET stock_quantity = GREATEST(0, stock_quantity - $1), updated_at = NOW()
                         WHERE product_id = $2 AND vendor_id = $3`,
                        [item.quantity, item.product_id, item.vendor_id]
                    );
                }
            }

            // 7. Insert client confirm message in chat
            await client.query(
                `INSERT INTO quotation_messages (quotation_id, sender_user_id, sender_role, action, note)
                 VALUES ($1, $2, 'client', 'admin_confirmed', $3)`,
                [id, userId, note || "Token money paid via Razorpay."]
            );

            // 8. Notify admin
            if (quotation.admin_user_id) {
                await createNotification({
                    userId: quotation.admin_user_id,
                    type: "admin_confirmation_accepted",
                    title: "Client confirmed the quotation & paid token money",
                    body: `Client paid token money via Razorpay. Quotation confirmed and order is now active.`,
                    referenceType: "quotation",
                    referenceId: id,
                });
            }
            await notifyAllAdmins({
                type: "admin_confirmation_accepted",
                title: "Quotation fully confirmed",
                body: `Client confirmed quotation and paid token money. Order is now processing.`,
                referenceType: "quotation",
                referenceId: id,
            });

            await client.query("COMMIT");
            return res.status(200).json({ message: "Token payment verified and quotation fully confirmed!" });

        } catch (error) {
            await client.query("ROLLBACK");
            console.error("verifyTokenPayment transaction error:", error);
            return res.status(500).json({ message: "Failed to complete verification transaction." });
        } finally {
            client.release();
        }

    } catch (error) {
        console.error("Verify token payment error:", error);
        return res.status(500).json({ message: "Internal server error during payment verification." });
    }
};

import type { Request, Response } from "express";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

type CartType = "direct" | "quotation";

function normalizeCartType(value: unknown): CartType {
    return value === "quotation" ? "quotation" : "direct";
}

function getAuthUser(req: Request) {
    return (req as any).user as { userId: string; role: string } | undefined;
}

// ─── GET /api/service-cart ─────────────────────────────────────────────────
export const getServiceCartController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ message: "Unauthorized" });

    const cartType = normalizeCartType(req.query.type);

    try {
        const query = `
            SELECT
                sci.id              AS service_cart_item_id,
                sci.cart_id,
                sci.service_id,
                sci.vendor_service_id,
                sci.vendor_id,
                sci.quantity,
                sci.price_at_added,
                sci.pricing_type,
                sci.created_at,
                s.name              AS service_name,
                s.category_id,
                vs.moq,
                v.company_name      AS vendor_name,
                v.rating            AS vendor_rating,
                COALESCE(
                    (SELECT sm.media_url FROM services_media sm WHERE sm.service_id = s.id AND sm.is_primary = true LIMIT 1),
                    (SELECT sm.media_url FROM services_media sm WHERE sm.service_id = s.id LIMIT 1),
                    pc.image
                )                   AS image_url
            FROM carts c
            JOIN service_cart_items sci ON c.id = sci.cart_id
            JOIN services s    ON s.id = sci.service_id
            LEFT JOIN product_category pc ON pc.id = s.category_id
            JOIN vendor_services vs ON vs.id = sci.vendor_service_id
            JOIN vendors v     ON v.id = sci.vendor_id
            WHERE c.user_id = $1 AND c.status = 'active' AND c.cart_type = $2
            ORDER BY sci.created_at DESC
        `;
        const result = await pool.query(query, [authUser.userId, cartType]);
        const rows = await Promise.all(
            result.rows.map(async (row) => ({
                ...row,
                image_url: await getPresignedUrlOrOriginal(row.image_url),
            }))
        );
        return res.status(200).json({ data: rows });
    } catch (error) {
        console.error("getServiceCartController error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ─── POST /api/service-cart ────────────────────────────────────────────────
export const addServiceCartItemController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ message: "Unauthorized" });

    const { vendor_service_id, quantity, cart_type } = req.body as Record<string, unknown>;
    const cartType = normalizeCartType(cart_type);

    if (!vendor_service_id || typeof vendor_service_id !== "string") {
        return res.status(400).json({ message: "vendor_service_id is required" });
    }
    const qty = typeof quantity === "number" ? quantity : parseInt(String(quantity), 10);
    if (!qty || qty < 1) {
        return res.status(400).json({ message: "quantity must be >= 1" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Validate the vendor_service offering
        const vsResult = await client.query(
            `SELECT vs.id, vs.service_id, vs.vendor_id, vs.price, vs.pricing_type, vs.moq, vs.is_active,
                    v.approval_status
             FROM vendor_services vs
             JOIN vendors v ON v.id = vs.vendor_id
             WHERE vs.id = $1 LIMIT 1`,
            [vendor_service_id]
        );
        if (vsResult.rows.length === 0 || !vsResult.rows[0].is_active) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Service offering not found or inactive" });
        }
        const vs = vsResult.rows[0];
        if (vs.approval_status !== "approved") {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "Vendor is not approved" });
        }
        const moq = Number(vs.moq) || 1;
        if (qty < moq) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: `Minimum order quantity is ${moq}` });
        }

        // Get or create active cart
        let cartResult = await client.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = $2`,
            [authUser.userId, cartType]
        );
        let cartId: string;
        if (cartResult.rows.length === 0) {
            cartResult = await client.query(
                `INSERT INTO carts (user_id, status, total_amount, cart_type) VALUES ($1, 'active', 0, $2) RETURNING id`,
                [authUser.userId, cartType]
            );
        }
        cartId = cartResult.rows[0].id;

        // Upsert service cart item
        await client.query(
            `INSERT INTO service_cart_items
                (cart_id, service_id, vendor_service_id, vendor_id, quantity, price_at_added, pricing_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (cart_id, vendor_service_id)
             DO UPDATE SET quantity = $5, price_at_added = $6, updated_at = NOW()`,
            [cartId, vs.service_id, vendor_service_id, vs.vendor_id, qty, vs.price, vs.pricing_type]
        );

        await client.query("COMMIT");
        return res.status(200).json({ message: "Service added to cart" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("addServiceCartItemController error:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ─── PATCH /api/service-cart/item/:id ─────────────────────────────────────
export const updateServiceCartItemController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { quantity } = req.body as Record<string, unknown>;
    const qty = typeof quantity === "number" ? quantity : parseInt(String(quantity), 10);
    if (!qty || qty < 1) return res.status(400).json({ message: "quantity must be >= 1" });

    try {
        // Ensure item belongs to this user
        const result = await pool.query(
            `UPDATE service_cart_items sci
             SET quantity = $1, updated_at = NOW()
             FROM carts c
             WHERE sci.id = $2 AND sci.cart_id = c.id AND c.user_id = $3
             RETURNING sci.id`,
            [qty, id, authUser.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Item not found" });
        }
        return res.status(200).json({ message: "Quantity updated" });
    } catch (error) {
        console.error("updateServiceCartItemController error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ─── DELETE /api/service-cart/item/:id ────────────────────────────────────
export const removeServiceCartItemController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    try {
        const result = await pool.query(
            `DELETE FROM service_cart_items sci
             USING carts c
             WHERE sci.id = $1 AND sci.cart_id = c.id AND c.user_id = $2
             RETURNING sci.id`,
            [id, authUser.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Item not found" });
        }
        return res.status(200).json({ message: "Item removed" });
    } catch (error) {
        console.error("removeServiceCartItemController error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ─── DELETE /api/service-cart ──────────────────────────────────────────────
export const clearServiceCartController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ message: "Unauthorized" });

    const cartType = normalizeCartType(req.query.type);
    try {
        await pool.query(
            `DELETE FROM service_cart_items sci
             USING carts c
             WHERE sci.cart_id = c.id AND c.user_id = $1 AND c.cart_type = $2`,
            [authUser.userId, cartType]
        );
        return res.status(200).json({ message: "Service cart cleared" });
    } catch (error) {
        console.error("clearServiceCartController error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

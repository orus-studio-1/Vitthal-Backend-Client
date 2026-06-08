import type { Request, Response } from "express";
import pool from "../DbConnect";

// ──────────────────────────────────────────────────────────────────────────────
// Haversine distance helper — returns km between two lat/lon points
// ──────────────────────────────────────────────────────────────────────────────
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const toRad = (v: number) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ──────────────────────────────────────────────────────────────────────────────
// Route planner: picks FCs that lie "on the corridor" between seller & buyer,
// then sorts them by ascending distance from the seller.
// Detour factor 1.4 = FC is accepted if it adds at most 40% extra distance.
// ──────────────────────────────────────────────────────────────────────────────
interface FcRow {
    id: string;
    name: string;
    city: string;
    state: string;
    pincode: string;
    latitude: number;
    longitude: number;
}

function computeRouteStops(
    sellerLat: number,
    sellerLon: number,
    buyerLat: number,
    buyerLon: number,
    allFcs: FcRow[],
    detourFactor = 1.4
): (FcRow & { distFromSeller: number; estimatedDays: number })[] {
    const directKm = haversineKm(sellerLat, sellerLon, buyerLat, buyerLon);

    const onRoute = allFcs
        .filter((fc) => {
            if (!fc.latitude || !fc.longitude) return false;
            const viaFc =
                haversineKm(sellerLat, sellerLon, fc.latitude, fc.longitude) +
                haversineKm(fc.latitude, fc.longitude, buyerLat, buyerLon);
            return viaFc <= directKm * detourFactor;
        })
        .map((fc) => ({
            ...fc,
            distFromSeller: haversineKm(sellerLat, sellerLon, fc.latitude, fc.longitude),
            // Simple ETA: 1 day per 400 km, minimum 1 day
            estimatedDays: Math.max(1, Math.ceil(haversineKm(sellerLat, sellerLon, fc.latitude, fc.longitude) / 400)),
        }))
        .sort((a, b) => a.distFromSeller - b.distFromSeller);

    return onRoute;
}

// ──────────────────────────────────────────────────────────────────────────────
// Generate route plan and save to DB
// ──────────────────────────────────────────────────────────────────────────────
async function generateAndSaveRoutePlan(orderId: string): Promise<void> {
    // 1. Get the order's destination + vendor info
    const orderQ = await pool.query(
        `SELECT o.vendor_id, o.latitude, o.langitude,
                CAST(o.latitude AS DOUBLE PRECISION) AS buyer_lat,
                CAST(o.langitude AS DOUBLE PRECISION) AS buyer_lon,
                o.city AS buyer_city, o.state AS buyer_state,
                a.latitude AS vendor_lat, a.longitude AS vendor_lon,
                a.city AS vendor_city_val, a.state AS vendor_state_val
         FROM orders o
         JOIN vendors v ON o.vendor_id = v.id
         LEFT JOIN addresses a ON a.user_id = v.user_id
         WHERE o.id = $1`,
        [orderId]
    );
    if (orderQ.rows.length === 0) return;
    const ord = orderQ.rows[0];

    const sellerLat = parseFloat(ord.vendor_lat) || null;
    const sellerLon = parseFloat(ord.vendor_lon) || null;
    const buyerLat  = parseFloat(ord.buyer_lat) || null;
    const buyerLon  = parseFloat(ord.buyer_lon) || null;

    // Cache vendor location on the order for display
    await pool.query(
        `UPDATE orders SET vendor_city = $1, vendor_state = $2, vendor_latitude = $3, vendor_longitude = $4
         WHERE id = $5`,
        [ord.vendor_city_val, ord.vendor_state_val, sellerLat, sellerLon, orderId]
    );

    // 2. If we don't have both coordinates, skip route generation
    if (!sellerLat || !sellerLon || !buyerLat || !buyerLon) return;

    // 3. Get all active fulfillment centers
    const fcQ = await pool.query(
        `SELECT id, name, city, state, pincode, latitude, longitude
         FROM fulfillment_centers
         WHERE is_active = TRUE AND latitude IS NOT NULL AND longitude IS NOT NULL`
    );
    const allFcs: FcRow[] = fcQ.rows;

    // 4. Compute route
    const routeStops = computeRouteStops(sellerLat, sellerLon, buyerLat, buyerLon, allFcs);

    // 5. Delete any existing route plan for this order (idempotent)
    await pool.query(`DELETE FROM order_route_plan WHERE order_id = $1`, [orderId]);

    // 6. Insert planned stops
    if (routeStops.length === 0) return; // direct delivery, no FCs on route

    const orderAcceptedAt = new Date();
    for (let i = 0; i < routeStops.length; i++) {
        const stop = routeStops[i];
        // Compute cumulative days from order acceptance for estimated arrival
        const cumulativeDays = routeStops
            .slice(0, i + 1)
            .reduce((sum, s) => sum + s.estimatedDays, 0);
        const estimatedArrival = new Date(orderAcceptedAt.getTime() + cumulativeDays * 86400000);

        await pool.query(
            `INSERT INTO order_route_plan
             (order_id, fulfillment_center_id, stop_sequence, center_name, center_city, center_state,
              center_pincode, center_latitude, center_longitude, estimated_arrival, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'upcoming')`,
            [
                orderId,
                stop.id,
                i + 1,
                stop.name,
                stop.city,
                stop.state,
                stop.pincode,
                stop.latitude,
                stop.longitude,
                estimatedArrival.toISOString(),
            ]
        );
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Controllers
// ══════════════════════════════════════════════════════════════════════════════

export const getOrdersController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'client') {
        return res.status(403).json({ message: "Only clients can view their orders" });
    }

    try {
        const query = `
            SELECT 
                o.id AS order_id,
                o.status,
                o.payment_status,
                o.total_amount,
                o.created_at,
                v.company_name AS vendor_name,
                (
                    SELECT json_agg(
                        json_build_object(
                            'product_id', oi.product_id,
                            'product_name', p.name,
                            'image_url', (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1),
                            'quantity', oi.quantity,
                            'price', oi.price
                        )
                    )
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = o.id
                ) AS items
            FROM orders o
            JOIN vendors v ON o.vendor_id = v.id
            WHERE o.user_id = $1
              AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
            ORDER BY o.created_at DESC;
        `;
        
        const result = await pool.query(query, [userId]);
        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching orders:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

export const getVendorOrdersController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'vendor') {
        return res.status(403).json({ message: "Only vendors can view their orders" });
    }

    try {
        const vendorQuery = `SELECT id FROM vendors WHERE user_id = $1;`;
        const vendorResult = await pool.query(vendorQuery, [userId]);
        
        if (vendorResult.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }

        const vendorId = vendorResult.rows[0].id;

        const query = `
            SELECT 
                o.id AS order_id,
                o.status,
                o.payment_status,
                o.total_amount,
                o.created_at,
                o.address_line,
                o.city,
                o.state,
                o.pincode,
                u.name AS customer_name,
                u.email AS customer_email,
                c.phone AS customer_phone,
                (
                    SELECT json_agg(
                        json_build_object(
                            'product_id', oi.product_id,
                            'product_name', p.name,
                            'image_url', (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1),
                            'quantity', oi.quantity,
                            'price', oi.price
                        )
                    )
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = o.id
                ) AS items
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN client c ON u.id = c.user_id
            WHERE o.vendor_id = $1
              AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
            ORDER BY o.created_at DESC;
        `;
        
        const result = await pool.query(query, [vendorId]);
        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching vendor orders:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

export const getVendorOrderByIdController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'vendor') {
        return res.status(403).json({ message: "Only vendors can view order details" });
    }

    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ message: "Order ID is required" });
    }

    try {
        const vendorQuery = `SELECT id FROM vendors WHERE user_id = $1;`;
        const vendorResult = await pool.query(vendorQuery, [userId]);
        
        if (vendorResult.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }

        const vendorId = vendorResult.rows[0].id;

        const query = `
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
                o.latitude,
                o.langitude,
                o.vendor_city,
                o.vendor_state,
                o.vendor_latitude,
                o.vendor_longitude,
                u.name AS customer_name,
                u.email AS customer_email,
                c.phone AS customer_phone,
                (
                    SELECT json_agg(
                        json_build_object(
                            'product_id', oi.product_id,
                            'product_name', p.name,
                            'product_description', p.description,
                            'image_url', (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1),
                            'quantity', oi.quantity,
                            'price', oi.price
                        ) ORDER BY oi.created_at
                    )
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = o.id
                ) AS items
            FROM orders o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN client c ON u.id = c.user_id
            WHERE o.id = $1 AND o.vendor_id = $2
              AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
            LIMIT 1;
        `;
        
        const result = await pool.query(query, [id, vendorId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Order not found or access denied" });
        }

        return res.status(200).json({ data: result.rows[0] });
    } catch (error) {
        console.error("Error fetching vendor order details:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

export const updateOrderStatusController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'vendor') {
        return res.status(403).json({ message: "Only vendors can update order status" });
    }

    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { status } = req.body;

    if (!id) return res.status(400).json({ message: "Order ID is required" });
    if (!status) return res.status(400).json({ message: "Status is required" });

    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'handed_over', 'received', 'dispatched'];
    if (!validStatuses.includes(status.toLowerCase())) {
        return res.status(400).json({ message: "Invalid status" });
    }

    try {
        const vendorQuery = `SELECT id FROM vendors WHERE user_id = $1;`;
        const vendorResult = await pool.query(vendorQuery, [userId]);
        
        if (vendorResult.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }

        const vendorId = vendorResult.rows[0].id;

        const orderCheckQuery = `SELECT id, status FROM orders WHERE id = $1 AND vendor_id = $2;`;
        const orderCheckResult = await pool.query(orderCheckQuery, [id, vendorId]);
        
        if (orderCheckResult.rows.length === 0) {
            return res.status(404).json({ message: "Order not found or access denied" });
        }

        const currentOrderStatus = orderCheckResult.rows[0].status;

        // Verify and deduct stock on accepting order
        if (status.toLowerCase() === 'processing' && currentOrderStatus === 'pending') {
            const itemsStockQuery = await pool.query(
                `SELECT oi.product_id, oi.quantity, vp.stock_quantity, p.name as product_name
                 FROM order_items oi
                 JOIN vendor_products vp ON vp.product_id = oi.product_id AND vp.vendor_id = oi.vendor_id
                 JOIN products p ON p.id = oi.product_id
                 WHERE oi.order_id = $1`,
                [id]
            );

            // 1. Verify stock sufficiency for all items
            for (const item of itemsStockQuery.rows) {
                if (Number(item.quantity) > Number(item.stock_quantity)) {
                    return res.status(400).json({
                        message: `Insufficient stock to accept this order. Product "${item.product_name}" has only ${item.stock_quantity} units available, but the order requires ${item.quantity} units.`
                    });
                }
            }

            // 2. Deduct stock
            for (const item of itemsStockQuery.rows) {
                await pool.query(
                    `UPDATE vendor_products 
                     SET stock_quantity = stock_quantity - $1, updated_at = NOW()
                     WHERE product_id = $2 AND vendor_id = $3`,
                    [item.quantity, item.product_id, vendorId]
                );
            }
        }

        // Update order status
        const updateQuery = `
            UPDATE orders 
            SET status = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND vendor_id = $3
            RETURNING id, status, updated_at;
        `;
        const result = await pool.query(updateQuery, [status.toLowerCase(), id, vendorId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Failed to update order" });
        }

        // Create status history entry
        const statusNotes: Record<string, string> = {
            'pending': 'Order placed by customer',
            'processing': 'Order accepted and being processed by vendor',
            'shipped': 'Order shipped by vendor',
            'delivered': 'Order delivered to customer',
            'cancelled': 'Order cancelled by vendor',
        };
        await pool.query(
            `INSERT INTO order_status_history (order_id, status, note, created_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [id, status.toLowerCase(), statusNotes[status.toLowerCase()] || `Status updated to ${status} by vendor`]
        );

        // Create fulfillment tracking entry
        if (['processing', 'shipped', 'delivered'].includes(status.toLowerCase())) {
            const fulfillmentNotes: Record<string, string> = {
                'processing': 'Order accepted and processing started',
                'shipped': 'Order dispatched from fulfillment center',
                'delivered': 'Order successfully delivered to customer',
            };
            await pool.query(
                `INSERT INTO order_fulfillment_tracking (order_id, status, note, created_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
                [id, status.toLowerCase(), fulfillmentNotes[status.toLowerCase()] || `Order ${status} by vendor`]
            );
        }

        if (status.toLowerCase() === 'delivered') {
            await pool.query(
                `INSERT INTO vendor_payouts (order_id, vendor_id, status, delivered_at, due_date)
                 SELECT 
                     o.id,
                     o.vendor_id,
                     'pending',
                     NOW(),
                     NOW() + (
                         COALESCE(
                             CASE 
                                 WHEN LOWER(v.credit_cycle) LIKE '%immediate%' THEN 0
                                 WHEN substring(v.credit_cycle from '\\d+') IS NOT NULL THEN substring(v.credit_cycle from '\\d+')::integer
                                 ELSE 15
                             END, 
                             15
                         ) * INTERVAL '1 day'
                     )
                 FROM orders o
                 JOIN vendors v ON o.vendor_id = v.id
                 WHERE o.id = $1
                 ON CONFLICT (order_id) DO UPDATE SET
                     delivered_at = EXCLUDED.delivered_at,
                     due_date = EXCLUDED.due_date,
                     updated_at = NOW()`,
                [id]
            );
        }

        // ── Route plan generation ─────────────────────────────────────────────
        // When vendor accepts (processing), compute the planned FC route.
        if (status.toLowerCase() === 'processing') {
            try {
                await generateAndSaveRoutePlan(id);
            } catch (routeErr) {
                // Non-fatal — tracking still works without a route plan
                if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
                    console.warn("Route plan generation failed (non-fatal):", routeErr);
                }
            }
        }

        return res.status(200).json({ 
            message: "Order status updated successfully",
            data: result.rows[0]
        });
    } catch (error) {
        console.error("Error updating order status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared tracking query helper — returns full tracking data for an order.
// Used by both client (getOrderTrackingController) and vendor
// (getVendorOrderTrackingController) so the data shape is identical.
// ──────────────────────────────────────────────────────────────────────────────
async function fetchOrderTrackingData(orderId: string) {
    // Order details
    const orderQ = await pool.query(
        `SELECT 
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
            o.latitude,
            o.langitude,
            o.order_reference,
            o.order_notes,
            o.vendor_city,
            o.vendor_state,
            o.vendor_latitude,
            o.vendor_longitude,
            v.company_name AS vendor_name,
            v.id AS vendor_id
         FROM orders o
         JOIN vendors v ON o.vendor_id = v.id
         WHERE o.id = $1`,
        [orderId]
    );
    if (orderQ.rows.length === 0) return null;
    const order = orderQ.rows[0];

    // Items
    const itemsQ = await pool.query(
        `SELECT 
            oi.product_id,
            p.name AS product_name,
            p.description AS product_description,
            (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1) AS image_url,
            oi.quantity,
            oi.price
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1
         ORDER BY oi.created_at`,
        [orderId]
    );

    // Status history
    const histQ = await pool.query(
        `SELECT id, status, note, created_at
         FROM order_status_history
         WHERE order_id = $1
         ORDER BY created_at ASC`,
        [orderId]
    );

    // Fulfillment tracking with center details
    const ftQ = await pool.query(
        `SELECT 
            oft.id,
            oft.status AS fulfillment_status,
            oft.note AS fulfillment_note,
            oft.created_at AS fulfillment_updated_at,
            oft.stop_sequence,
            oft.location_label,
            fc.id AS center_id,
            fc.name AS center_name,
            fc.address AS center_address,
            fc.city AS center_city,
            fc.state AS center_state,
            fc.country AS center_country,
            fc.pincode AS center_pincode,
            fc.latitude AS center_latitude,
            fc.longitude AS center_longitude
         FROM order_fulfillment_tracking oft
         LEFT JOIN fulfillment_centers fc ON oft.fulfillment_center_id = fc.id
         WHERE oft.order_id = $1
         ORDER BY oft.created_at ASC`,
        [orderId]
    );

    // Route plan (planned stops)
    const routeQ = await pool.query(
        `SELECT 
            id,
            stop_sequence,
            fulfillment_center_id,
            center_name,
            center_city,
            center_state,
            center_pincode,
            center_latitude,
            center_longitude,
            estimated_arrival,
            actual_arrival,
            status
         FROM order_route_plan
         WHERE order_id = $1
         ORDER BY stop_sequence ASC`,
        [orderId]
    );

    return {
        order,
        items: itemsQ.rows,
        statusHistory: histQ.rows,
        fulfillmentTracking: ftQ.rows,
        routePlan: routeQ.rows,
    };
}

export const getOrderTrackingController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'client') {
        return res.status(403).json({ message: "Only clients can track orders" });
    }

    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) return res.status(400).json({ message: "Order ID is required" });

    try {
        // Verify ownership first
        const ownerQ = await pool.query(
            `SELECT id FROM orders WHERE id = $1 AND user_id = $2 AND NOT (status = 'pending' AND payment_status = 'pending' AND source IN ('client', 'quotation'))`,
            [id, userId]
        );
        if (ownerQ.rows.length === 0) {
            return res.status(404).json({ message: "Order not found or access denied" });
        }

        const data = await fetchOrderTrackingData(id);
        if (!data) return res.status(404).json({ message: "Order not found" });

        return res.status(200).json({ data });
    } catch (error) {
        console.error("Error fetching order tracking:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

export const getVendorOrderTrackingController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'vendor') {
        return res.status(403).json({ message: "Only vendors can access vendor order tracking" });
    }

    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) return res.status(400).json({ message: "Order ID is required" });

    try {
        // Resolve vendor id
        const vendorQ = await pool.query(`SELECT id FROM vendors WHERE user_id = $1`, [userId]);
        if (vendorQ.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }
        const vendorId = vendorQ.rows[0].id;

        // Verify order belongs to this vendor
        const ownerQ = await pool.query(
            `SELECT id FROM orders WHERE id = $1 AND vendor_id = $2 AND NOT (status = 'pending' AND payment_status = 'pending' AND source IN ('client', 'quotation'))`,
            [id, vendorId]
        );
        if (ownerQ.rows.length === 0) {
            return res.status(404).json({ message: "Order not found or access denied" });
        }

        const data = await fetchOrderTrackingData(id);
        if (!data) return res.status(404).json({ message: "Order not found" });

        return res.status(200).json({ data });
    } catch (error) {
        console.error("Error fetching vendor order tracking:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

export const getVendorPayoutsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;
    if (role !== 'vendor') {
        return res.status(403).json({ message: "Only vendors can view their payouts" });
    }

    try {
        // Resolve vendor id
        const vendorQ = await pool.query(`SELECT id FROM vendors WHERE user_id = $1`, [userId]);
        if (vendorQ.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }
        const vendorId = vendorQ.rows[0].id;

        const query = `
            SELECT 
                vp.id AS payout_id,
                vp.order_id,
                vp.vendor_id,
                vp.payout_percentage,
                vp.payout_amount,
                vp.status AS payout_status,
                vp.delivered_at,
                vp.due_date,
                vp.last_paid_at,
                vp.notes AS payout_notes,
                o.total_amount AS order_total_amount,
                o.status AS order_status,
                o.payment_status AS client_payment_status,
                COALESCE(o.customer_name, u.name) AS customer_name,
                v.company_name AS vendor_name,
                v.credit_cycle AS vendor_credit_cycle,
                -- Successful client payments total
                COALESCE((
                    SELECT SUM(p.amount)
                    FROM payments p
                    WHERE p.status = 'successful'
                      AND (
                          vp.order_id = ANY(p.order_ids) 
                          OR p.quotation_request_id = (SELECT id FROM quotation_requests WHERE order_id = vp.order_id LIMIT 1)
                      )
                ), 0) AS client_paid_amount,
                -- Successful client payments split percentage sum
                COALESCE((
                    SELECT SUM(p.split_percentage)
                    FROM payments p
                    WHERE p.status = 'successful'
                      AND (
                          vp.order_id = ANY(p.order_ids) 
                          OR p.quotation_request_id = (SELECT id FROM quotation_requests WHERE order_id = vp.order_id LIMIT 1)
                      )
                ), 0) AS client_paid_percentage
            FROM vendor_payouts vp
            JOIN orders o ON o.id = vp.order_id
            JOIN vendors v ON v.id = vp.vendor_id
            LEFT JOIN users u ON u.id = o.user_id
            WHERE vp.vendor_id = $1
              AND o.status NOT IN ('pending', 'cancelled')
              AND (o.source = 'admin' OR o.payment_status = 'paid')
            ORDER BY vp.created_at DESC
        `;
        const result = await pool.query(query, [vendorId]);
        return res.status(200).json({ message: "Vendor payouts retrieved successfully", data: result.rows });
    } catch (error) {
        console.error("Error fetching vendor payouts:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

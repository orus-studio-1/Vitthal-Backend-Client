import type { Request, Response } from "express";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal, uploadBufferToS3 } from "../services/s3.service"; // NOTE: adapt uploadBufferToS3 to your real S3 upload function
import { createNotification } from "./Notification.controller";
import { generateInvoicePDFBuffer } from "../services/invoiceDocument.service";

// Helper: resolve S3 image URLs inside order items arrays
async function resolveItemImages(items: any[] | null): Promise<any[] | null> {
    if (!items || !Array.isArray(items)) return items;
    return Promise.all(
        items.map(async (item: any) => ({
            ...item,
            image_url: await getPresignedUrlOrOriginal(item.image_url),
        }))
    );
}

// Helper: resolve S3 URLs for the optional dispatch documents (all fields may be null)
async function resolveDispatchDocs(d: any | null) {
    if (!d) return null;
    const r = async (u: string | null) => (u ? await getPresignedUrlOrOriginal(u) : null);
    return {
        ...d,
        eway_bill_url: await r(d.eway_bill_url),
        delivery_challan_url: await r(d.delivery_challan_url),
        invoice_url: await r(d.invoice_url),
        lr_document_url: await r(d.lr_document_url),
    };
}

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
    user_id: string;
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
export async function generateAndSaveRoutePlan(orderId: string): Promise<void> {
    // 1. Get the order's destination + vendor info
    const orderQ = await pool.query(
        `SELECT o.vendor_id, o.latitude, o.langitude, o.order_reference,
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

    // Generate verification keys (OTP and QR tokens)
    const pickupOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const deliveryOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const randomHex = Math.random().toString(36).substring(2, 10).toUpperCase();
    const pickupQr = `PICKUP-${orderId.substring(0, 8).toUpperCase()}-${randomHex}`;
    const deliveryQr = `DELIVERY-${orderId.substring(0, 8).toUpperCase()}-${randomHex}`;

    // Cache vendor location + verification codes on the order for display
    await pool.query(
        `UPDATE orders 
         SET vendor_city = $1, vendor_state = $2, vendor_latitude = $3, vendor_longitude = $4,
             pickup_otp = $5, pickup_qr_token = $6, delivery_otp = $7, delivery_qr_token = $8
         WHERE id = $9`,
        [ord.vendor_city_val, ord.vendor_state_val, sellerLat, sellerLon, pickupOtp, pickupQr, deliveryOtp, deliveryQr, orderId]
    );

    // 3. Get all active fulfillment centers
    const fcQ = await pool.query(
        `SELECT id, user_id, name, city, state, pincode, latitude, longitude
         FROM fulfillment_centers
         WHERE status = 'active'`
    );
    const allFcs: FcRow[] = fcQ.rows;

    // 4. Compute route
    let routeStops: any[] = [];
    if (sellerLat && sellerLon && buyerLat && buyerLon) {
        routeStops = computeRouteStops(sellerLat, sellerLon, buyerLat, buyerLon, allFcs.filter(f => f.latitude && f.longitude));
    }

    // Fallback: If no intermediate FC is found on the route (or coordinates are missing),
    // assign the closest active FC to the seller (or just the first active FC)
    if (routeStops.length === 0 && allFcs.length > 0) {
        let selectedFc = allFcs[0];
        if (sellerLat && sellerLon) {
            // Find the closest FC to the vendor (only checking FCs with valid coordinates)
            const fcsWithCoords = allFcs.filter(f => f.latitude && f.longitude);
            if (fcsWithCoords.length > 0) {
                selectedFc = fcsWithCoords.reduce((closest, current) => {
                    const currentDist = haversineKm(sellerLat, sellerLon, current.latitude, current.longitude);
                    const closestDist = haversineKm(sellerLat, sellerLon, closest.latitude, closest.longitude);
                    return currentDist < closestDist ? current : closest;
                }, fcsWithCoords[0]);
            }
        }
        
        routeStops = [{
            ...selectedFc,
            distFromSeller: sellerLat && sellerLon && selectedFc.latitude && selectedFc.longitude 
                ? haversineKm(sellerLat, sellerLon, selectedFc.latitude, selectedFc.longitude) 
                : 0,
            estimatedDays: 1
        }];
    }

    // 5. Delete any existing route plan for this order (idempotent)
    await pool.query(`DELETE FROM order_route_plan WHERE order_id = $1`, [orderId]);

    // 6. Insert planned stops
    if (routeStops.length === 0) return; // no active FCs available in system

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

    // Notify the first fulfillment center (assigned to handle pickup)
    const firstStopFc = routeStops[0];
    if (firstStopFc && firstStopFc.user_id) {
        await createNotification({
            userId: firstStopFc.user_id,
            type: 'general',
            title: 'New Pickup Assigned',
            body: `Order ${ord.order_reference || 'N/A'} has been accepted by the vendor. Please assign a delivery agent for pickup.`,
            referenceType: 'order',
            referenceId: orderId
        });
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
                            'product_variant_id', oi.product_variant_id,
                            'variant_properties', pv.properties,
                            'variant_name', pv.name,
                            'product_name', p.name,
                            'image_url', (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1),
                            'quantity', oi.quantity,
                            'price', oi.price,
                            'original_price', oi.original_price
                        )
                    )
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
                    WHERE oi.order_id = o.id
                ) AS items
            FROM orders o
            JOIN vendors v ON o.vendor_id = v.id
            WHERE o.user_id = $1
              AND NOT (o.status = 'pending' AND o.payment_status = 'pending' AND o.source IN ('client', 'quotation'))
            ORDER BY o.created_at DESC;
        `;
        
        const result = await pool.query(query, [userId]);

        // Resolve S3 image URLs for each order's items
        const rows = await Promise.all(
            result.rows.map(async (row: any) => ({
                ...row,
                items: await resolveItemImages(row.items),
            }))
        );

        return res.status(200).json({ data: rows });
    } catch (error) {
        console.error("Error fetching orders:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

export const getVendorOrdersController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        console.log('here comes the message')
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
                o.order_type AS order_type,
                COALESCE(o.customer_name, u.name) AS customer_name,
                COALESCE(o.customer_email, u.email) AS customer_email,
                COALESCE(o.customer_phone, c.phone) AS customer_phone,
                EXISTS (SELECT 1 FROM order_dispatch_details d WHERE d.order_id = o.id) AS has_dispatch_details,
                (
                    SELECT json_agg(
                        json_build_object(
                            'product_id', oi.product_id,
                            'product_variant_id', oi.product_variant_id,
                            'variant_properties', pv.properties,
                            'variant_name', pv.name,
                            'product_name', p.name,
                            'image_url', (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1),
                            'quantity', oi.quantity,
                            'price', oi.price,
                            'original_price', oi.original_price
                        )
                    )
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
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

        // Resolve S3 image URLs for each order's items
        const rows = await Promise.all(
            result.rows.map(async (row: any) => ({
                ...row,
                items: await resolveItemImages(row.items),
            }))
        );

        return res.status(200).json({ data: rows });
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
                o.pickup_otp,
                o.created_at,
                o.updated_at,
                o.address_line,
                o.city,
                o.state,
                o.country,
                o.pincode,
                o.order_type AS order_type,
                o.latitude,
                o.langitude,
                o.vendor_city,
                o.vendor_state,
                o.vendor_latitude,
                o.vendor_longitude,
                COALESCE(o.customer_name, u.name) AS customer_name,
                COALESCE(o.customer_email, u.email) AS customer_email,
                COALESCE(o.customer_phone, c.phone) AS customer_phone,
                (
                    SELECT row_to_json(od) FROM (
                        SELECT d.lr_number, d.eway_bill_number, d.transporter_name,
                               d.eway_bill_url, d.delivery_challan_url, d.invoice_url,
                               d.lr_document_url, d.updated_at
                        FROM order_dispatch_details d
                        WHERE d.order_id = o.id
                    ) od
                ) AS dispatch_details,
                (
                    SELECT json_agg(
                        json_build_object(
                            'product_id', oi.product_id,
                            'product_variant_id', oi.product_variant_id,
                            'variant_properties', pv.properties,
                            'variant_name', pv.name,
                            'product_name', p.name,
                            'product_description', p.description,
                            'image_url', (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1),
                            'quantity', oi.quantity,
                            'price', oi.price,
                            'original_price', oi.original_price
                        ) ORDER BY oi.created_at
                    )
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
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

        // Resolve S3 image URLs for items + dispatch documents
        const order = {
            ...result.rows[0],
            items: await resolveItemImages(result.rows[0].items),
            dispatch_details: await resolveDispatchDocs(result.rows[0].dispatch_details),
        };

        return res.status(200).json({ data: order });
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

    // Vendor can only accept (processing) or cancel orders.
    // Shipped/delivered are controlled by the FC/rider pipeline.
    const validVendorStatuses = ['processing', 'cancelled'];
    if (!validVendorStatuses.includes(status.toLowerCase())) {
        return res.status(400).json({ message: "Vendors can only accept or cancel orders. Shipping and delivery are handled by the fulfillment center." });
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
                `SELECT oi.product_id, oi.product_variant_id, oi.quantity, vp.stock_quantity, p.name as product_name
                 FROM order_items oi
                 JOIN vendor_products vp ON vp.product_variant_id = oi.product_variant_id AND vp.vendor_id = oi.vendor_id
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
                     WHERE product_variant_id = $2 AND vendor_id = $3`,
                    [item.quantity, item.product_variant_id, vendorId]
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
            'processing': 'Order accepted by vendor — awaiting fulfillment center pickup',
            'cancelled': 'Order cancelled by vendor',
        };
        await pool.query(
            `INSERT INTO order_status_history (order_id, status, note, created_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [id, status.toLowerCase(), statusNotes[status.toLowerCase()] || `Status updated to ${status} by vendor`]
        );

        // Create fulfillment tracking entry for vendor acceptance
        if (status.toLowerCase() === 'processing') {
            await pool.query(
                `INSERT INTO order_fulfillment_tracking (order_id, status, note, created_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
                [id, 'processing', 'Order accepted by vendor — ready for pickup by fulfillment center rider']
            );
        }

        // ── Route plan generation ─────────────────────────────────────────────
        // When vendor accepts (processing), compute the planned FC route
        // and set the first stop to pickup_pending so the FC gets notified.
        if (status.toLowerCase() === 'processing') {
            try {
                await generateAndSaveRoutePlan(id);

                // Set the first FC stop to pickup_pending — this is how the FC
                // sees "a vendor has a package ready for pickup" in their dashboard.
                await pool.query(
                    `UPDATE order_route_plan 
                     SET status = 'pickup_pending', updated_at = NOW()
                     WHERE order_id = $1 AND stop_sequence = 1`,
                    [id]
                );
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
// Optional dispatch details (LR number, e-way bill, delivery challan, invoice).
// Purely informational: does NOT change order status, route plan, stock,
// payouts or notifications. Safe to call multiple times (upsert); fields that
// are not sent keep their previous values.
// ──────────────────────────────────────────────────────────────────────────────
export const saveOrderDispatchDetailsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || authUser?.role !== 'vendor') {
        return res.status(403).json({ message: "Only vendors can add dispatch details" });
    }

    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) return res.status(400).json({ message: "Order ID is required" });

    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const eway = files.eway_bill?.[0];
    const challan = files.delivery_challan?.[0];
    const invoice = files.invoice?.[0];
    const lrDoc = files.lr_document?.[0];

    const clean = (v: unknown) => (String(v ?? "").trim() || null);
    const lrNumber = clean(req.body.lr_number);
    const ewayNumber = clean(req.body.eway_bill_number);
    const transporter = clean(req.body.transporter_name);

    if (!eway && !challan && !invoice && !lrDoc && !lrNumber && !ewayNumber && !transporter) {
        return res.status(400).json({ message: "Provide at least one detail or document." });
    }

    try {
        const vendorQ = await pool.query(`SELECT id FROM vendors WHERE user_id = $1`, [authUser.userId]);
        if (!vendorQ.rows.length) return res.status(404).json({ message: "Vendor not found" });
        const vendorId = vendorQ.rows[0].id;

        const orderQ = await pool.query(
            `SELECT status FROM orders WHERE id = $1 AND vendor_id = $2`,
            [id, vendorId]
        );
        if (!orderQ.rows.length) return res.status(404).json({ message: "Order not found or access denied" });
        if (orderQ.rows[0].status !== 'processing') {
            return res.status(400).json({
                message: "Dispatch details can only be added while the order is processing."
            });
        }

        const prefix = `orders/${id}/dispatch`;
        const up = async (
            f: Express.Multer.File | undefined,
            name: string
        ): Promise<string | null> => {
            if (!f) return null;

            const uploaded = await uploadBufferToS3(
                f.buffer,
                `${prefix}/${name}-${Date.now()}`,
                f.mimetype
            );

            return uploaded.s3Key;
        };

        const [ewayUrl, challanUrl, invoiceUrl, lrUrl] = await Promise.all([
            up(eway, "eway-bill"),
            up(challan, "delivery-challan"),
            up(invoice, "invoice"),
            up(lrDoc, "lr"),
        ]);

        const result = await pool.query(
            `INSERT INTO order_dispatch_details
                (order_id, vendor_id, lr_number, eway_bill_number, transporter_name,
                 eway_bill_url, delivery_challan_url, invoice_url, lr_document_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (order_id) DO UPDATE SET
                lr_number            = COALESCE(EXCLUDED.lr_number, order_dispatch_details.lr_number),
                eway_bill_number     = COALESCE(EXCLUDED.eway_bill_number, order_dispatch_details.eway_bill_number),
                transporter_name     = COALESCE(EXCLUDED.transporter_name, order_dispatch_details.transporter_name),
                eway_bill_url        = COALESCE(EXCLUDED.eway_bill_url, order_dispatch_details.eway_bill_url),
                delivery_challan_url = COALESCE(EXCLUDED.delivery_challan_url, order_dispatch_details.delivery_challan_url),
                invoice_url          = COALESCE(EXCLUDED.invoice_url, order_dispatch_details.invoice_url),
                lr_document_url      = COALESCE(EXCLUDED.lr_document_url, order_dispatch_details.lr_document_url),
                updated_at           = NOW()
             RETURNING *`,
            [id, vendorId, lrNumber, ewayNumber, transporter, ewayUrl, challanUrl, invoiceUrl, lrUrl]
        );

        return res.status(200).json({
            message: "Dispatch details saved",
            data: await resolveDispatchDocs(result.rows[0]),
        });
    } catch (error) {
        console.error("Error saving dispatch details:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

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
            o.pickup_otp,
            o.delivery_otp,
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
            oi.product_variant_id,
            pv.properties AS variant_properties,
            pv.name AS variant_name,
            p.name AS product_name,
            p.description AS product_description,
            (SELECT image_url FROM products_images pi WHERE pi.product_id = p.id AND pi.is_primary = true LIMIT 1) AS image_url,
            oi.quantity,
            oi.price,
            oi.original_price
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
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

    // Resolve S3 image URLs for items
    const resolvedItems = await resolveItemImages(itemsQ.rows);

    return {
        order,
        items: resolvedItems,
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
        // Resolve vendor id and type
        const vendorQ = await pool.query(`SELECT id, vendor_type FROM vendors WHERE user_id = $1`, [userId]);
        if (vendorQ.rows.length === 0) {
            return res.status(404).json({ message: "Vendor not found" });
        }
        const vendorId = vendorQ.rows[0].id;
        const isService = vendorQ.rows[0].vendor_type === 'service';

        if (isService) {
            // ─── SERVICE VENDOR: return service_bookings as payout records ───────
            const serviceQuery = `
                SELECT 
                    sb.id AS payout_id,
                    sb.id AS order_id,
                    sb.vendor_id,
                    100 AS payout_percentage,
                    sb.total_amount AS payout_amount,
                    CASE
                        WHEN sb.payment_status = 'paid' THEN 'paid'
                        WHEN sb.status = 'completed' THEN 'pending'
                        ELSE 'pending'
                    END AS payout_status,
                    CASE WHEN sb.status = 'completed' THEN sb.updated_at ELSE NULL END AS delivered_at,
                    NULL AS due_date,
                    CASE WHEN sb.payment_status = 'paid' THEN sb.updated_at ELSE NULL END AS last_paid_at,
                    sb.booking_notes AS payout_notes,
                    sb.total_amount AS order_total_amount,
                    sb.status AS order_status,
                    sb.payment_status AS client_payment_status,
                    u.name AS customer_name,
                    v.company_name AS vendor_name,
                    v.credit_cycle AS vendor_credit_cycle,
                    CASE WHEN sb.payment_status = 'paid' THEN sb.total_amount ELSE 0 END AS client_paid_amount,
                    CASE WHEN sb.payment_status = 'paid' THEN 100 ELSE 0 END AS client_paid_percentage
                FROM service_bookings sb
                JOIN users u ON sb.user_id = u.id
                JOIN vendors v ON v.id = sb.vendor_id
                WHERE sb.vendor_id = $1
                  AND sb.status NOT IN ('cancelled', 'pending')
                ORDER BY sb.created_at DESC
            `;
            const serviceResult = await pool.query(serviceQuery, [vendorId]);
            return res.status(200).json({ message: "Vendor payouts retrieved successfully", data: serviceResult.rows });
        }

        // ─── PRODUCT VENDOR: original vendor_payouts logic ───────────────────
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

export const getOrderInvoiceController = async (req: Request, res: Response): Promise<Response | void> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const rawOrderId = req.params.orderId;
    const orderId = Array.isArray(rawOrderId) ? rawOrderId[0] : rawOrderId;

    if (!orderId) {
        return res.status(400).json({ message: "Order ID is required" });
    }

    try {
        // Query to check if the order exists and get vendor info
        const orderQ = await pool.query(
            `SELECT id, vendor_id, (SELECT id FROM vendors WHERE user_id = $1 LIMIT 1) as request_vendor_id 
             FROM orders 
             WHERE id = $2`,
            [authUser.userId, orderId]
        );

        if (orderQ.rows.length === 0) {
            return res.status(404).json({ message: "Order not found" });
        }

        const order = orderQ.rows[0];

        // Access check: only admins, or the vendor who owns the order can access the invoice
        const isAdmin = authUser.role === 'admin' || authUser.role === 'super_admin';
        const isOwnerVendor = authUser.role === 'vendor' && order.vendor_id === order.request_vendor_id;

        if (!isAdmin && !isOwnerVendor) {
            return res.status(403).json({ message: "Forbidden. You do not have permission to view this invoice." });
        }

        const pdfBuffer = await generateInvoicePDFBuffer(orderId);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=invoice-${orderId}.pdf`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error("Error generating invoice PDF:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import pool from "../DbConnect";
import { sendExpoPushNotification } from "../services/pushNotification.service";
import { razorpay } from "../services/razorpay.service";
import QRCode from "qrcode";

// Helper to resolve the hub details using the authenticated user's ID
async function resolveHubDetails(userId: string) {
    const res = await pool.query(
        `SELECT id, name, code, pincode, total_area_sqft, capacity_packages 
         FROM fulfillment_centers 
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
    );
    return res.rows[0];
}

// 1. GET /api/delivery/hub/stats
export const getHubStatsController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized. Hub Manager access only." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Fulfillment center profile not found." });
        }

        // Count online riders registered to this hub
        const onlineRidersRes = await pool.query(
            `SELECT COUNT(*) FROM delivery_agents 
             WHERE fulfillment_center_id = $1 AND status = 'active' AND is_online = TRUE`,
            [hub.id]
        );

        // Count expected inbound packages (in_transit status in route plan)
        const inboundRes = await pool.query(
            `SELECT COUNT(*) FROM order_route_plan 
             WHERE fulfillment_center_id = $1 AND status = 'in_transit'`,
            [hub.id]
        );

        // Count physically shelved packages (arrived status in route plan)
        const shelvedRes = await pool.query(
            `SELECT COUNT(*) FROM order_route_plan 
             WHERE fulfillment_center_id = $1 AND status = 'arrived'`,
            [hub.id]
        );

        // Count total registered riders (active + blocked, not deleted)
        const totalRidersRes = await pool.query(
            `SELECT COUNT(*) FROM delivery_agents 
             WHERE fulfillment_center_id = $1 AND status != 'deleted'`,
            [hub.id]
        );

        // Count packages dispatched today (departed status, updated today)
        const dispatchedTodayRes = await pool.query(
            `SELECT COUNT(*) FROM order_route_plan 
             WHERE fulfillment_center_id = $1 AND status = 'departed' 
             AND updated_at >= CURRENT_DATE`,
            [hub.id]
        );

        // Count aging stock: shelved packages older than 24 hours
        const agingStockRes = await pool.query(
            `SELECT COUNT(*) FROM order_route_plan 
             WHERE fulfillment_center_id = $1 AND status = 'arrived' 
             AND actual_arrival < NOW() - INTERVAL '24 hours'`,
            [hub.id]
        );

        const onlineRidersCount = parseInt(onlineRidersRes.rows[0].count, 10) || 0;
        const expectedInboundCount = parseInt(inboundRes.rows[0].count, 10) || 0;
        const shelvedCount = parseInt(shelvedRes.rows[0].count, 10) || 0;
        const totalRidersCount = parseInt(totalRidersRes.rows[0].count, 10) || 0;
        const dispatchedTodayCount = parseInt(dispatchedTodayRes.rows[0].count, 10) || 0;
        const agingStockCount = parseInt(agingStockRes.rows[0].count, 10) || 0;

        return res.status(200).json({
            message: "Stats retrieved successfully",
            data: {
                hubInfo: {
                    id: hub.id,
                    name: hub.name,
                    code: hub.code,
                    pincode: hub.pincode,
                    totalAreaSqft: hub.total_area_sqft,
                    capacity: hub.capacity_packages || 0
                },
                onlineRidersCount,
                totalRidersCount,
                expectedInboundCount,
                shelvedCount,
                dispatchedTodayCount,
                agingStockCount
            }
        });
    } catch (error) {
        console.error("Error retrieving hub stats:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 2. GET /api/delivery/hub/expected-inbound
export const getExpectedInboundController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        const query = `
            SELECT orp.id as stop_id, orp.order_id, orp.stop_sequence, orp.estimated_arrival,
                   o.order_reference, o.customer_name, o.customer_phone,
                   v.company_name as vendor_name,
                   (
                       SELECT u.name 
                       FROM order_fulfillment_tracking oft
                       JOIN delivery_agents da ON oft.delivery_agent_id = da.id
                       JOIN users u ON da.user_id = u.id
                       WHERE oft.order_id = orp.order_id AND oft.delivery_agent_id IS NOT NULL
                       ORDER BY oft.created_at DESC LIMIT 1
                   ) as assigned_rider_name,
                   (
                       SELECT da.special_rider_id
                       FROM order_fulfillment_tracking oft
                       JOIN delivery_agents da ON oft.delivery_agent_id = da.id
                       WHERE oft.order_id = orp.order_id AND oft.delivery_agent_id IS NOT NULL
                       ORDER BY oft.created_at DESC LIMIT 1
                   ) as assigned_special_rider_id,
                   (
                       SELECT da.contact_phone 
                       FROM order_fulfillment_tracking oft
                       JOIN delivery_agents da ON oft.delivery_agent_id = da.id
                       WHERE oft.order_id = orp.order_id AND oft.delivery_agent_id IS NOT NULL
                       ORDER BY oft.created_at DESC LIMIT 1
                   ) as assigned_rider_phone,
                   (
                       SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                       FROM order_items oi
                       JOIN products p ON oi.product_id = p.id
                       WHERE oi.order_id = orp.order_id AND oi.vendor_id = o.vendor_id
                   ) as items,
                   (
                       SELECT note 
                       FROM order_fulfillment_tracking 
                       WHERE order_id = orp.order_id
                       ORDER BY created_at DESC LIMIT 1
                   ) as last_tracking_note
            FROM order_route_plan orp
            JOIN orders o ON orp.order_id = o.id
            JOIN vendors v ON o.vendor_id = v.id
            WHERE orp.fulfillment_center_id = $1 AND orp.status = 'in_transit'
            ORDER BY orp.estimated_arrival ASC
        `;
        const result = await pool.query(query, [hub.id]);

        return res.status(200).json({
            message: "Expected shipments retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error retrieving expected inbound:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 3. POST /api/delivery/hub/inbound-scan
export const postInboundScanController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderIdentifier, shelfLocation } = req.body; // orderIdentifier is order_id or order_reference

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }
    if (!orderIdentifier) {
        return res.status(400).json({ message: "Order ID or Order Reference is required." });
    }

    const client = await pool.connect();
    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        await client.query("BEGIN");

        // Resolve order
        const orderRes = await client.query(
            "SELECT id, order_reference FROM orders WHERE id::text = $1 OR order_reference = $1",
            [orderIdentifier]
        );
        if (orderRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Order not found." });
        }
        const order = orderRes.rows[0];

        // Find the active stop for this hub on the order path
        const stopRes = await client.query(
            `SELECT id, stop_sequence, pickup_rider_id FROM order_route_plan 
             WHERE order_id = $1 AND fulfillment_center_id = $2 AND status = 'in_transit'`,
            [order.id, hub.id]
        );
        if (stopRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ 
                message: "This order is not expected to be received at this hub or is already received." 
            });
        }
        const stop = stopRes.rows[0];

        // Update stop status to arrived
        await client.query(
            `UPDATE order_route_plan 
             SET status = 'arrived', actual_arrival = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [stop.id]
        );

        // Insert into tracking log with the pickup rider ID attached
        const locationLabel = `${hub.name} (${hub.code})`;
        const note = shelfLocation ? `Shelved at Location: ${shelfLocation}` : "Received at hub";
        await client.query(
            `INSERT INTO order_fulfillment_tracking (order_id, fulfillment_center_id, status, note, location_label, stop_sequence, delivery_agent_id)
             VALUES ($1, $2, 'received', $3, $4, $5, $6)`,
            [order.id, hub.id, note, locationLabel, stop.stop_sequence, stop.pickup_rider_id || null]
        );

        await client.query("COMMIT");
        return res.status(200).json({
            message: "Package successfully received and shelved.",
            data: { orderId: order.id, reference: order.order_reference, shelfLocation }
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error receiving inbound package:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 4. GET /api/delivery/hub/inventory
export const getHubInventoryController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        const query = `
            SELECT orp.id as stop_id, orp.order_id, orp.actual_arrival, orp.stop_sequence,
                   o.order_reference, o.customer_name, o.customer_phone, o.address_line, o.city, o.state, o.pincode,
                   v.company_name as vendor_name,
                   (
                       SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                       FROM order_items oi
                       JOIN products p ON oi.product_id = p.id
                       WHERE oi.order_id = orp.order_id AND oi.vendor_id = o.vendor_id
                   ) as items,
                   (
                       SELECT note 
                       FROM order_fulfillment_tracking 
                       WHERE order_id = orp.order_id AND status = 'received' 
                       ORDER BY created_at DESC LIMIT 1
                   ) as last_tracking_note
            FROM order_route_plan orp
            JOIN orders o ON orp.order_id = o.id
            JOIN vendors v ON o.vendor_id = v.id
            WHERE orp.fulfillment_center_id = $1 AND orp.status = 'arrived'
            ORDER BY orp.actual_arrival DESC
        `;
        const result = await pool.query(query, [hub.id]);

        return res.status(200).json({
            message: "Inventory retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error retrieving inventory:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 5. PATCH /api/delivery/hub/inventory/:packageId/status
export const patchInventoryItemStatusController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { packageId } = req.params; // order_id
    const { issueType, description } = req.body;

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }
    if (!issueType || !description) {
        return res.status(400).json({ message: "Issue type and description are required." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        // Insert a new audit log event in the tracking history
        const locationLabel = `${hub.name} (${hub.code})`;
        const note = `[AUDIT ALERT: ${issueType}] ${description}`;
        await pool.query(
            `INSERT INTO order_fulfillment_tracking (order_id, fulfillment_center_id, status, note, location_label)
             VALUES ($1, $2, 'processing', $3, $4)`,
            [packageId, hub.id, note, locationLabel]
        );

        return res.status(200).json({
            message: "Inventory item status successfully updated/flagged.",
            data: { packageId, issueType, note }
        });
    } catch (error) {
        console.error("Error updating inventory status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 6. GET /api/delivery/hub/pending-outbound
export const getPendingOutboundController = async (req: Request, res: Response): Promise<Response> => {
    // Dynamically, outbound packages are items physically shelved (status = arrived) at this hub
    return getHubInventoryController(req, res);
};

// 7. POST /api/delivery/hub/handover-scan
export const postHandoverScanController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId, riderSpecialId } = req.body;

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }
    if (!orderId || !riderSpecialId) {
        return res.status(400).json({ message: "Order ID and Rider Special ID are required." });
    }

    const client = await pool.connect();
    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        await client.query("BEGIN");

        // Verify the Rider exists, is active, and registered at this hub
        const riderRes = await client.query(
            `SELECT id, user_id, push_token FROM delivery_agents 
             WHERE special_rider_id = $1 AND fulfillment_center_id = $2 AND status = 'active'`,
            [riderSpecialId, hub.id]
        );
        if (riderRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Active Rider not found under this hub." });
        }
        const rider = riderRes.rows[0];

        // Find the active route plan stop at this hub
        const stopRes = await client.query(
            `SELECT id, stop_sequence FROM order_route_plan 
             WHERE order_id = $1 AND fulfillment_center_id = $2 AND status = 'arrived'`,
            [orderId, hub.id]
        );
        if (stopRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Package is not shelved or ready for dispatch at this hub." });
        }
        const stop = stopRes.rows[0];

        const orderPaymentRes = await client.query(
        `SELECT 
            o.order_type,
            qr.id AS quotation_request_id
        FROM orders o
        LEFT JOIN quotation_requests qr
            ON qr.order_id = o.id
        WHERE o.id = $1`,
        [orderId]
        );

        if (orderPaymentRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({
                message: "Order not found."
            });
        }

        const orderPayment = orderPaymentRes.rows[0];

        // Only quotation/bulk orders require dispatch-payment verification.
        if (orderPayment.order_type === "quotation") {

            if (!orderPayment.quotation_request_id) {
                await client.query("ROLLBACK");
                return res.status(400).json({
                    message: "Quotation order is missing its quotation reference."
                });
            }

            const dispatchPaymentRes = await client.query(
                `SELECT id, amount, status
                FROM payments
                WHERE quotation_request_id = $1
                AND split_number = 2
                AND status = 'successful'
                ORDER BY created_at DESC
                LIMIT 1`,
                [orderPayment.quotation_request_id]
            );

            if (dispatchPaymentRes.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    message:
                        "Dispatch payment has not been completed. The package cannot be moved to outbound."
                });
            }
        }

        // Update stop status to departed
        await client.query(
            `UPDATE order_route_plan 
             SET status = 'departed', updated_at = NOW()
             WHERE id = $1`,
            [stop.id]
        );

        // Check if there is a next stop sequences in the chain
        const nextStopRes = await client.query(
            `SELECT id FROM order_route_plan 
             WHERE order_id = $1 AND stop_sequence = $2`,
            [orderId, stop.stop_sequence + 1]
        );

        let isNextHubAvailable = false;
        if (nextStopRes.rows.length > 0) {
            isNextHubAvailable = true;
            // Set the next hub's stop status to in_transit
            await client.query(
                `UPDATE order_route_plan 
                 SET status = 'in_transit', updated_at = NOW()
                 WHERE id = $1`,
                [nextStopRes.rows[0].id]
            );
        }

        // Insert into tracking log
        const locationLabel = `${hub.name} (${hub.code})`;
        const transitNote = isNextHubAvailable 
            ? "Handed over to Rider for inter-hub transit"
            : "Handed over to Rider Partner. Out for final client delivery.";

        await client.query(
            `INSERT INTO order_fulfillment_tracking (order_id, fulfillment_center_id, delivery_agent_id, status, note, location_label, stop_sequence)
             VALUES ($1, $2, $3, 'handed_over', $4, $5, $6)`,
            [orderId, hub.id, rider.id, transitNote, locationLabel, stop.stop_sequence]
        );

        // If it was the final hub stop (no more hops), update order status globally to 'shipped'
        if (!isNextHubAvailable) {
            await client.query(
                `UPDATE orders SET status = 'shipped', updated_at = NOW() WHERE id = $1`,
                [orderId]
            );
        }

        await client.query("COMMIT");

        if (rider.push_token) {
            void sendExpoPushNotification({
                to: rider.push_token,
                title: "📦 New Delivery Task Assigned!",
                body: `Package for Order #${orderId} has been handed over to your delivery queue. Tap to open.`,
                data: { orderId, taskType: 'delivery' }
            });
        }

        return res.status(200).json({
            message: "Package successfully scanned and handed over to Rider.",
            data: { orderId, riderSpecialId, isOutForDirectDelivery: !isNextHubAvailable }
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error during dispatch handover:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 7.5 POST /api/delivery/hub/relocate (Manager changes shelving location of a package)
export const postRelocateItemController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId, newShelfLocation } = req.body;

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized. Hub Manager access only." });
    }
    if (!orderId || !newShelfLocation) {
        return res.status(400).json({ message: "Order ID and new shelf location are required." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        // Verify package is currently shelved at this hub
        const stopRes = await pool.query(
            `SELECT id FROM order_route_plan 
             WHERE order_id = $1 AND fulfillment_center_id = $2 AND status = 'arrived'`,
            [orderId, hub.id]
        );
        if (stopRes.rows.length === 0) {
            return res.status(400).json({ message: "Package is not currently shelved at this hub." });
        }

        // Insert new relocation tracking log with received status so WMS inventory queries pick it up
        const locationLabel = `${hub.name} (${hub.code})`;
        const note = `[RELOCATED] Shelved at location: ${newShelfLocation}`;
        await pool.query(
            `INSERT INTO order_fulfillment_tracking (order_id, fulfillment_center_id, status, note, location_label)
             VALUES ($1, $2, 'received', $3, $4)`,
            [orderId, hub.id, note, locationLabel]
        );

        return res.status(200).json({
            message: "Package successfully relocated in warehouse shelves.",
            data: { orderId, newShelfLocation }
        });
    } catch (error) {
        console.error("Error relocating warehouse item:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 8. GET /api/delivery/riders
export const getRidersController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        const query = `
            SELECT da.id, da.special_rider_id, da.contact_phone, da.vehicle_type, da.vehicle_number, 
                   da.status, da.is_online, da.kyc_status, da.current_latitude, da.current_longitude, da.last_located_at,
                   u.name as rider_name, u.email as rider_email, u.is_verified,
                   k.id_doc_type, k.id_doc_number, k.bank_name, k.account_number, k.ifsc_code, k.account_holder_name, k.submitted_at as kyc_submitted_at, k.rejection_reason,
                    COALESCE((
                        SELECT COUNT(DISTINCT sub.order_id)::int 
                        FROM (
                            SELECT oft.order_id 
                            FROM order_fulfillment_tracking oft
                            WHERE oft.delivery_agent_id = da.id 
                              AND oft.status IN ('delivered', 'received', 'handed_over')
                            UNION
                            SELECT orp.order_id 
                            FROM order_route_plan orp
                            WHERE orp.pickup_rider_id = da.id
                        ) sub
                    ), 0) as completed_deliveries_count,
                    COALESCE((
                        SELECT COUNT(DISTINCT sub.order_id)::int 
                        FROM (
                            SELECT oft.order_id, oft.created_at 
                            FROM order_fulfillment_tracking oft
                            WHERE oft.delivery_agent_id = da.id 
                              AND oft.status IN ('delivered', 'received', 'handed_over')
                              AND oft.created_at >= CURRENT_DATE
                            UNION
                            SELECT orp.order_id, orp.updated_at as created_at
                            FROM order_route_plan orp
                            WHERE orp.pickup_rider_id = da.id
                              AND orp.updated_at >= CURRENT_DATE
                        ) sub
                    ), 0) as deliveries_today_count
             FROM delivery_agents da
             JOIN users u ON da.user_id = u.id
             LEFT JOIN delivery_agent_kyc k ON da.id = k.delivery_agent_id
             WHERE da.fulfillment_center_id = $1 AND da.status != 'deleted'
             ORDER BY da.created_at DESC
         `;
        const result = await pool.query(query, [hub.id]);

        return res.status(200).json({
            message: "Riders list retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error fetching riders list:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 8.5 GET /api/delivery/riders/:riderId/deliveries (FC Manager gets specific rider completed deliveries)
export const getSpecificRiderDeliveriesController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { riderId } = req.params;

    if (!user || (user.role !== "fulfillment_center" && user.role !== "admin")) {
        return res.status(403).json({ message: "Unauthorized." });
    }

    try {
        const result = await pool.query(
            `SELECT sub.tracking_id,
                    sub.order_id,
                    sub.order_reference,
                    sub.customer_name,
                    sub.address_line, sub.city, sub.state, sub.pincode,
                    sub.vendor_name, sub.vendor_city, sub.vendor_state,
                    sub.delivered_at,
                    sub.delivery_status,
                    sub.delivery_leg_title,
                    sub.items
             FROM (
                 SELECT oft.id::text as tracking_id,
                        o.id as order_id, 
                        COALESCE(o.order_reference, substring(o.id::text, 1, 8)) as order_reference, 
                        COALESCE(o.customer_name, 'Valued Customer') as customer_name, 
                        o.address_line, o.city, o.state, o.pincode,
                        COALESCE(v.company_name, 'Partner Vendor') as vendor_name,
                        o.vendor_city, o.vendor_state,
                        oft.created_at as delivered_at, 
                        oft.status as delivery_status,
                        CASE 
                            WHEN oft.status = 'received' THEN 'Vendor ➔ Fulfillment Center Hub'
                            ELSE 'Fulfillment Center Hub ➔ Client Dropoff'
                        END as delivery_leg_title,
                        (
                            SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                            FROM order_items oi
                            JOIN products p ON oi.product_id = p.id
                            WHERE oi.order_id = o.id
                        ) as items
                 FROM order_fulfillment_tracking oft
                 JOIN orders o ON oft.order_id = o.id
                 LEFT JOIN vendors v ON o.vendor_id = v.id
                 WHERE oft.delivery_agent_id = $1
                   AND oft.status IN ('delivered', 'received', 'handed_over')

                 UNION ALL

                 SELECT orp.id::text as tracking_id,
                        o.id as order_id,
                        COALESCE(o.order_reference, substring(o.id::text, 1, 8)) as order_reference,
                        COALESCE(o.customer_name, 'Valued Customer') as customer_name,
                        o.address_line, o.city, o.state, o.pincode,
                        COALESCE(v.company_name, 'Partner Vendor') as vendor_name,
                        o.vendor_city, o.vendor_state,
                        COALESCE(orp.actual_arrival, orp.updated_at, orp.created_at) as delivered_at,
                        'received' as delivery_status,
                        'Vendor ➔ Fulfillment Center Hub' as delivery_leg_title,
                        (
                            SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                            FROM order_items oi
                            JOIN products p ON oi.product_id = p.id
                            WHERE oi.order_id = o.id
                        ) as items
                 FROM order_route_plan orp
                 JOIN orders o ON orp.order_id = o.id
                 LEFT JOIN vendors v ON o.vendor_id = v.id
                 WHERE orp.pickup_rider_id = $1
                   AND NOT EXISTS (
                       SELECT 1 FROM order_fulfillment_tracking oft2 
                       WHERE oft2.order_id = o.id AND oft2.delivery_agent_id = $1 AND oft2.status = 'received'
                   )
             ) sub
             ORDER BY sub.delivered_at DESC`,
            [riderId]
        );

        return res.status(200).json({
            message: "Rider completed deliveries retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error fetching specific rider completed deliveries:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 9. POST /api/delivery/riders
export const createRiderController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { name, email, password, contact_phone, vehicle_type, vehicle_number } = req.body;

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized. Managers only." });
    }
    if (!name || !email || !password) {
        return res.status(400).json({ message: "Rider Name, Email, and Password are required." });
    }

    const client = await pool.connect();
    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        await client.query("BEGIN");

        const normalizedEmail = email.trim().toLowerCase();

        // Check if email already registered
        const userCheck = await client.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
        if (userCheck.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ message: "Email is already registered." });
        }

        // Create User account for Rider (automatically verified: is_verified = TRUE)
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRes = await client.query(
            `INSERT INTO users (name, email, password_hash, role, is_active, is_verified)
             VALUES ($1, $2, $3, 'delivery_agent', TRUE, TRUE)
             RETURNING id`,
            [name.trim(), normalizedEmail, hashedPassword]
        );
        const riderUserId = userRes.rows[0].id;

        // Generate special rider code (e.g. RID-PUNE-01)
        const riderCountRes = await client.query(
            `SELECT COUNT(*) FROM delivery_agents WHERE fulfillment_center_id = $1`,
            [hub.id]
        );
        const sequence = parseInt(riderCountRes.rows[0].count, 10) + 1;
        const specialRiderId = `RID-${hub.code}-${sequence.toString().padStart(3, "0")}`;

        // Insert into delivery_agents table
        const riderProfileRes = await client.query(
            `INSERT INTO delivery_agents (user_id, fulfillment_center_id, special_rider_id, contact_phone, vehicle_type, vehicle_number)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, special_rider_id`,
            [riderUserId, hub.id, specialRiderId, contact_phone, vehicle_type, vehicle_number]
        );

        await client.query("COMMIT");

        return res.status(201).json({
            message: "Rider registered successfully",
            data: {
                id: riderProfileRes.rows[0].id,
                specialRiderId: riderProfileRes.rows[0].special_rider_id,
                name,
                email: normalizedEmail,
                is_verified: true
            }
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error creating rider:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 10. PATCH /api/delivery/riders/:riderId
export const patchRiderController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { riderId } = req.params; // delivery_agents.id
    const { contact_phone, vehicle_type, vehicle_number, status, is_verified } = req.body;

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }

    const client = await pool.connect();
    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        await client.query("BEGIN");

        // Verify the rider belongs to this manager's hub
        const riderCheck = await client.query(
            "SELECT user_id FROM delivery_agents WHERE id = $1 AND fulfillment_center_id = $2",
            [riderId, hub.id]
        );
        if (riderCheck.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Rider not found at your hub." });
        }
        const riderUserId = riderCheck.rows[0].user_id;

        // Perform updates on delivery_agents
        await client.query(
            `UPDATE delivery_agents 
             SET contact_phone = COALESCE($1, contact_phone),
                 vehicle_type = COALESCE($2, vehicle_type),
                 vehicle_number = COALESCE($3, vehicle_number),
                 status = COALESCE($4, status),
                 updated_at = NOW()
             WHERE id = $5`,
            [contact_phone, vehicle_type, vehicle_number, status, riderId]
        );

        // If is_verified boolean is passed, update user verification state
        if (is_verified !== undefined) {
            await client.query(
                "UPDATE users SET is_verified = $1 WHERE id = $2",
                [Boolean(is_verified), riderUserId]
            );
        }

        // If status is blocked or deleted, lock the credentials on user account
        if (status === "blocked" || status === "deleted") {
            await client.query(
                "UPDATE users SET is_active = FALSE WHERE id = $1",
                [riderUserId]
            );
        } else if (status === "active") {
            await client.query(
                "UPDATE users SET is_active = TRUE WHERE id = $1",
                [riderUserId]
            );
        }

        await client.query("COMMIT");
        return res.status(200).json({ message: "Rider profile updated successfully." });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error updating rider profile:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 11. PATCH /api/delivery/rider/status (Rider updates online toggle)
export const patchRiderStatusController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { isOnline } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }
    if (typeof isOnline !== "boolean") {
        return res.status(400).json({ message: "isOnline boolean flag is required." });
    }

    try {
        const result = await pool.query(
            `UPDATE delivery_agents 
             SET is_online = $1, updated_at = NOW() 
             WHERE user_id = $2 AND status = 'active'
             RETURNING id, special_rider_id`,
            [isOnline, user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Rider profile is blocked or not found." });
        }

        return res.status(200).json({
            message: `Rider is now ${isOnline ? "Online" : "Offline"}`,
            data: { isOnline, specialRiderId: result.rows[0].special_rider_id }
        });
    } catch (error) {
        console.error("Error updating rider status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 12. GET /api/delivery/rider/tasks (Active deliveries assigned to rider)
export const getRiderTasksController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    try {
        const riderRes = await pool.query(
            "SELECT id, fulfillment_center_id FROM delivery_agents WHERE user_id = $1 AND status = 'active'",
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Active Rider profile not found." });
        }
        const riderId = riderRes.rows[0].id;

        const query = `
            SELECT o.id as order_id, o.order_reference, o.customer_name, o.customer_phone,
                o.address_line, o.city, o.state, o.pincode, o.latitude, o.langitude, o.payment_status, o.order_type,oft.created_at AS assigned_at,
                (
                    SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                    FROM order_items oi
                    JOIN products p ON oi.product_id = p.id
                    WHERE oi.order_id = o.id
                ) as items
            FROM orders o
            JOIN order_fulfillment_tracking oft ON o.id = oft.order_id
            WHERE oft.delivery_agent_id = $1 
            AND oft.status = 'handed_over'
            AND NOT EXISTS (
                SELECT 1 FROM order_fulfillment_tracking oft2 
                WHERE oft2.order_id = o.id AND oft2.status = 'delivered'
            )
            ORDER BY oft.created_at DESC
        `;
        const result = await pool.query(query, [riderId]);

        return res.status(200).json({
            message: "Active delivery tasks retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error fetching rider tasks:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 12.5 GET /api/delivery/rider/completed-deliveries (Rider gets completed drop history)
export const getRiderCompletedDeliveriesController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    try {
        const riderRes = await pool.query(
            "SELECT id FROM delivery_agents WHERE user_id = $1 AND status = 'active'",
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Active Rider profile not found." });
        }
        const riderId = riderRes.rows[0].id;

        const result = await pool.query(
            `SELECT sub.tracking_id,
                    sub.order_id,
                    sub.order_reference,
                    sub.customer_name,
                    sub.address_line, sub.city, sub.state, sub.pincode,
                    sub.vendor_name, sub.vendor_city, sub.vendor_state,
                    sub.delivered_at,
                    sub.delivery_status,
                    sub.delivery_leg_title,
                    sub.items
             FROM (
                 SELECT oft.id::text as tracking_id,
                        o.id as order_id, 
                        COALESCE(o.order_reference, substring(o.id::text, 1, 8)) as order_reference, 
                        COALESCE(o.customer_name, 'Valued Customer') as customer_name, 
                        o.address_line, o.city, o.state, o.pincode,
                        COALESCE(v.company_name, 'Partner Vendor') as vendor_name,
                        o.vendor_city, o.vendor_state,
                        oft.created_at as delivered_at, 
                        oft.status as delivery_status,
                        CASE 
                            WHEN oft.status = 'received' THEN 'Vendor ➔ Fulfillment Center Hub'
                            ELSE 'Fulfillment Center Hub ➔ Client Dropoff'
                        END as delivery_leg_title,
                        (
                            SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                            FROM order_items oi
                            JOIN products p ON oi.product_id = p.id
                            WHERE oi.order_id = o.id
                        ) as items
                 FROM order_fulfillment_tracking oft
                 JOIN orders o ON oft.order_id = o.id
                 LEFT JOIN vendors v ON o.vendor_id = v.id
                 WHERE oft.delivery_agent_id = $1
                   AND oft.status IN ('delivered', 'received', 'handed_over')

                 UNION ALL

                 SELECT orp.id::text as tracking_id,
                        o.id as order_id,
                        COALESCE(o.order_reference, substring(o.id::text, 1, 8)) as order_reference,
                        COALESCE(o.customer_name, 'Valued Customer') as customer_name,
                        o.address_line, o.city, o.state, o.pincode,
                        COALESCE(v.company_name, 'Partner Vendor') as vendor_name,
                        o.vendor_city, o.vendor_state,
                        COALESCE(orp.actual_arrival, orp.updated_at, orp.created_at) as delivered_at,
                        'received' as delivery_status,
                        'Vendor ➔ Fulfillment Center Hub' as delivery_leg_title,
                        (
                            SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                            FROM order_items oi
                            JOIN products p ON oi.product_id = p.id
                            WHERE oi.order_id = o.id
                        ) as items
                 FROM order_route_plan orp
                 JOIN orders o ON orp.order_id = o.id
                 LEFT JOIN vendors v ON o.vendor_id = v.id
                 WHERE orp.pickup_rider_id = $1
                   AND NOT EXISTS (
                       SELECT 1 FROM order_fulfillment_tracking oft2 
                       WHERE oft2.order_id = o.id AND oft2.delivery_agent_id = $1 AND oft2.status = 'received'
                   )
             ) sub
             ORDER BY sub.delivered_at DESC`,
            [riderId]
        );

        // Compute timeframe stats
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - 7);

        let todayCount = 0;
        let weekCount = 0;
        let totalUnits = 0;

        result.rows.forEach((row: any) => {
            const deliveredDate = new Date(row.delivered_at);
            if (deliveredDate >= startOfToday) todayCount++;
            if (deliveredDate >= startOfWeek) weekCount++;

            if (Array.isArray(row.items)) {
                row.items.forEach((item: any) => {
                    totalUnits += Number(item.quantity || 0);
                });
            }
        });

        return res.status(200).json({
            message: "Completed deliveries history retrieved",
            stats: {
                totalCount: result.rows.length,
                todayCount,
                weekCount,
                totalUnits
            },
            data: result.rows
        });
    } catch (error) {
        console.error("Error fetching completed deliveries history:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 13. POST /api/delivery/rider/deliver (Rider completes a B2B delivery)
export const postRiderDeliverController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId, codPaymentMethod } = req.body; // codPaymentMethod: 'cash' | 'upi' — only relevant if order was COD

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }
    if (!orderId) {
        return res.status(400).json({ message: "Order ID is required." });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const riderRes = await client.query(
            "SELECT id FROM delivery_agents WHERE user_id = $1 AND status = 'active'",
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Active Rider profile not found." });
        }
        const riderId = riderRes.rows[0].id;

        const assignmentRes = await client.query(
            `SELECT id FROM order_fulfillment_tracking 
             WHERE order_id = $1 AND delivery_agent_id = $2 AND status = 'handed_over'`,
            [orderId, riderId]
        );
        if (assignmentRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "This order is not assigned to you for delivery." });
        }

        // Check current payment status before updating, so we know whether this was COD
        const orderRes = await client.query(
            `SELECT payment_status FROM orders WHERE id = $1`,
            [orderId]
        );
        const wasCod = orderRes.rows[0]?.payment_status === 'cod_pending';
        const collectionMethod = wasCod && codPaymentMethod === 'upi' ? 'upi' : 'cash';

        // Update order status to delivered — mark COD payment collected in the same statement
        await client.query(
            `UPDATE orders 
             SET status = 'delivered', 
                 updated_at = NOW(),
                 payment_status = CASE WHEN payment_status = 'cod_pending' THEN 'paid' ELSE payment_status END
             WHERE id = $1`,
            [orderId]
        );

        // Insert delivered tracking log — note COD collection method if applicable
        const trackingNote = wasCod
            ? `Order successfully delivered to customer. COD payment collected via ${collectionMethod === 'upi' ? 'UPI/QR' : 'cash'}.`
            : 'Order successfully delivered to customer.';
        await client.query(
            `INSERT INTO order_fulfillment_tracking (order_id, delivery_agent_id, status, note, location_label)
             VALUES ($1, $2, 'delivered', $3, 'Customer Location')`,
            [orderId, riderId, trackingNote]
        );

        await client.query("COMMIT");
        return res.status(200).json({
            message: wasCod
                ? `Order marked as delivered. COD payment (${collectionMethod}) collected.`
                : "Order successfully marked as delivered.",
            data: { orderId, codPaymentCollected: wasCod, collectionMethod: wasCod ? collectionMethod : null }
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error completing B2B delivery:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 14. POST /api/delivery/rider/fail-delivery (Rider reports delivery issue / failed delivery)
export const postRiderFailDeliveryController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId, reason } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }
    if (!orderId || !reason) {
        return res.status(400).json({ message: "Order ID and failure reason are required." });
    }

    const client = pool;
    const tx = await client.connect();
    try {
        await tx.query("BEGIN");

        // Resolve rider profile
        const riderRes = await tx.query(
            "SELECT id, fulfillment_center_id FROM delivery_agents WHERE user_id = $1 AND status = 'active'",
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            await tx.query("ROLLBACK");
            return res.status(404).json({ message: "Active Rider profile not found." });
        }
        const rider = riderRes.rows[0];

        // Verify package is indeed assigned to this rider
        const assignmentRes = await tx.query(
            `SELECT id FROM order_fulfillment_tracking 
             WHERE order_id = $1 AND delivery_agent_id = $2 AND status = 'handed_over'
             AND NOT EXISTS (
                 SELECT 1 FROM order_fulfillment_tracking oft2 
                 WHERE oft2.order_id = $1 AND oft2.status = 'delivered'
             )`,
            [orderId, rider.id]
        );
        if (assignmentRes.rows.length === 0) {
            await tx.query("ROLLBACK");
            return res.status(400).json({ message: "This order is not actively assigned to you." });
        }

        // 1. Insert failed delivery tracking event
        const note = `[DELIVERY_FAILED] Reason: ${reason}`;
        await tx.query(
            `INSERT INTO order_fulfillment_tracking (order_id, fulfillment_center_id, delivery_agent_id, status, note, location_label)
             VALUES ($1, $2, $3, 'processing', $4, 'Customer Location')`,
            [orderId, rider.fulfillment_center_id, rider.id, note]
        );

        // 2. Revert order status globally to 'processing'
        await tx.query(
            `UPDATE orders SET status = 'processing', updated_at = NOW() WHERE id = $1`,
            [orderId]
        );

        // 3. Set the active stop status of the fulfillment center back to 'in_transit' so it gets returned and shelved
        await tx.query(
            `UPDATE order_route_plan 
             SET status = 'in_transit', actual_arrival = NULL, updated_at = NOW() 
             WHERE order_id = $1 AND fulfillment_center_id = $2`,
            [orderId, rider.fulfillment_center_id]
        );

        await tx.query("COMMIT");
        return res.status(200).json({
            message: "Delivery marked as failed. Return package to hub.",
            data: { orderId, reason }
        });
    } catch (error) {
        await tx.query("ROLLBACK");
        console.error("Error failing delivery:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        tx.release();
    }
};

// 15. GET /api/delivery/rider/dashboard-stats (Rider gets dashboard metrics summary)
export const getRiderDashboardStatsController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    try {
        // Fetch Rider Profile & User info
        const riderRes = await pool.query(
            `SELECT da.id, da.special_rider_id, da.contact_phone, da.vehicle_type, da.vehicle_number, da.is_online, da.status, da.kyc_status, u.is_verified
             FROM delivery_agents da
             JOIN users u ON da.user_id = u.id
             WHERE da.user_id = $1`,
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Rider profile not found." });
        }
        const rider = riderRes.rows[0];

        // Count completed deliveries today
        const completedRes = await pool.query(
            `SELECT COUNT(DISTINCT order_id) FROM order_fulfillment_tracking
             WHERE delivery_agent_id = $1 AND status = 'delivered' 
             AND created_at >= CURRENT_DATE`,
            [rider.id]
        );

        // Count pending assigned tasks
        const pendingRes = await pool.query(
            `SELECT COUNT(DISTINCT oft.order_id)
             FROM order_fulfillment_tracking oft
             WHERE oft.delivery_agent_id = $1 
               AND oft.status = 'handed_over'
               AND NOT EXISTS (
                   SELECT 1 FROM order_fulfillment_tracking oft2 
                   WHERE oft2.order_id = oft.order_id AND oft2.status = 'delivered'
               )`,
            [rider.id]
        );

        const completedTripsToday = parseInt(completedRes.rows[0].count, 10) || 0;
        const pendingTasksCount = parseInt(pendingRes.rows[0].count, 10) || 0;

        return res.status(200).json({
            message: "Rider dashboard stats retrieved successfully",
            data: {
                is_verified: rider.is_verified,
                riderInfo: {
                    id: rider.id,
                    specialRiderId: rider.special_rider_id,
                    contactPhone: rider.contact_phone,
                    vehicleType: rider.vehicle_type,
                    vehicleNumber: rider.vehicle_number,
                    isOnline: rider.is_online,
                    status: rider.status,
                    kyc_status: rider.kyc_status || 'pending'
                },
                completedTripsToday,
                pendingTasksCount
            }
        });
    } catch (error) {
        console.error("Error retrieving rider dashboard stats:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// VENDOR PICKUP FLOW — FC sends rider to vendor to collect package
// ══════════════════════════════════════════════════════════════════════════════

// 15. GET /api/delivery/hub/pending-pickups
// FC Manager sees all orders where a vendor has accepted but the package
// hasn't been collected yet. Shows vendor details, not customer details.
export const getPendingPickupsController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized. Hub Manager access only." });
    }

    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Fulfillment center profile not found." });
        }

        const query = `
            SELECT orp.id as stop_id, orp.order_id, orp.stop_sequence, orp.status as pickup_status,
                   orp.pickup_rider_id, orp.estimated_arrival,
                   o.order_reference, o.total_amount, o.customer_name,
                   o.vendor_city, o.vendor_state, o.vendor_latitude, o.vendor_longitude,
                   v.company_name as vendor_name,
                   a.address as vendor_address, a.city as vendor_address_city, 
                   a.state as vendor_address_state, a.pincode as vendor_pincode,
                   a.latitude as vendor_lat, a.longitude as vendor_lng,
                   u_vendor.email as vendor_email,
                   (SELECT phone FROM client WHERE user_id = v.user_id LIMIT 1) as vendor_phone,
                   da.special_rider_id as assigned_rider_name,
                   (
                       SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                       FROM order_items oi
                       JOIN products p ON oi.product_id = p.id
                       WHERE oi.order_id = orp.order_id
                   ) as items
            FROM order_route_plan orp
            JOIN orders o ON orp.order_id = o.id
            JOIN vendors v ON o.vendor_id = v.id
            JOIN users u_vendor ON v.user_id = u_vendor.id
            LEFT JOIN addresses a ON a.user_id = v.user_id
            LEFT JOIN delivery_agents da ON orp.pickup_rider_id = da.id
            WHERE orp.fulfillment_center_id = $1 
              AND orp.status IN ('pickup_pending', 'pickup_assigned')
            ORDER BY orp.created_at ASC
        `;
        const result = await pool.query(query, [hub.id]);

        return res.status(200).json({
            message: "Pending pickups retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error retrieving pending pickups:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 16. POST /api/delivery/hub/assign-pickup
// FC Manager assigns a rider to go pick up the package from the vendor location.
export const postAssignPickupController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId, riderSpecialId } = req.body;

    if (!user || user.role !== "fulfillment_center") {
        return res.status(403).json({ message: "Unauthorized." });
    }
    if (!orderId || !riderSpecialId) {
        return res.status(400).json({ message: "Order ID and Rider Special ID are required." });
    }

    const client = await pool.connect();
    try {
        const hub = await resolveHubDetails(user.userId);
        if (!hub) {
            return res.status(404).json({ message: "Hub not found." });
        }

        await client.query("BEGIN");

        // Verify the rider exists and is active under this FC
        const riderRes = await client.query(
            `SELECT id, user_id, push_token FROM delivery_agents 
             WHERE special_rider_id = $1 AND fulfillment_center_id = $2 AND status = 'active'`,
            [riderSpecialId, hub.id]
        );
        if (riderRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Active Rider not found under this hub." });
        }
        const rider = riderRes.rows[0];

        // Find the pickup_pending stop for this order at this FC
        const stopRes = await client.query(
            `SELECT id, stop_sequence FROM order_route_plan 
             WHERE order_id = $1 AND fulfillment_center_id = $2 AND status = 'pickup_pending'`,
            [orderId, hub.id]
        );
        if (stopRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "No pending pickup found for this order at this hub." });
        }

        // Update stop to pickup_assigned and record the pickup rider
        await client.query(
            `UPDATE order_route_plan 
             SET status = 'pickup_assigned', pickup_rider_id = $1, updated_at = NOW()
             WHERE id = $2`,
            [rider.id, stopRes.rows[0].id]
        );

        // Insert tracking entry
        const locationLabel = `${hub.name} (${hub.code})`;
        await client.query(
            `INSERT INTO order_fulfillment_tracking 
             (order_id, fulfillment_center_id, delivery_agent_id, status, note, location_label, stop_sequence)
             VALUES ($1, $2, $3, 'dispatched', $4, $5, $6)`,
            [orderId, hub.id, rider.id, 
             `Rider ${riderSpecialId} assigned for vendor pickup`, 
             locationLabel, stopRes.rows[0].stop_sequence]
        );

        await client.query("COMMIT");

        if (rider.push_token) {
            void sendExpoPushNotification({
                to: rider.push_token,
                title: "🚚 Vendor Pickup Job Assigned!",
                body: `You have been assigned to collect Order #${orderId} from vendor. Tap to open pickup route.`,
                data: { orderId, taskType: 'pickup' }
            });
        }

        return res.status(200).json({
            message: "Rider assigned for vendor pickup successfully.",
            data: { orderId, riderSpecialId }
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error assigning pickup rider:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 17. POST /api/delivery/rider/confirm-pickup
// Rider confirms they have physically collected the package from the vendor.
// This marks the order as "shipped" and sets the route stop to "in_transit".
export const postRiderConfirmPickupController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }
    if (!orderId) {
        return res.status(400).json({ message: "Order ID is required." });
    }

    const client = await pool.connect();
    try {
        // Resolve rider profile
        const riderRes = await client.query(
            "SELECT id, fulfillment_center_id FROM delivery_agents WHERE user_id = $1 AND status = 'active'",
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Active Rider profile not found." });
        }
        const rider = riderRes.rows[0];

        await client.query("BEGIN");

        // Verify this rider was assigned to this pickup
        const stopRes = await client.query(
            `SELECT id, stop_sequence, fulfillment_center_id FROM order_route_plan 
             WHERE order_id = $1 AND pickup_rider_id = $2 AND status = 'pickup_assigned'`,
            [orderId, rider.id]
        );
        if (stopRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "You are not assigned to pick up this order, or it has already been picked up." });
        }
        const stop = stopRes.rows[0];

        // Set the route stop to in_transit (package is now traveling to FC)
        await client.query(
            `UPDATE order_route_plan 
             SET status = 'in_transit', updated_at = NOW()
             WHERE id = $1`,
            [stop.id]
        );

        // Update order status to shipped (picked up from vendor)
        await client.query(
            `UPDATE orders SET status = 'shipped', updated_at = NOW() WHERE id = $1`,
            [orderId]
        );

        // Insert order status history
        await client.query(
            `INSERT INTO order_status_history (order_id, status, note, created_at)
             VALUES ($1, 'shipped', 'Package picked up from vendor by delivery rider', CURRENT_TIMESTAMP)`,
            [orderId]
        );

        // Insert fulfillment tracking entry
        const hubRes = await client.query(
            `SELECT name, code FROM fulfillment_centers WHERE id = $1`,
            [stop.fulfillment_center_id]
        );
        const hubInfo = hubRes.rows[0];
        const locationLabel = hubInfo ? `${hubInfo.name} (${hubInfo.code})` : 'Hub';

        await client.query(
            `INSERT INTO order_fulfillment_tracking 
             (order_id, fulfillment_center_id, delivery_agent_id, status, note, location_label, stop_sequence)
             VALUES ($1, $2, $3, 'shipped', $4, $5, $6)`,
            [orderId, stop.fulfillment_center_id, rider.id,
             'Package picked up from vendor \u2014 in transit to fulfillment center',
             locationLabel, stop.stop_sequence]
        );

        await client.query("COMMIT");
        return res.status(200).json({
            message: "Pickup confirmed! Package is now in transit to the fulfillment center.",
            data: { orderId, status: 'shipped' }
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error confirming pickup:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// 18. GET /api/delivery/rider/pickup-tasks
// Rider sees all orders they've been assigned to pick up from vendors.
export const getRiderPickupTasksController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    try {
        const riderRes = await pool.query(
            "SELECT id FROM delivery_agents WHERE user_id = $1 AND status = 'active'",
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Active Rider profile not found." });
        }
        const riderId = riderRes.rows[0].id;

        const query = `
            SELECT orp.id as stop_id, orp.order_id, orp.stop_sequence, orp.status,orp.created_at AS assigned_at,
                   o.order_reference, o.customer_name, o.total_amount,
                   v.company_name as vendor_name,
                   a.address as vendor_address, a.city as vendor_city, 
                   a.state as vendor_state, a.pincode as vendor_pincode,
                   a.latitude as vendor_lat, a.longitude as vendor_lng,
                   fc.name as fc_name,
                   fca.address as fc_address, fca.city as fc_city,
                   fca.state as fc_state, fca.pincode as fc_pincode,
                   fca.latitude as fc_lat, fca.longitude as fc_lng,
                   (
                       SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                       FROM order_items oi
                       JOIN products p ON oi.product_id = p.id
                       WHERE oi.order_id = orp.order_id
                   ) as items
            FROM order_route_plan orp
            JOIN orders o ON orp.order_id = o.id
            JOIN vendors v ON o.vendor_id = v.id
            LEFT JOIN addresses a ON a.user_id = v.user_id
            LEFT JOIN fulfillment_centers fc ON orp.fulfillment_center_id = fc.id
            LEFT JOIN addresses fca ON fca.user_id = fc.user_id
            WHERE orp.pickup_rider_id = $1 AND orp.status IN ('pickup_assigned', 'in_transit')
            ORDER BY orp.updated_at ASC
        `;
        const result = await pool.query(query, [riderId]);

        return res.status(200).json({
            message: "Pickup tasks retrieved",
            data: result.rows
        });
    } catch (error) {
        console.error("Error retrieving rider pickup tasks:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 16. PATCH /api/delivery/rider/location (Rider updates current coordinates)
export const patchRiderLocationController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { latitude, longitude } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }
    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ message: "latitude and longitude are required." });
    }

    try {
        const parsedLat = parseFloat(latitude);
        const parsedLng = parseFloat(longitude);

        if (isNaN(parsedLat) || isNaN(parsedLng)) {
            return res.status(400).json({ message: "Invalid latitude or longitude numbers." });
        }

        const result = await pool.query(
            `UPDATE delivery_agents 
             SET current_latitude = $1, current_longitude = $2, last_located_at = NOW(), updated_at = NOW() 
             WHERE user_id = $3 AND status = 'active'
             RETURNING id`,
            [parsedLat, parsedLng, user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Rider profile not found or inactive." });
        }

        return res.status(200).json({
            message: "Rider location updated successfully",
            data: { latitude: parsedLat, longitude: parsedLng }
        });
    } catch (error) {
        console.error("Error updating rider location:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 17. GET /api/delivery/riders/:riderId/live (Admin/FC gets active status and job information)
export const getRiderLiveDetailsController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { riderId } = req.params;

    if (!user || (user.role !== "fulfillment_center" && user.role !== "admin" && user.role !== "super_admin")) {
        return res.status(403).json({ message: "Unauthorized. Access restricted." });
    }

    try {
        // 1. Fetch Rider details
        const riderRes = await pool.query(
            `SELECT da.id, da.special_rider_id, da.contact_phone, da.vehicle_type, da.vehicle_number, 
                    da.status, da.is_online, da.current_latitude, da.current_longitude, da.last_located_at,
                    u.name as rider_name, u.email as rider_email
             FROM delivery_agents da
             JOIN users u ON da.user_id = u.id
             WHERE da.id = $1`,
            [riderId]
        );

        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Rider not found." });
        }

        const rider = riderRes.rows[0];

        // 2. Fetch Active Drop-off Job
        const activeDeliveryRes = await pool.query(
            `SELECT o.id as order_id, o.order_reference, o.customer_name, o.customer_phone,
                    o.address_line, o.city, o.state, o.pincode, o.latitude as destination_lat, o.langitude as destination_lng,
                    (
                        SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                        FROM order_items oi
                        JOIN products p ON oi.product_id = p.id
                        WHERE oi.order_id = o.id
                    ) as items
             FROM orders o
             JOIN order_fulfillment_tracking oft ON o.id = oft.order_id
             WHERE oft.delivery_agent_id = $1 
               AND oft.status = 'handed_over'
               AND NOT EXISTS (
                   SELECT 1 FROM order_fulfillment_tracking oft2 
                   WHERE oft2.order_id = o.id AND oft2.status = 'delivered'
               )
             LIMIT 1`,
            [riderId]
        );

        let activeJob = null;
        if (activeDeliveryRes.rows.length > 0) {
            const job = activeDeliveryRes.rows[0];
            activeJob = {
                type: 'delivery',
                order_id: job.order_id,
                order_reference: job.order_reference,
                destination_name: job.customer_name,
                destination_phone: job.customer_phone,
                destination_address: `${job.address_line || ''}, ${job.city || ''}, ${job.state || ''} - ${job.pincode || ''}`,
                destination_lat: job.destination_lat,
                destination_lng: job.destination_lng,
                items: job.items
            };
        } else {
            // 3. Fetch Active Pickup Job (if no active delivery job)
            const activePickupRes = await pool.query(
                `SELECT orp.id as stop_id, orp.order_id,
                        o.order_reference, o.customer_name,
                        v.company_name as vendor_name,
                        (SELECT phone FROM client WHERE user_id = v.user_id LIMIT 1) as vendor_phone,
                        a.address as vendor_address, a.city as vendor_city, 
                        a.state as vendor_state, a.pincode as vendor_pincode,
                        a.latitude as vendor_lat, a.longitude as vendor_lng,
                        (
                            SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                            FROM order_items oi
                            JOIN products p ON oi.product_id = p.id
                            WHERE oi.order_id = orp.order_id
                        ) as items
                 FROM order_route_plan orp
                 JOIN orders o ON orp.order_id = o.id
                 JOIN vendors v ON o.vendor_id = v.id
                 LEFT JOIN addresses a ON a.user_id = v.user_id
                 WHERE orp.pickup_rider_id = $1 AND orp.status = 'pickup_assigned'
                 LIMIT 1`,
                [riderId]
            );
            if (activePickupRes.rows.length > 0) {
                const job = activePickupRes.rows[0];
                activeJob = {
                    type: 'pickup',
                    order_id: job.order_id,
                    order_reference: job.order_reference,
                    destination_name: job.vendor_name,
                    destination_phone: job.vendor_phone,
                    destination_address: `${job.vendor_address || ''}, ${job.vendor_city || ''}, ${job.vendor_state || ''} - ${job.vendor_pincode || ''}`,
                    destination_lat: job.vendor_lat,
                    destination_lng: job.vendor_lng,
                    items: job.items
                };
            }
        }

        return res.status(200).json({
            message: "Rider live details retrieved",
            data: {
                rider,
                activeJob
            }
        });
    } catch (error) {
        console.error("Error retrieving rider live details:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 18. POST /api/delivery/verify-pickup (Verify vendor pickup via OTP or QR)
export const verifyPickupController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    const { orderId, code } = req.body;
    console.log("[verifyPickup] Incoming verification request:", { orderId, code });
    if (!orderId || !code) {
        return res.status(400).json({ message: "Order ID and verification code/QR are required." });
    }

    try {
        // Query to check if the code matches the order's pickup details
        const orderQ = await pool.query(
            `SELECT id, order_reference 
             FROM orders 
             WHERE id = $1 AND (pickup_otp = $2 OR pickup_qr_token = $3)`,
            [orderId, String(code).trim(), String(code).trim()]
        );

        if (orderQ.rows.length === 0) {
            return res.status(400).json({ message: "Invalid verification code or QR code scanned." });
        }

        const order = orderQ.rows[0];

        // Begin verification updates
        await pool.query("BEGIN");

        // 1. Update order route plan first sequence stop status to 'in_transit'
        await pool.query(
            `UPDATE order_route_plan 
             SET status = 'in_transit', actual_arrival = NOW(), updated_at = NOW()
             WHERE order_id = $1 AND status = 'pickup_assigned'`,
            [orderId]
        );

        // 2. Add tracking entry
        await pool.query(
            `INSERT INTO order_fulfillment_tracking (order_id, status, note, created_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [orderId, 'handed_over', 'Package collected from vendor by delivery partner.']
        );

        // 3. Clear verification tokens from order
        await pool.query(
            `UPDATE orders 
             SET pickup_otp = NULL, pickup_qr_token = NULL 
             WHERE id = $1`,
            [orderId]
        );

        // 4. Auto-credit ₹40 vendor pickup earning entry into rider_earnings
        const riderRes = await pool.query(`SELECT id FROM delivery_agents WHERE user_id = $1`, [user.userId]);
        if (riderRes.rows.length > 0) {
            const riderId = riderRes.rows[0].id;
            await pool.query(
                `INSERT INTO rider_earnings (delivery_agent_id, order_id, order_reference, leg_type, amount, status)
                 VALUES ($1, $2, $3, 'vendor_pickup', 40.00, 'credited')`,
                [riderId, orderId, order.order_reference]
            );
        }

        await pool.query("COMMIT");

        return res.status(200).json({
            message: "Pickup verified successfully! Status updated to in-transit.",
            data: {
                orderId,
                orderReference: order.order_reference
            }
        });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Error verifying order pickup:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 19. POST /api/delivery/verify-delivery (Verify customer delivery via OTP or QR)
// 19. POST /api/delivery/verify-delivery
// Verify customer delivery via OTP / QR.
// Payment and delivery completion are kept as separate steps.
export const verifyDeliveryController = async (
    req: Request,
    res: Response
): Promise<Response> => {
    const user = (req as any).user;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({
            message: "Unauthorized. Delivery agents only.",
        });
    }

    const { orderId, code, codPaymentMethod } = req.body;

    console.log("[verifyDelivery] Incoming verification request:", {
        orderId,
        code,
        codPaymentMethod,
    });

    if (!orderId || !code) {
        return res.status(400).json({
            message: "Order ID and verification code/QR are required.",
        });
    }

    const client = await pool.connect();

    try {
        // ---------------------------------------------------------
        // 1. Verify OTP/QR + rider assignment
        // ---------------------------------------------------------
        const orderQ = await client.query(
            `
            SELECT
                o.id,
                o.order_reference,
                o.payment_status,
                o.order_type,
                da.id AS delivery_agent_id
            FROM orders o
            JOIN order_fulfillment_tracking oft
                ON oft.order_id = o.id
            JOIN delivery_agents da
                ON da.id = oft.delivery_agent_id
            WHERE o.id = $1
              AND da.user_id = $2
              AND da.status = 'active'
              AND oft.status = 'handed_over'
              AND (o.delivery_otp = $3 OR o.delivery_qr_token = $3)
              AND NOT EXISTS (
                  SELECT 1
                  FROM order_fulfillment_tracking oft2
                  WHERE oft2.order_id = o.id
                    AND oft2.status = 'delivered'
              )
            ORDER BY oft.created_at DESC
            LIMIT 1
            `,
            [
                orderId,
                user.userId,
                String(code).trim(),
            ]
        );

        if (orderQ.rows.length === 0) {
            return res.status(400).json({
                message:
                    "Invalid verification code, order assignment, or delivery already completed.",
            });
        }

        const order = orderQ.rows[0];

        // ---------------------------------------------------------
        // 2. Determine whether money is still due at delivery
        // ---------------------------------------------------------
        const isDirectCod =
            order.order_type !== "quotation" &&
            order.payment_status === "cod_pending";

        const isQuotationFinalPaymentDue =
            order.order_type === "quotation" &&
            order.payment_status === "partially_paid";

        const paymentCollectionRequired =
            isDirectCod || isQuotationFinalPaymentDue;

        const collectionMethod =
            paymentCollectionRequired && codPaymentMethod === "upi"
                ? "upi"
                : "cash";

        // ---------------------------------------------------------
        // 3. If UPI was selected while money is due,
        //    verify the correct payment record
        // ---------------------------------------------------------
        let matchedPaymentRecordId: string | null = null;
        let matchedRazorpayPaymentId: string | null = null;

        if (paymentCollectionRequired && collectionMethod === "upi") {
            let paymentQ;

            // -----------------------------------------------------
            // Direct COD -> UPI
            // -----------------------------------------------------
            if (isDirectCod) {
                paymentQ = await client.query(
                    `
                    SELECT
                        id,
                        razorpay_order_id,
                        razorpay_payment_id,
                        status
                    FROM payments
                    WHERE $1 = ANY(order_ids)
                      AND quotation_request_id IS NULL
                      AND payment_method = 'upi_qr'
                      AND status IN ('pending', 'successful')
                    ORDER BY
                        CASE WHEN status = 'successful' THEN 0 ELSE 1 END,
                        created_at DESC
                    LIMIT 1
                    `,
                    [orderId]
                );
            }

            // -----------------------------------------------------
            // Quotation final delivery -> split #3 UPI
            // -----------------------------------------------------
            else {
                paymentQ = await client.query(
                    `
                    SELECT
                        p.id,
                        p.razorpay_order_id,
                        p.razorpay_payment_id,
                        p.status
                    FROM payments p
                    JOIN quotation_requests qr
                        ON qr.id = p.quotation_request_id
                    WHERE $1 = ANY(p.order_ids)
                      AND qr.order_id = $1
                      AND p.split_number = 3
                      AND p.payment_method = 'upi_qr'
                      AND p.status IN ('pending', 'successful')
                    ORDER BY
                        CASE WHEN p.status = 'successful' THEN 0 ELSE 1 END,
                        p.created_at DESC
                    LIMIT 1
                    `,
                    [orderId]
                );
            }

            if (paymentQ.rows.length === 0) {
                return res.status(400).json({
                    message:
                        "No UPI payment was initiated for this order. Generate a QR code first.",
                });
            }

            const payment = paymentQ.rows[0];

            // Already confirmed in DB -> do not call Razorpay again
            if (payment.status === "successful") {
                matchedPaymentRecordId = payment.id;
                matchedRazorpayPaymentId =
                    payment.razorpay_payment_id || null;
            }

            // Still pending -> verify with Razorpay
            else {
                if (!payment.razorpay_order_id) {
                    return res.status(400).json({
                        message:
                            "UPI payment record is missing its Razorpay payment link.",
                    });
                }

                const plink: any =
                    await (razorpay as any).paymentLink.fetch(
                        payment.razorpay_order_id
                    );

                if (plink.status !== "paid") {
                    return res.status(400).json({
                        message:
                            "UPI payment has not been received yet. Wait for the customer to complete payment.",
                    });
                }

                const capturedPayment =
                    (plink.payments || []).find(
                        (p: any) => p.status === "captured"
                    ) ||
                    (plink.payments || [])[0];

                matchedPaymentRecordId = payment.id;
                matchedRazorpayPaymentId =
                    capturedPayment?.payment_id || null;
            }
        }

        // ---------------------------------------------------------
        // 4. Begin transaction
        // ---------------------------------------------------------
        await client.query("BEGIN");

        // ---------------------------------------------------------
        // 5. Mark UPI payment successful if needed
        // ---------------------------------------------------------
        if (matchedPaymentRecordId) {
            await client.query(
                `
                UPDATE payments
                SET
                    status = 'successful',
                    razorpay_payment_id = COALESCE($1, razorpay_payment_id),
                    updated_at = NOW()
                WHERE id = $2
                  AND status = 'pending'
                `,
                [
                    matchedRazorpayPaymentId,
                    matchedPaymentRecordId,
                ]
            );
        }

        // ---------------------------------------------------------
        // 6. Complete delivery
        //
        // For:
        // direct COD cash        -> cod_pending -> paid
        // quotation final cash   -> partially_paid -> paid
        // UPI already paid       -> remains paid
        // prepaid orders         -> remains paid
        // ---------------------------------------------------------
        await client.query(
            `
            UPDATE orders
            SET
                status = 'delivered',
                payment_status = CASE
                    WHEN payment_status IN ('cod_pending', 'partially_paid')
                        THEN 'paid'
                    ELSE payment_status
                END,
                updated_at = NOW()
            WHERE id = $1
            `,
            [orderId]
        );

        // ---------------------------------------------------------
        // 7. Delivery history
        // ---------------------------------------------------------
        let historyNote = "Order delivered successfully to customer.";

        if (paymentCollectionRequired) {
            historyNote =
                collectionMethod === "upi"
                    ? "Order delivered successfully to customer. Payment collected via UPI (Razorpay QR, verified)."
                    : "Order delivered successfully to customer. Payment collected via cash.";
        }

        await client.query(
            `
            INSERT INTO order_status_history (
                order_id,
                status,
                note,
                created_at
            )
            VALUES (
                $1,
                'delivered',
                $2,
                CURRENT_TIMESTAMP
            )
            `,
            [orderId, historyNote]
        );

        // ---------------------------------------------------------
        // 8. Fulfillment tracking
        // ---------------------------------------------------------
        await client.query(
            `
            INSERT INTO order_fulfillment_tracking (
                order_id,
                delivery_agent_id,
                status,
                note,
                location_label,
                created_at
            )
            VALUES (
                $1,
                $2,
                'delivered',
                $3,
                'Customer Location',
                CURRENT_TIMESTAMP
            )
            `,
            [
                orderId,
                order.delivery_agent_id,
                historyNote,
            ]
        );

        // ---------------------------------------------------------
        // 9. Route stop
        // ---------------------------------------------------------
        await client.query(
            `
            UPDATE order_route_plan
            SET
                status = 'departed',
                actual_arrival = NOW(),
                updated_at = NOW()
            WHERE order_id = $1
            `,
            [orderId]
        );

        // ---------------------------------------------------------
        // 10. Clear customer verification tokens
        // ---------------------------------------------------------
        await client.query(
            `
            UPDATE orders
            SET
                delivery_otp = NULL,
                delivery_qr_token = NULL
            WHERE id = $1
            `,
            [orderId]
        );

        // ---------------------------------------------------------
        // 11. Rider earnings
        // ---------------------------------------------------------
        const riderRes = await client.query(
            `
            SELECT id
            FROM delivery_agents
            WHERE user_id = $1
            `,
            [user.userId]
        );

        if (riderRes.rows.length > 0) {
            const riderId = riderRes.rows[0].id;

            await client.query(
                `
                INSERT INTO rider_earnings (
                    delivery_agent_id,
                    order_id,
                    order_reference,
                    leg_type,
                    amount,
                    status
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    'client_dropoff',
                    50.00,
                    'credited'
                )
                `,
                [
                    riderId,
                    orderId,
                    order.order_reference,
                ]
            );
        }

        await client.query("COMMIT");

        return res.status(200).json({
            message: paymentCollectionRequired
                ? `Delivery verified! ${
                      collectionMethod === "upi"
                          ? "UPI payment"
                          : "Cash payment"
                  } confirmed and order marked as delivered.`
                : "Delivery verified successfully! Order marked as delivered.",
            data: {
                orderId,
                orderReference: order.order_reference,
                paymentCollected: paymentCollectionRequired,
                collectionMethod: paymentCollectionRequired
                    ? collectionMethod
                    : null,
            },
        });
    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "Error verifying order delivery:",
            error
        );

        return res.status(500).json({
            message: "Internal server error",
        });
    } finally {
        client.release();
    }
};

// 20. POST /api/delivery/rider/push-token (Save Rider Mobile Expo Push Token)
export const saveRiderPushTokenController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { pushToken } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }
    if (!pushToken) {
        return res.status(400).json({ message: "pushToken is required." });
    }

    try {
        const updateRes = await pool.query(
            `UPDATE delivery_agents 
             SET push_token = $1, updated_at = NOW() 
             WHERE user_id = $2 
             RETURNING id, special_rider_id`,
            [pushToken, user.userId]
        );

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ message: "Active Rider profile not found." });
        }

        console.log(`[PushToken] Saved push token for rider ${updateRes.rows[0].special_rider_id}`);
        return res.status(200).json({
            message: "Push notification token registered successfully.",
            data: { riderId: updateRes.rows[0].id }
        });
    } catch (error) {
        console.error("Error saving rider push token:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 21. POST /api/delivery/rider/kyc (Submit flexible Indian KYC document & bank details)
export const submitRiderKYCController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    const { idDocType, idDocNumber, idDocImageUrl, bankName, accountNumber, ifscCode, accountHolderName } = req.body;

    if (!idDocType || !['aadhaar', 'pan', 'driving_license'].includes(idDocType)) {
        return res.status(400).json({ message: "Valid idDocType ('aadhaar' | 'pan' | 'driving_license') is required." });
    }
    if (!idDocNumber || !idDocNumber.trim()) {
        return res.status(400).json({ message: "Document number is required." });
    }
    if (!bankName || !accountNumber || !ifscCode || !accountHolderName) {
        return res.status(400).json({ message: "All bank payout details (Bank Name, Account Number, IFSC, Account Holder) are required." });
    }

    try {
        const riderRes = await pool.query(`SELECT id FROM delivery_agents WHERE user_id = $1`, [user.userId]);
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Delivery Agent profile not found." });
        }
        const riderId = riderRes.rows[0].id;

        // Upsert into delivery_agent_kyc table
        await pool.query(
            `INSERT INTO delivery_agent_kyc 
             (delivery_agent_id, kyc_status, id_doc_type, id_doc_number, id_doc_image_url, bank_name, account_number, ifsc_code, account_holder_name, submitted_at, updated_at)
             VALUES ($1, 'submitted', $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
             ON CONFLICT (delivery_agent_id) 
             DO UPDATE SET 
                kyc_status = 'submitted',
                id_doc_type = EXCLUDED.id_doc_type,
                id_doc_number = EXCLUDED.id_doc_number,
                id_doc_image_url = EXCLUDED.id_doc_image_url,
                bank_name = EXCLUDED.bank_name,
                account_number = EXCLUDED.account_number,
                ifsc_code = EXCLUDED.ifsc_code,
                account_holder_name = EXCLUDED.account_holder_name,
                submitted_at = NOW(),
                updated_at = NOW()`,
            [riderId, idDocType, idDocNumber.trim(), idDocImageUrl || null, bankName.trim(), accountNumber.trim(), ifscCode.trim().toUpperCase(), accountHolderName.trim()]
        );

        // Also update delivery_agents table status flag
        await pool.query(`UPDATE delivery_agents SET kyc_status = 'submitted', updated_at = NOW() WHERE id = $1`, [riderId]);

        return res.status(200).json({
            message: "KYC profile and bank details submitted successfully for review.",
            data: { kycStatus: 'submitted' }
        });
    } catch (error) {
        console.error("Error submitting rider KYC:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 22. GET /api/delivery/rider/kyc (Get rider KYC submission status & data)
export const getRiderKYCStatusController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    try {
        const riderRes = await pool.query(
            `SELECT da.id, da.kyc_status, 
                    k.id_doc_type, k.id_doc_number, k.id_doc_image_url, k.bank_name, k.account_number, k.ifsc_code, k.account_holder_name, k.rejection_reason, k.submitted_at, k.reviewed_at
             FROM delivery_agents da
             LEFT JOIN delivery_agent_kyc k ON da.id = k.delivery_agent_id
             WHERE da.user_id = $1`,
            [user.userId]
        );

        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Rider profile not found." });
        }

        const row = riderRes.rows[0];
        return res.status(200).json({
            message: "KYC status fetched successfully",
            data: {
                kycStatus: row.kyc_status || 'pending',
                idDocType: row.id_doc_type || null,
                idDocNumber: row.id_doc_number || null,
                idDocImageUrl: row.id_doc_image_url || null,
                bankName: row.bank_name || null,
                accountNumber: row.account_number || null,
                ifscCode: row.ifsc_code || null,
                accountHolderName: row.account_holder_name || null,
                rejectionReason: row.rejection_reason || null,
                submittedAt: row.submitted_at || null,
                reviewedAt: row.reviewed_at || null
            }
        });
    } catch (error) {
        console.error("Error fetching rider KYC status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 23. PATCH /api/delivery/riders/:riderId/kyc-status (FC Hub Manager approves/rejects rider KYC)
export const patchRiderKYCApprovalController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { riderId } = req.params;
    const { status, rejectionReason } = req.body;

    if (!user || (user.role !== "fulfillment_center" && user.role !== "admin")) {
        return res.status(403).json({ message: "Unauthorized. Hub Manager or Admin only." });
    }
    if (!status || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: "Status must be 'approved' or 'rejected'." });
    }

    try {
        await pool.query("BEGIN");

        // Update delivery_agent_kyc table
        await pool.query(
            `UPDATE delivery_agent_kyc 
             SET kyc_status = $1, 
                 reviewed_at = NOW(), 
                 reviewed_by_user_id = $2, 
                 rejection_reason = $3, 
                 updated_at = NOW() 
             WHERE delivery_agent_id = $4`,
            [status, user.userId, status === 'rejected' ? (rejectionReason || 'Documents verification failed') : null, riderId]
        );

        // Update delivery_agents table flag & activate status
        await pool.query(
            `UPDATE delivery_agents 
             SET kyc_status = $1, 
                 status = $2, 
                 updated_at = NOW() 
             WHERE id = $3`,
            [status, status === 'approved' ? 'active' : 'blocked', riderId]
        );

        await pool.query("COMMIT");

        return res.status(200).json({
            message: `Rider KYC status successfully updated to ${status}.`,
            data: { riderId, kycStatus: status }
        });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Error approving/rejecting rider KYC:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// 24. GET /api/delivery/rider/earnings (Rider Earnings Summary & Transaction History)
export const getRiderEarningsController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    try {
        const riderRes = await pool.query(
            `SELECT da.id, k.bank_name, k.account_number, k.ifsc_code, k.account_holder_name
             FROM delivery_agents da
             LEFT JOIN delivery_agent_kyc k ON da.id = k.delivery_agent_id
             WHERE da.user_id = $1`,
            [user.userId]
        );

        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Rider profile not found." });
        }
        const rider = riderRes.rows[0];

        // Total lifetime earnings
        const totalRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0)::numeric(10,2) as total_earnings
             FROM rider_earnings 
             WHERE delivery_agent_id = $1`,
            [rider.id]
        );

        // Today's earnings
        const todayRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0)::numeric(10,2) as today_earnings
             FROM rider_earnings 
             WHERE delivery_agent_id = $1 AND created_at >= CURRENT_DATE`,
            [rider.id]
        );

        // Leg Counts
        const legCountsRes = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE leg_type = 'vendor_pickup')::int as total_pickups,
                COUNT(*) FILTER (WHERE leg_type = 'client_dropoff')::int as total_drops
             FROM rider_earnings 
             WHERE delivery_agent_id = $1`,
            [rider.id]
        );

        // Transaction history (latest 50)
        const historyRes = await pool.query(
            `SELECT id, order_id, order_reference, leg_type, amount, status, created_at
             FROM rider_earnings 
             WHERE delivery_agent_id = $1 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [rider.id]
        );

        return res.status(200).json({
            message: "Earnings summary retrieved successfully",
            data: {
                totalEarnings: parseFloat(totalRes.rows[0].total_earnings || '0'),
                todayEarnings: parseFloat(todayRes.rows[0].today_earnings || '0'),
                totalPickups: legCountsRes.rows[0].total_pickups || 0,
                totalDrops: legCountsRes.rows[0].total_drops || 0,
                bankDetails: {
                    bankName: rider.bank_name || null,
                    accountNumber: rider.account_number || null,
                    ifscCode: rider.ifsc_code || null,
                    accountHolderName: rider.account_holder_name || null,
                },
                history: historyRes.rows
            }
        });
    } catch (error) {
        console.error("Error fetching rider earnings:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// POST /api/delivery/rider/cod-qr/create
export const createCodQrController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    const { orderId } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    if (!orderId) {
        return res.status(400).json({ message: "Order ID is required." });
    }

    try {
        const orderQ = await pool.query(
                    `SELECT
                        o.id,
                        o.user_id,
                        o.total_amount,
                        o.payment_status,
                        o.order_type,
                        o.order_reference
                    FROM orders o
                    JOIN order_fulfillment_tracking oft
                        ON oft.order_id = o.id
                    JOIN delivery_agents da
                        ON da.id = oft.delivery_agent_id
                    WHERE o.id = $1
                    AND da.user_id = $2
                    AND da.status = 'active'
                    AND oft.status = 'handed_over'
                    AND o.order_type = 'direct'
                    ORDER BY oft.created_at DESC
                    LIMIT 1`,
                    [orderId, user.userId]
                );

        if (orderQ.rows.length === 0) {
            return res.status(404).json({
                message: "Order not found or not assigned to you for delivery."
            });
        }

        const order = orderQ.rows[0];

        // Only COD pending orders can generate a payment QR
        if (order.payment_status !== 'cod_pending') {
            return res.status(400).json({
                message: "This order does not require COD payment collection."
            });
        }

        // Check payment_status, NOT order.status
        const alreadyPaidQ = await pool.query(
            `SELECT payment_status FROM orders WHERE id = $1`,
            [orderId]
        );

        if (alreadyPaidQ.rows[0]?.payment_status === 'paid') {
            return res.status(400).json({
                message: "Payment already completed for this order."
            });
        }

        // Look for an existing pending UPI payment link
        const existingPaymentQ = await pool.query(
            `SELECT id, razorpay_order_id
            FROM payments
            WHERE $1 = ANY(order_ids)
            AND quotation_request_id IS NULL
            AND payment_method = 'upi_qr'
            AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1`,
            [orderId]
        );

        let plink: any;

        if (existingPaymentQ.rows.length > 0) {
            try {
                plink = await (razorpay as any).paymentLink.fetch(
                    existingPaymentQ.rows[0].razorpay_order_id
                );

                // Existing link is only reusable if it is still created
                if (plink.status !== 'created') {
                    plink = null;
                }
            } catch {
                plink = null;
            }
        }

        // Create a new payment link only when there is no active one
        if (!plink) {
            const amountPaise = Math.round(Number(order.total_amount) * 100);

            plink = await (razorpay as any).paymentLink.create({
                amount: amountPaise,
                currency: "INR",
                accept_partial: false,
                description: `Order ${order.order_reference || order.id}`,
                notify: {
                    sms: false,
                    email: false
                },
                notes: {
                    orderId: order.id
                },
                expire_by: Math.floor(Date.now() / 1000) + 20 * 60,
            });

            await pool.query(
                `INSERT INTO payments
                    (
                        user_id,
                        amount,
                        status,
                        payment_method,
                        razorpay_order_id,
                        order_ids,
                        quotation_request_id
                    )
                VALUES
                    (
                        $1,
                        $2,
                        'pending',
                        'upi_qr',
                        $3,
                        ARRAY[$4]::uuid[],
                        NULL
                    )`,
                [
                    order.user_id,
                    order.total_amount,
                    plink.id,
                    orderId
                ]
            );
        }

        const qrDataUrl = await QRCode.toDataURL(
            plink.short_url,
            {
                width: 400,
                margin: 1
            }
        );

        return res.status(200).json({
            message: "Payment QR generated",
            data: {
                qrId: plink.id,
                imageUrl: qrDataUrl,
                amount: order.total_amount,
                paymentUrl: plink.short_url,
                expiry: Number(plink.expire_by) * 1000
            }
        });

    } catch (error: any) {
        console.error("Error creating COD payment link:", {
            message: error?.message,
            statusCode: error?.statusCode,
            description: error?.error?.description,
        });

        return res.status(500).json({
            message: "Failed to generate payment QR."
        });
    }
};

// GET /api/delivery/rider/cod-qr/:orderId/status/
export const getCodQrStatusController = async (
    req: Request,
    res: Response
): Promise<Response> => {
    const user = (req as any).user;
    const { orderId } = req.params;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({
            message: "Unauthorized.",
        });
    }

    if (!orderId) {
        return res.status(400).json({
            message: "Order ID is required.",
        });
    }

    try {
        const orderQ = await pool.query(
            `
            SELECT
                o.id,
                o.payment_status,
                o.order_type
            FROM orders o
            JOIN order_fulfillment_tracking oft
                ON oft.order_id = o.id
            JOIN delivery_agents da
                ON da.id = oft.delivery_agent_id
            WHERE o.id = $1
              AND da.user_id = $2
              AND da.status = 'active'
              AND oft.status = 'handed_over'
              AND o.order_type = 'direct'
            ORDER BY oft.created_at DESC
            LIMIT 1
            `,
            [orderId, user.userId]
        );

        if (orderQ.rows.length === 0) {
            return res.status(404).json({
                message: "Order not found or not assigned to you.",
            });
        }

        // ---------------------------------------------------------
        // First: check whether direct COD UPI was already successful
        // ---------------------------------------------------------
        const successfulPaymentQ = await pool.query(
            `
            SELECT
                id,
                razorpay_payment_id
            FROM payments
            WHERE $1 = ANY(order_ids)
              AND quotation_request_id IS NULL
              AND payment_method = 'upi_qr'
              AND status = 'successful'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [orderId]
        );

        if (successfulPaymentQ.rows.length > 0) {
            return res.status(200).json({
                data: {
                    paid: true,
                    paymentId:
                        successfulPaymentQ.rows[0]
                            .razorpay_payment_id || null,
                },
            });
        }

        // ---------------------------------------------------------
        // Then check active pending payment link
        // ---------------------------------------------------------
        const paymentQ = await pool.query(
            `
            SELECT
                id,
                razorpay_order_id
            FROM payments
            WHERE $1 = ANY(order_ids)
              AND quotation_request_id IS NULL
              AND payment_method = 'upi_qr'
              AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [orderId]
        );

        if (paymentQ.rows.length === 0) {
            return res.status(200).json({
                data: {
                    paid: false,
                    paymentId: null,
                },
            });
        }

        const payment = paymentQ.rows[0];

        const plink: any =
            await (razorpay as any).paymentLink.fetch(
                payment.razorpay_order_id
            );

        const paid = plink.status === "paid";

        const paymentId =
            plink.payments?.find(
                (p: any) => p.status === "captured"
            )?.payment_id ||
            plink.payments?.[0]?.payment_id ||
            null;

        if (paid) {
            await pool.query(
                `
                UPDATE payments
                SET
                    status = 'successful',
                    razorpay_payment_id = COALESCE(
                        $1,
                        razorpay_payment_id
                    ),
                    updated_at = NOW()
                WHERE id = $2
                  AND status = 'pending'
                `,
                [paymentId, payment.id]
            );

            await pool.query(
                `
                UPDATE orders
                SET
                    payment_status = 'paid',
                    updated_at = NOW()
                WHERE id = $1
                  AND payment_status = 'cod_pending'
                `,
                [orderId]
            );
        }

        return res.status(200).json({
            data: {
                paid,
                paymentId,
            },
        });
    } catch (error) {
        console.error(
            "Error checking direct COD payment status:",
            error
        );

        return res.status(500).json({
            message: "Failed to check payment status.",
        });
    }
};

// POST /api/delivery/rider/quotation-payment/create
export const createQuotationDeliveryPaymentQrController = async (
    req: Request,
    res: Response
): Promise<Response> => {
    const user = (req as any).user;
    const { orderId } = req.body;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({
            message: "Unauthorized. Delivery agents only.",
        });
    }

    if (!orderId) {
        return res.status(400).json({
            message: "Order ID is required.",
        });
    }

    try {
        // ---------------------------------------------------------
        // 1. Verify order belongs to this rider and is handed over
        // ---------------------------------------------------------
        const orderQ = await pool.query(
            `
            SELECT
                o.id,
                o.user_id,
                o.total_amount,
                o.payment_status,
                o.order_type,
                o.order_reference,
                qr.id AS quotation_request_id,
                qr.token_percentage,
                qr.token_amount
            FROM orders o

            JOIN order_fulfillment_tracking oft
                ON oft.order_id = o.id

            JOIN delivery_agents da
                ON da.id = oft.delivery_agent_id

            JOIN quotation_requests qr
                ON qr.order_id = o.id

            WHERE o.id = $1
              AND da.user_id = $2
              AND oft.status = 'handed_over'
              AND o.order_type = 'quotation'

            ORDER BY oft.created_at DESC
            LIMIT 1
            `,
            [orderId, user.userId]
        );

        if (orderQ.rows.length === 0) {
            return res.status(404).json({
                message:
                    "Quotation order not found or not assigned to you for delivery.",
            });
        }

                const order = orderQ.rows[0];

        // Splits (token/dispatch) are computed against price * qty * 1.18 (GST-inclusive),
        // but orders.total_amount is set without GST at order creation and never corrected
        // afterward. Recompute the same way here so this final 10% split lines up with
        // what was actually collected in splits 1 and 2, instead of trusting total_amount.
        const basePrice = order.accepted_price ? Number(order.accepted_price) : null;
        const baseQty = order.accepted_quantity ? Number(order.accepted_quantity) : null;

        let quotationTotal: number;

        if (basePrice && baseQty) {
            quotationTotal = basePrice * baseQty * 1.18;
        } else {
            // Fallback: order.accepted_price/quantity weren't selected in this query,
            // so pull them from quotation_requests directly.
            const qrDetailQ = await pool.query(
                `SELECT accepted_price, accepted_quantity, current_offer_price, current_offer_quantity
                 FROM quotation_requests WHERE id = $1`,
                [order.quotation_request_id]
            );
            const qrDetail = qrDetailQ.rows[0];
            const fallbackPrice = qrDetail?.accepted_price ? Number(qrDetail.accepted_price) : Number(qrDetail?.current_offer_price);
            const fallbackQty = qrDetail?.accepted_quantity ? Number(qrDetail.accepted_quantity) : Number(qrDetail?.current_offer_quantity);
            quotationTotal = (fallbackPrice && fallbackQty) ? fallbackPrice * fallbackQty * 1.18 : 0;
        }

        if (!quotationTotal || quotationTotal <= 0) {
            return res.status(400).json({
                message: "Invalid quotation total amount.",
            });
        }

        // ---------------------------------------------------------
        // 2. Make sure token payment was already completed
        // ---------------------------------------------------------
        const tokenPaymentQ = await pool.query(
            `
            SELECT
                id,
                amount,
                status
            FROM payments
            WHERE quotation_request_id = $1
              AND split_number = 1
              AND status = 'successful'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [order.quotation_request_id]
        );

        if (tokenPaymentQ.rows.length === 0) {
            return res.status(400).json({
                message:
                    "Token payment has not been completed. Delivery payment cannot be collected yet.",
            });
        }

        // ---------------------------------------------------------
        // 3. Make sure dispatch payment was already completed
        //
        // Dispatch payment will be split #2.
        // This branch does not implement dispatch payment,
        // but once that branch is merged this query will pick it up.
        // ---------------------------------------------------------
        const dispatchPaymentQ = await pool.query(
            `
            SELECT
                id,
                amount,
                status
            FROM payments
            WHERE quotation_request_id = $1
              AND split_number = 2
              AND status = 'successful'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [order.quotation_request_id]
        );

        if (dispatchPaymentQ.rows.length === 0) {
            return res.status(400).json({
                message:
                    "Dispatch payment has not been completed yet. Final delivery payment cannot be collected.",
            });
        }

        // ---------------------------------------------------------
        // 4. Calculate everything already paid
        //
        // Example:
        //
        // Total       = 100,000
        // Token       = 10,000
        // Dispatch    = 75,000
        //
        // Already paid = 85,000
        // Delivery     = 15,000
        // ---------------------------------------------------------
        const paidQ = await pool.query(
            `
            SELECT COALESCE(SUM(amount), 0) AS total_paid
            FROM payments
            WHERE quotation_request_id = $1
              AND order_ids @> ARRAY[$2]::uuid[]
              AND status = 'successful'
            `,
            [order.quotation_request_id, orderId]
        );

        const totalPaid = Number(
            paidQ.rows[0]?.total_paid || 0
        );

        const deliveryAmount = quotationTotal - totalPaid;

        // ---------------------------------------------------------
        // 5. Nothing left to collect
        // ---------------------------------------------------------
        if (deliveryAmount <= 0) {
            return res.status(400).json({
                message: "No remaining delivery payment is due.",
                data: {
                    quotationTotal,
                    totalPaid,
                    remainingAmount: 0,
                },
            });
        }

        // ---------------------------------------------------------
        // 6. Calculate the actual remaining percentage
        //
        // Example:
        // 15,000 / 100,000 = 15%
        // ---------------------------------------------------------
        const deliveryPercentage = (deliveryAmount / quotationTotal) * 100;
        const successfulDeliveryPaymentQ = await pool.query(`
            SELECT
                id,
                amount,
                razorpay_payment_id
            FROM payments
            WHERE $1 = ANY(order_ids)
            AND quotation_request_id = $2
            AND split_number = 3
            AND payment_method = 'upi_qr'
            AND status = 'successful'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [
                orderId,
                order.quotation_request_id,
            ]
        );

        if (successfulDeliveryPaymentQ.rows.length > 0) {
            return res.status(400).json({
                message:
                    "Final quotation delivery payment has already been completed.",
            });
        }
        // ---------------------------------------------------------
        // 7. Check whether a pending delivery QR already exists
        // ---------------------------------------------------------
        const existingPaymentQ = await pool.query(
            `
            SELECT
                id,
                amount,
                razorpay_order_id
            FROM payments
            WHERE $1 = ANY(order_ids)
              AND quotation_request_id = $2
              AND split_number = 3
              AND payment_method = 'upi_qr'
              AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [orderId, order.quotation_request_id]
        );

        let plink: any = null;

        if (existingPaymentQ.rows.length > 0) {
            try {
                plink = await (razorpay as any).paymentLink.fetch(
                    existingPaymentQ.rows[0].razorpay_order_id
                );

                // Reuse only an active payment link.
                if (plink.status !== "created") {
                    plink = null;
                }
            } catch {
                plink = null;
            }
        }

        // ---------------------------------------------------------
        // 8. Create Razorpay Payment Link if needed
        // ---------------------------------------------------------
        if (!plink) {
            const amountPaise = Math.round(
                deliveryAmount * 100
            );

            plink = await (razorpay as any).paymentLink.create({
                amount: amountPaise,
                currency: "INR",
                accept_partial: false,

                description:
                    `Final delivery payment for Order ${
                        order.order_reference || order.id
                    }`,

                notify: {
                    sms: false,
                    email: false,
                },

                notes: {
                    orderId: order.id,
                    quotationRequestId:
                        order.quotation_request_id,
                    paymentType: "quotation_delivery",
                    splitNumber: "3",
                },

                expire_by:
                    Math.floor(Date.now() / 1000) +
                    20 * 60,
            });

            // -----------------------------------------------------
            // 9. Store pending payment
            // -----------------------------------------------------
            await pool.query(
                `
                INSERT INTO payments (
                    user_id,
                    amount,
                    status,
                    payment_method,
                    razorpay_order_id,
                    order_ids,
                    quotation_request_id,
                    split_number,
                    split_percentage
                )
                VALUES (
                    $1,
                    $2,
                    'pending',
                    'upi_qr',
                    $3,
                    ARRAY[$4]::uuid[],
                    $5,
                    3,
                    $6
                )
                `,
                [
                    order.user_id,
                    deliveryAmount,
                    plink.id,
                    orderId,
                    order.quotation_request_id,
                    deliveryPercentage,
                ]
            );
        }

        // ---------------------------------------------------------
        // 10. Generate QR
        // ---------------------------------------------------------
        const qrDataUrl = await QRCode.toDataURL(
            plink.short_url,
            {
                width: 400,
                margin: 1,
            }
        );

        return res.status(200).json({
            message:
                "Quotation delivery payment QR generated",

            data: {
                qrId: plink.id,
                imageUrl: qrDataUrl,
                paymentUrl: plink.short_url,
                expiry: Number(plink.expire_by) * 1000,

                paymentType: "quotation_delivery",
                splitNumber: 3,

                quotationTotal,
                alreadyPaid: totalPaid,
                amount: deliveryAmount,
                percentage: deliveryPercentage,
            },
        });

    } catch (error: any) {
        console.error(
            "Error creating quotation delivery payment QR:",
            {
                message: error?.message,
                statusCode: error?.statusCode,
                description: error?.error?.description,
            }
        );

        return res.status(500).json({
            message:
                "Failed to generate quotation delivery payment QR.",
        });
    }
};

// GET /api/delivery/rider/quotation-payment/:orderId/status

// GET /api/delivery/rider/quotation-payment/:orderId/status
export const getQuotationDeliveryPaymentStatusController = async (
    req: Request,
    res: Response
): Promise<Response> => {
    const user = (req as any).user;
    const { orderId } = req.params;

    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({
            message: "Unauthorized.",
        });
    }

    if (!orderId) {
        return res.status(400).json({
            message: "Order ID is required.",
        });
    }

    try {
        // ---------------------------------------------------------
        // 1. Verify quotation + rider assignment
        // ---------------------------------------------------------
        const assignmentQ = await pool.query(
            `
            SELECT
                o.id,
                o.total_amount,
                o.payment_status,
                qr.id AS quotation_request_id
            FROM orders o
            JOIN quotation_requests qr
                ON qr.order_id = o.id
            JOIN order_fulfillment_tracking oft
                ON oft.order_id = o.id
            JOIN delivery_agents da
                ON da.id = oft.delivery_agent_id
            WHERE o.id = $1
              AND da.user_id = $2
              AND da.status = 'active'
              AND o.order_type = 'quotation'
              AND oft.status = 'handed_over'
            ORDER BY oft.created_at DESC
            LIMIT 1
            `,
            [orderId, user.userId]
        );

        if (assignmentQ.rows.length === 0) {
            return res.status(404).json({
                message:
                    "Quotation order not found or not assigned to you.",
            });
        }

        const order = assignmentQ.rows[0];

        // ---------------------------------------------------------
        // 2. IMPORTANT:
        //    Look for both successful and pending split #3
        // ---------------------------------------------------------
        const paymentQ = await pool.query(
            `
            SELECT
                id,
                amount,
                razorpay_order_id,
                razorpay_payment_id,
                split_percentage,
                status
            FROM payments
            WHERE $1 = ANY(order_ids)
              AND quotation_request_id = $2
              AND split_number = 3
              AND payment_method = 'upi_qr'
              AND status IN ('pending', 'successful')
            ORDER BY
                CASE
                    WHEN status = 'successful' THEN 0
                    ELSE 1
                END,
                created_at DESC
            LIMIT 1
            `,
            [
                orderId,
                order.quotation_request_id,
            ]
        );

        // No final UPI payment exists.
        // This is normal for a quotation waiting for cash.
        if (paymentQ.rows.length === 0) {
            return res.status(200).json({
                data: {
                    paid: false,
                    paymentPending: false,
                },
            });
        }

        const payment = paymentQ.rows[0];

        // ---------------------------------------------------------
        // 3. Already successful in DB
        // ---------------------------------------------------------
        if (payment.status === "successful") {
            return res.status(200).json({
                data: {
                    paid: true,
                    paymentPending: false,
                    paymentId:
                        payment.razorpay_payment_id || null,
                    amount: Number(payment.amount),
                },
            });
        }

        // ---------------------------------------------------------
        // 4. Still pending -> ask Razorpay
        // ---------------------------------------------------------
        if (!payment.razorpay_order_id) {
            return res.status(500).json({
                message:
                    "Quotation payment is missing its Razorpay payment link.",
            });
        }

        const plink: any =
            await (razorpay as any).paymentLink.fetch(
                payment.razorpay_order_id
            );

        const paid = plink.status === "paid";

        const paymentId =
            plink.payments?.find(
                (p: any) => p.status === "captured"
            )?.payment_id ||
            plink.payments?.[0]?.payment_id ||
            null;

        // ---------------------------------------------------------
        // 5. Payment completed on Razorpay
        // ---------------------------------------------------------
        if (paid) {
            await pool.query(
                `
                UPDATE payments
                SET
                    status = 'successful',
                    razorpay_payment_id = COALESCE(
                        $1,
                        razorpay_payment_id
                    ),
                    updated_at = NOW()
                WHERE id = $2
                  AND status = 'pending'
                `,
                [
                    paymentId,
                    payment.id,
                ]
            );

            // Recalculate all successful quotation payments
            const paidTotalQ = await pool.query(
                `
                SELECT COALESCE(
                    SUM(amount),
                    0
                ) AS total_paid
                FROM payments
                WHERE quotation_request_id = $1
                  AND $2 = ANY(order_ids)
                  AND status = 'successful'
                `,
                [
                    order.quotation_request_id,
                    orderId,
                ]
            );

            const totalPaid = Number(
                paidTotalQ.rows[0]?.total_paid || 0
            );

            const quotationTotal = Number(
                order.total_amount
            );

            // Once split #3 completes the total, order is financially paid.
            // Delivery still requires OTP / customer QR separately.
            if (totalPaid >= quotationTotal) {
                await pool.query(
                    `
                    UPDATE orders
                    SET
                        payment_status = 'paid',
                        updated_at = NOW()
                    WHERE id = $1
                    `,
                    [orderId]
                );
            }

            return res.status(200).json({
                data: {
                    paid: true,
                    paymentPending: false,
                    paymentId,
                    amount: Number(payment.amount),
                },
            });
        }

        // ---------------------------------------------------------
        // 6. Still waiting for customer
        // ---------------------------------------------------------
        return res.status(200).json({
            data: {
                paid: false,
                paymentPending: true,
                amount: Number(payment.amount),
                percentage:
                    Number(payment.split_percentage) || 0,
            },
        });
    } catch (error) {
        console.error(
            "Error checking quotation delivery payment:",
            error
        );

        return res.status(500).json({
            message:
                "Failed to check quotation delivery payment status.",
        });
    }
};;
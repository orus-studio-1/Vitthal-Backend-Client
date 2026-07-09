import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import pool from "../DbConnect";

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
            `SELECT id, stop_sequence FROM order_route_plan 
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

        // Insert into tracking log
        const locationLabel = `${hub.name} (${hub.code})`;
        const note = shelfLocation ? `Shelved at Location: ${shelfLocation}` : "Received at hub";
        await client.query(
            `INSERT INTO order_fulfillment_tracking (order_id, fulfillment_center_id, status, note, location_label, stop_sequence)
             VALUES ($1, $2, 'received', $3, $4, $5)`,
            [order.id, hub.id, note, locationLabel, stop.stop_sequence]
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
                   o.order_reference, o.customer_name,
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
            `SELECT id, user_id FROM delivery_agents 
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
                   da.status, da.is_online, da.current_latitude, da.current_longitude, da.last_located_at,
                   u.name as rider_name, u.email as rider_email
            FROM delivery_agents da
            JOIN users u ON da.user_id = u.id
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

        // Create User account for Rider
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
                email: normalizedEmail
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
    const { contact_phone, vehicle_type, vehicle_number, status } = req.body;

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

        // Perform updates
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
                   o.address_line, o.city, o.state, o.pincode, o.latitude, o.langitude,
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
            `SELECT o.id as order_id, o.order_reference, o.customer_name, 
                    o.address_line, o.city, o.state, o.pincode,
                    oft.created_at as delivered_at,
                    (
                        SELECT json_agg(json_build_object('name', p.name, 'quantity', oi.quantity))
                        FROM order_items oi
                        JOIN products p ON oi.product_id = p.id
                        WHERE oi.order_id = o.id AND oi.vendor_id = o.vendor_id
                    ) as items
             FROM orders o
             JOIN order_fulfillment_tracking oft ON o.id = oft.order_id
             WHERE oft.delivery_agent_id = $1 AND oft.status = 'delivered'
             ORDER BY oft.created_at DESC`,
            [riderId]
        );

        return res.status(200).json({
            message: "Completed deliveries history retrieved",
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
    const { orderId } = req.body;

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

        // Check if the order was indeed handed over to this rider
        const assignmentRes = await client.query(
            `SELECT id FROM order_fulfillment_tracking 
             WHERE order_id = $1 AND delivery_agent_id = $2 AND status = 'handed_over'`,
            [orderId, riderId]
        );
        if (assignmentRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "This order is not assigned to you for delivery." });
        }

        // Update the order global status to delivered
        await client.query(
            `UPDATE orders SET status = 'delivered', updated_at = NOW() WHERE id = $1`,
            [orderId]
        );

        // Insert delivered tracking log
        await client.query(
            `INSERT INTO order_fulfillment_tracking (order_id, delivery_agent_id, status, note, location_label)
             VALUES ($1, $2, 'delivered', 'Order successfully delivered to customer.', 'Customer Location')`,
            [orderId, riderId]
        );

        await client.query("COMMIT");
        return res.status(200).json({
            message: "Order successfully marked as delivered.",
            data: { orderId }
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
        // Fetch Rider Profile
        const riderRes = await pool.query(
            `SELECT id, special_rider_id, contact_phone, vehicle_type, vehicle_number, is_online, status
             FROM delivery_agents
             WHERE user_id = $1 AND status = 'active'`,
            [user.userId]
        );
        if (riderRes.rows.length === 0) {
            return res.status(404).json({ message: "Active Rider profile not found." });
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
                riderInfo: {
                    id: rider.id,
                    specialRiderId: rider.special_rider_id,
                    contactPhone: rider.contact_phone,
                    vehicleType: rider.vehicle_type,
                    vehicleNumber: rider.vehicle_number,
                    isOnline: rider.is_online,
                    status: rider.status
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
            `SELECT id, user_id FROM delivery_agents 
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
            SELECT orp.id as stop_id, orp.order_id, orp.stop_sequence, orp.status,
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
export const verifyDeliveryController = async (req: Request, res: Response): Promise<Response> => {
    const user = (req as any).user;
    if (!user || user.role !== "delivery_agent") {
        return res.status(403).json({ message: "Unauthorized. Delivery agents only." });
    }

    const { orderId, code } = req.body;
    console.log("[verifyDelivery] Incoming verification request:", { orderId, code });
    if (!orderId || !code) {
        return res.status(400).json({ message: "Order ID and verification code/QR are required." });
    }

    try {
        // Query to check if the code matches the order's delivery details
        const orderQ = await pool.query(
            `SELECT id, order_reference 
             FROM orders 
             WHERE id = $1 AND (delivery_otp = $2 OR delivery_qr_token = $3)`,
            [orderId, String(code).trim(), String(code).trim()]
        );

        if (orderQ.rows.length === 0) {
            return res.status(400).json({ message: "Invalid verification code or QR code scanned." });
        }

        const order = orderQ.rows[0];

        // Begin verification updates
        await pool.query("BEGIN");

        // 1. Update order status to delivered
        await pool.query(
            `UPDATE orders 
             SET status = 'delivered', updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [orderId]
        );

        // 2. Add history record
        await pool.query(
            `INSERT INTO order_status_history (order_id, status, note, created_at)
             VALUES ($1, 'delivered', 'Order delivered successfully to customer', CURRENT_TIMESTAMP)`,
            [orderId]
        );

        // 3. Add tracking entry
        await pool.query(
            `INSERT INTO order_fulfillment_tracking (order_id, status, note, created_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
            [orderId, 'delivered', 'Order delivered successfully to customer.']
        );

        // 4. Update route stops to departed
        await pool.query(
            `UPDATE order_route_plan 
             SET status = 'departed', actual_arrival = NOW(), updated_at = NOW()
             WHERE order_id = $1`,
            [orderId]
        );

        // 5. Clear verification tokens from order
        await pool.query(
            `UPDATE orders 
             SET delivery_otp = NULL, delivery_qr_token = NULL 
             WHERE id = $1`,
            [orderId]
        );

        await pool.query("COMMIT");

        return res.status(200).json({
            message: "Delivery verified successfully! Order marked as completed.",
            data: {
                orderId,
                orderReference: order.order_reference
            }
        });

    } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Error verifying order delivery:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

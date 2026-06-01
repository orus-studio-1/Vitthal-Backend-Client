import type { Request, Response } from "express";
import pool from "../DbConnect";

export const placeOrderController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;

    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId, role } = authUser;


    try {
        await pool.query('BEGIN');

        // 1. Fetch user's address
        const addressId = req.body.addressId || req.body.address_id || null;
        let addressQuery;
        
        if (addressId) {
            addressQuery = await pool.query(
                `SELECT * FROM addresses WHERE id = $1 AND user_id = $2`,
                [addressId, userId]
            );
        } else {
            addressQuery = await pool.query(
                `SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [userId]
            );
        }

        if (addressQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "No address found for client. Please add an address before checkout." });
        }
        const address = addressQuery.rows[0];

        // 2. Fetch user's cart and cart_items
        const cartQuery = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = 'direct'`,
            [userId]
        );
        if (cartQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "No active cart found" });
        }
        const cartId = cartQuery.rows[0].id;

        const cartItemsQuery = await pool.query(
            `SELECT product_id, vendor_id, quantity, price_at_added 
             FROM cart_items WHERE cart_id = $1`,
            [cartId]
        );
        const cartItems = cartItemsQuery.rows;

        if (cartItems.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "Cart is empty" });
        }

        // 3. Group cart items by vendor_id
        const itemsByVendor: Record<string, typeof cartItems> = {};
        for (const item of cartItems) {
            if (!itemsByVendor[item.vendor_id]) {
                itemsByVendor[item.vendor_id] = [];
            }
            itemsByVendor[item.vendor_id].push(item);
        }

        // 4. Create order for each vendor
        const userProfileQuery = await pool.query(
            `
                SELECT u.name, u.email, c.phone
                FROM users u
                LEFT JOIN client c ON c.user_id = u.id
                WHERE u.id = $1
            `,
            [userId]
        );
        const userProfile = userProfileQuery.rows[0];

        for (const vendorId in itemsByVendor) {
            const vendorItems = itemsByVendor[vendorId];
            let totalAmount = 0;
            for (const item of vendorItems) {
                totalAmount += Number(item.price_at_added) * Number(item.quantity);
            }

            // Insert into orders table
            const orderResult = await pool.query(
                `INSERT INTO orders (
                    user_id, vendor_id, cart_id, status, payment_status, total_amount,
                    address_line, city, state, country, pincode, latitude, langitude,
                    source, order_type, customer_name, customer_email, customer_phone
                ) VALUES ($1, $2, $3, 'pending', 'confirmed', $4, $5, $6, $7, $8, $9, $10, $11, 'client', 'direct', $12, $13, $14) RETURNING id`,
                [
                    userId, vendorId, cartId, totalAmount,
                    address.address, address.city, address.state, address.country,
                    address.pincode, address.latitude, address.longitude || address.latitude,
                    userProfile?.name || null,
                    userProfile?.email || null,
                    userProfile?.phone || null
                ]
            );
            const orderId = orderResult.rows[0].id;

            // Create initial status history entry
            await pool.query(
                `INSERT INTO order_status_history (order_id, status, note, created_at)
                 VALUES ($1, 'pending', 'Order placed by customer', CURRENT_TIMESTAMP)`,
                [orderId]
            );

            // Insert into order_items table
            for (const item of vendorItems) {
                await pool.query(
                    `INSERT INTO order_items (order_id, product_id, vendor_id, quantity, price) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [orderId, item.product_id, item.vendor_id, item.quantity, item.price_at_added]
                );
            }
        }

        // 5. Clear the cart items since they are now ordered
        await pool.query(
            `DELETE FROM cart_items WHERE cart_id = $1`,
            [cartId]
        );

        await pool.query('COMMIT');
        return res.status(200).json({ message: "Order placed successfully!" });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("Place order error:", error);
        return res.status(500).json({ message: "Failed to place order due to internal error." });
    }
};

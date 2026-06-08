import type { Request, Response } from "express";
import pool from "../DbConnect";
import Razorpay from "razorpay";
import crypto from "crypto";

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_51tD21k26t9Q2l",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "dummysecret12345",
});

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

export const createPaymentOrderController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }
    const { userId } = authUser;

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
            return res.status(400).json({ message: "No address found. Please add an address before checkout." });
        }
        const address = addressQuery.rows[0];

        // 2. Fetch active cart
        const cartQuery = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = 'direct'`,
            [userId]
        );
        if (cartQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "No active cart found" });
        }
        const cartId = cartQuery.rows[0].id;

        // 3. Fetch cart items joined with stock and product details
        const cartItemsQuery = await pool.query(
            `SELECT ci.product_id, ci.vendor_id, ci.quantity, ci.price_at_added, vp.stock_quantity, p.name as product_name
             FROM cart_items ci
             JOIN vendor_products vp ON vp.product_id = ci.product_id AND vp.vendor_id = ci.vendor_id
             JOIN products p ON p.id = ci.product_id
             WHERE ci.cart_id = $1`,
            [cartId]
        );
        const cartItems = cartItemsQuery.rows;
        if (cartItems.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "Cart is empty" });
        }

        // 4. Verify stock quantity
        for (const item of cartItems) {
            if (Number(item.quantity) > Number(item.stock_quantity)) {
                await pool.query('ROLLBACK');
                return res.status(400).json({ 
                    message: `Insufficient stock for product "${item.product_name}". Available: ${item.stock_quantity}, Requested: ${item.quantity}.` 
                });
            }
        }

        // 5. Group items by vendor to create orders
        const itemsByVendor: Record<string, typeof cartItems> = {};
        for (const item of cartItems) {
            if (!itemsByVendor[item.vendor_id]) {
                itemsByVendor[item.vendor_id] = [];
            }
            itemsByVendor[item.vendor_id].push(item);
        }

        const userProfileQuery = await pool.query(
            `SELECT u.name, u.email, c.phone FROM users u LEFT JOIN client c ON c.user_id = u.id WHERE u.id = $1`,
            [userId]
        );
        const userProfile = userProfileQuery.rows[0];

        const orderIds: string[] = [];
        let totalCheckoutAmount = 0;

        for (const vendorId in itemsByVendor) {
            const vendorItems = itemsByVendor[vendorId];
            let orderTotal = 0;
            for (const item of vendorItems) {
                orderTotal += Number(item.price_at_added) * Number(item.quantity);
            }
            totalCheckoutAmount += orderTotal;

            // Insert into orders table with payment_status = 'pending' and status = 'pending'
            const orderResult = await pool.query(
                `INSERT INTO orders (
                    user_id, vendor_id, cart_id, status, payment_status, total_amount,
                    address_line, city, state, country, pincode, latitude, langitude,
                    source, order_type, customer_name, customer_email, customer_phone
                ) VALUES ($1, $2, $3, 'pending', 'pending', $4, $5, $6, $7, $8, $9, $10, $11, 'client', 'direct', $12, $13, $14) RETURNING id`,
                [
                    userId, vendorId, cartId, orderTotal,
                    address.address, address.city, address.state, address.country,
                    address.pincode, address.latitude, address.longitude || address.latitude,
                    userProfile?.name || null,
                    userProfile?.email || null,
                    userProfile?.phone || null
                ]
            );
            const orderId = orderResult.rows[0].id;
            orderIds.push(orderId);

            // Create initial status history entry
            await pool.query(
                `INSERT INTO order_status_history (order_id, status, note, created_at)
                 VALUES ($1, 'pending', 'Order initiated, payment pending', CURRENT_TIMESTAMP)`,
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

        // Add 18% GST/taxes to checkout amount to match frontend calculation
        const subtotal = totalCheckoutAmount;
        const taxes = subtotal * 0.18;
        const finalTotal = subtotal + taxes;

        // 6. Create Razorpay order
        const razorpayAmount = Math.round(finalTotal * 100);

        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ 
                message: "Razorpay credentials (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured in the backend .env file. Please configure them to proceed with payments." 
            });
        }

        const razorpayOrder = await (razorpay.orders.create({
            amount: razorpayAmount,
            currency: "INR",
            receipt: `receipt_${Date.now()}`,
            notes: {
                userId,
                orderIds: orderIds.join(","),
            }
        }) as any);

        // 7. Store payment record as pending
        await pool.query(
            `INSERT INTO payments (
                user_id, amount, status, payment_method, razorpay_order_id, order_ids, split_percentage
            ) VALUES ($1, $2, 'pending', 'razorpay', $3, $4, 100.00)`,
            [userId, finalTotal, razorpayOrder.id, orderIds]
        );

        await pool.query('COMMIT');

        return res.status(200).json({
            keyId: keyId,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            razorpayOrderId: razorpayOrder.id,
            orderIds: orderIds,
            userProfile: {
                name: userProfile?.name || "",
                email: userProfile?.email || "",
                phone: userProfile?.phone || ""
            }
        });

    } catch (error: any) {
        await pool.query('ROLLBACK');
        console.error("Create payment order error:", error);
        let message = "Failed to initiate payment.";
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

export const verifyPaymentController = async (req: Request, res: Response): Promise<Response> => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
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
            // Update payment status to failed
            await pool.query(
                `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE razorpay_order_id = $1`,
                [razorpay_order_id]
            );
            return res.status(400).json({ message: "Payment verification failed. Invalid signature." });
        }

        await pool.query('BEGIN');

        // 2. Fetch payment details to get order_ids and user_id
        const paymentQuery = await pool.query(
            `SELECT order_ids, user_id, amount FROM payments WHERE razorpay_order_id = $1`,
            [razorpay_order_id]
        );

        if (paymentQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ message: "Payment record not found." });
        }

        const { order_ids, user_id } = paymentQuery.rows[0];

        // 3. Update payment record to successful
        await pool.query(
            `UPDATE payments 
             SET status = 'successful', razorpay_payment_id = $2, razorpay_signature = $3, updated_at = NOW()
             WHERE razorpay_order_id = $1`,
            [razorpay_order_id, razorpay_payment_id, razorpay_signature]
        );

        // 4. Update orders status and deduct stock
        for (const orderId of order_ids) {
            // Update order status to 'pending' and payment_status to 'paid'
            await pool.query(
                `UPDATE orders 
                 SET status = 'pending', payment_status = 'paid', updated_at = NOW() 
                 WHERE id = $1`,
                [orderId]
            );

            // Add history entry
            await pool.query(
                `INSERT INTO order_status_history (order_id, status, note, created_at)
                 VALUES ($1, 'pending', 'Payment verified successfully. Awaiting vendor confirmation.', CURRENT_TIMESTAMP)`,
                [orderId]
            );

            // Stock deduction removed from here - it is now performed when vendor accepts the order
        }

        // 5. Clear user's active direct cart
        const cartQuery = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = 'direct'`,
            [user_id]
        );
        if (cartQuery.rows.length > 0) {
            const cartId = cartQuery.rows[0].id;
            await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
        }

        await pool.query('COMMIT');
        return res.status(200).json({ message: "Payment verified and order placed successfully!" });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("Payment verification error:", error);
        return res.status(500).json({ message: "Internal server error during verification." });
    }
};

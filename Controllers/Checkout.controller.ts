import type { Request, Response } from "express";
import pool from "../DbConnect";
import { razorpay } from "../services/razorpay.service";
import crypto from "crypto";

export const placeOrderController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;

    if (!authUser?.userId || !authUser?.role) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { userId } = authUser;

    try {
        await pool.query('BEGIN');

        // 1. Fetch user's address
        const addressId = req.body?.addressId || req.body?.address_id || null;
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

        // 2. Fetch user's cart
        const cartQuery = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = 'direct'`,
            [userId]
        );
        if (cartQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "No active cart found" });
        }
        const cartId = cartQuery.rows[0].id;

        // 3. Fetch cart items with stock check
        const cartItemsQuery = await pool.query(
            `SELECT ci.product_id, ci.product_variant_id, ci.vendor_id, ci.quantity,
                    vp.price as latest_price, vp.discounted_price, vp.stock_quantity, p.name as product_name
             FROM cart_items ci
             JOIN vendor_products vp ON vp.product_variant_id = ci.product_variant_id AND vp.vendor_id = ci.vendor_id
             JOIN products p ON p.id = ci.product_id
             WHERE ci.cart_id = $1`,
            [cartId]
        );
        const cartItems = cartItemsQuery.rows;

        const serviceCartItemsQuery = await pool.query(
            `SELECT sci.service_id, sci.vendor_service_id, sci.vendor_id, sci.quantity, sci.price_at_added
             FROM service_cart_items sci
             WHERE sci.cart_id = $1`,
            [cartId]
        );
        const serviceCartItems = serviceCartItemsQuery.rows;

        if (cartItems.length === 0 && serviceCartItems.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "Cart is empty" });
        }

        // 4. Stock check — COD still needs to validate stock before confirming
        for (const item of cartItems) {
            if (Number(item.quantity) > Number(item.stock_quantity)) {
                await pool.query('ROLLBACK');
                return res.status(400).json({
                    message: `Insufficient stock for product "${item.product_name}". Available: ${item.stock_quantity}, Requested: ${item.quantity}.`
                });
            }
        }

        // 5. Group cart items by vendor_id
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

        const createdOrderIds: string[] = [];

        for (const vendorId in itemsByVendor) {
            const vendorItems = itemsByVendor[vendorId];
            let totalAmount = 0;
            for (const item of vendorItems) {
                const latestPrice = Number(item.latest_price) || 0;
                const discountedPrice = item.discounted_price !== null && item.discounted_price !== undefined ? Number(item.discounted_price) : null;
                const effectivePrice = (discountedPrice !== null && discountedPrice < latestPrice) ? discountedPrice : latestPrice;
                totalAmount += effectivePrice * Number(item.quantity);
            }

            // COD: payment_status = 'cod_pending' — money not collected until delivery, distinct from
            // the online-payment 'pending' status used while waiting on Razorpay confirmation
            const orderResult = await pool.query(
                `INSERT INTO orders (
                    user_id, vendor_id, cart_id, status, payment_status, total_amount,
                    address_line, city, state, country, pincode, latitude, langitude,
                    source, order_type, customer_name, customer_email, customer_phone, order_notes
                ) VALUES ($1, $2, $3, 'pending', 'cod_pending', $4, $5, $6, $7, $8, $9, $10, $11, 'client', 'direct', $12, $13, $14, 'Cash on Delivery') RETURNING id`,
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
            createdOrderIds.push(orderId);

            await pool.query(
                `INSERT INTO order_status_history (order_id, status, note, created_at)
                 VALUES ($1, 'pending', 'Order placed by customer (Cash on Delivery)', CURRENT_TIMESTAMP)`,
                [orderId]
            );

            for (const item of vendorItems) {
                const latestPrice = Number(item.latest_price) || 0;
                const discountedPrice = item.discounted_price !== null && item.discounted_price !== undefined ? Number(item.discounted_price) : null;
                const effectivePrice = (discountedPrice !== null && discountedPrice < latestPrice) ? discountedPrice : latestPrice;
                const originalPrice = (discountedPrice !== null && discountedPrice < latestPrice) ? latestPrice : null;

                await pool.query(
                    `INSERT INTO order_items (order_id, product_id, product_variant_id, vendor_id, quantity, price, original_price) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [orderId, item.product_id, item.product_variant_id, item.vendor_id, item.quantity, effectivePrice, originalPrice]
                );
            }
        }

        // Service bookings via COD
        for (const item of serviceCartItems) {
            const amount = Number(item.price_at_added) * Number(item.quantity);
            await pool.query(
                `INSERT INTO service_bookings (
                    user_id, vendor_id, vendor_service_id, total_amount, status, payment_status, booking_notes
                ) VALUES ($1, $2, $3, $4, 'pending', 'cod_pending', 'Cash on Delivery')`,
                [userId, item.vendor_id, item.vendor_service_id, amount]
            );
        }

        await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
        await pool.query(`DELETE FROM service_cart_items WHERE cart_id = $1`, [cartId]);

        await pool.query('COMMIT');
        return res.status(200).json({
            message: "Order placed successfully! Pay on delivery.",
            orderIds: createdOrderIds,
        });
    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("Place COD order error:", error);
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
            `SELECT ci.product_id, ci.product_variant_id, ci.vendor_id, ci.quantity, vp.price as latest_price, vp.discounted_price, vp.stock_quantity, p.name as product_name, vp.gst_percentage
             FROM cart_items ci
             JOIN vendor_products vp ON vp.product_variant_id = ci.product_variant_id AND vp.vendor_id = ci.vendor_id
             JOIN products p ON p.id = ci.product_id
             WHERE ci.cart_id = $1`,
            [cartId]
        );
        const cartItems = cartItemsQuery.rows;

        // Fetch service cart items
        const serviceCartItemsQuery = await pool.query(
            `SELECT sci.service_id, sci.vendor_service_id, sci.vendor_id, sci.quantity, sci.price_at_added
             FROM service_cart_items sci
             WHERE sci.cart_id = $1`,
            [cartId]
        );
        const serviceCartItems = serviceCartItemsQuery.rows;

        if (cartItems.length === 0 && serviceCartItems.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ message: "Cart is empty" });
        }

        // 4. Verify stock quantity (products only)
        if (cartItems.length > 0) {
            for (const item of cartItems) {
                if (Number(item.quantity) > Number(item.stock_quantity)) {
                    await pool.query('ROLLBACK');
                    return res.status(400).json({ 
                        message: `Insufficient stock for product "${item.product_name}". Available: ${item.stock_quantity}, Requested: ${item.quantity}.` 
                    });
                }
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
                const latestPrice = Number(item.latest_price) || 0;
                const discountedPrice = item.discounted_price !== null && item.discounted_price !== undefined ? Number(item.discounted_price) : null;
                const effectivePrice = (discountedPrice !== null && discountedPrice < latestPrice) ? discountedPrice : latestPrice;
                orderTotal += effectivePrice * Number(item.quantity);
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
                const latestPrice = Number(item.latest_price) || 0;
                const discountedPrice = item.discounted_price !== null && item.discounted_price !== undefined ? Number(item.discounted_price) : null;
                const effectivePrice = (discountedPrice !== null && discountedPrice < latestPrice) ? discountedPrice : latestPrice;
                const originalPrice = (discountedPrice !== null && discountedPrice < latestPrice) ? latestPrice : null;

                await pool.query(
                    `INSERT INTO order_items (order_id, product_id, product_variant_id, vendor_id, quantity, price, original_price) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [orderId, item.product_id, item.product_variant_id, item.vendor_id, item.quantity, effectivePrice, originalPrice]
                );
            }
        }

        // 5b. Create service bookings (pending payment)
        const bookingIds: string[] = [];
        let totalServiceAmount = 0;

        for (const item of serviceCartItems) {
            const amount = Number(item.price_at_added) * Number(item.quantity);
            totalServiceAmount += amount;

            const bookingResult = await pool.query(
                `INSERT INTO service_bookings (
                    user_id, vendor_id, vendor_service_id, total_amount, status, payment_status
                ) VALUES ($1, $2, $3, $4, 'pending', 'pending') RETURNING id`,
                [userId, item.vendor_id, item.vendor_service_id, amount]
            );
            bookingIds.push(bookingResult.rows[0].id);
        }

        // Calculate taxes dynamically based on each item's actual gst_percentage
        let taxes = 0;
        for (const item of cartItems) {
            const latestPrice = Number(item.latest_price) || 0;
            const discountedPrice = item.discounted_price !== null && item.discounted_price !== undefined ? Number(item.discounted_price) : null;
            const effectivePrice = (discountedPrice !== null && discountedPrice < latestPrice) ? discountedPrice : latestPrice;

            const itemGstPercent = item.gst_percentage !== null && item.gst_percentage !== undefined ? Number(item.gst_percentage) : 0;
            taxes += (effectivePrice * Number(item.quantity)) * (itemGstPercent / 100);
        }
        const subtotal = totalCheckoutAmount + totalServiceAmount;
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
                bookingIds: bookingIds.join(","),
            }
        }) as any);

        // 7. Store payment record as pending
        await pool.query(
            `INSERT INTO payments (
                user_id, amount, status, payment_method, razorpay_order_id, order_ids, booking_ids, split_percentage
            ) VALUES ($1, $2, 'pending', 'razorpay', $3, $4, $5, 100.00)`,
            [userId, finalTotal, razorpayOrder.id, orderIds, bookingIds]
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

        // 2. Fetch payment details to get order_ids, booking_ids, and user_id
        const paymentQuery = await pool.query(
            `SELECT order_ids, booking_ids, user_id, amount FROM payments WHERE razorpay_order_id = $1`,
            [razorpay_order_id]
        );

        if (paymentQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ message: "Payment record not found." });
        }

        const { order_ids, booking_ids, user_id } = paymentQuery.rows[0];

        // 3. Update payment record to successful
        await pool.query(
            `UPDATE payments 
             SET status = 'successful', razorpay_payment_id = $2, razorpay_signature = $3, updated_at = NOW()
             WHERE razorpay_order_id = $1`,
            [razorpay_order_id, razorpay_payment_id, razorpay_signature]
        );

        // 4. Update orders status and deduct stock
        if (order_ids && order_ids.length > 0) {
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
            }
        }

        // 4b. Update service bookings status and payment status
        if (booking_ids && booking_ids.length > 0) {
            for (const bookingId of booking_ids) {
                await pool.query(
                    `UPDATE service_bookings 
                     SET status = 'confirmed', payment_status = 'paid', updated_at = NOW() 
                     WHERE id = $1`,
                    [bookingId]
                );
            }
        }

        // 5. Clear user's active direct cart
        const cartQuery = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = 'direct'`,
            [user_id]
        );
        if (cartQuery.rows.length > 0) {
            const cartId = cartQuery.rows[0].id;
            await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
            await pool.query(`DELETE FROM service_cart_items WHERE cart_id = $1`, [cartId]);
        }

        await pool.query('COMMIT');
        return res.status(200).json({ message: "Payment verified and order placed successfully!" });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error("Payment verification error:", error);
        return res.status(500).json({ message: "Internal server error during verification." });
    }
};

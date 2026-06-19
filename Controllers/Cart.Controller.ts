import type { Request, Response } from "express";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

type CartType = "direct" | "quotation";

function normalizeCartType(value: unknown): CartType {
    return value === "quotation" ? "quotation" : "direct";
}


export const getCartDataController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id doesn't found" });
    }
    const cartType = normalizeCartType(req.query.type);
    try {
        const query = `
            SELECT
                ci.id as cart_item_id,
                ci.product_id,
                ci.product_variant_id,
                pv.properties as variant_properties,
                ci.vendor_id,
                ci.quantity,
                ci.price_at_added,
                ci.created_at,
                p.name as product_name,
                p.quotation_limit,
                vp.price as current_price,
                vp.discounted_price,
                vp.moq,
                vp.quotation_enabled,
                vp.stock_quantity,
                vp.gst_percentage,
                (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) as image_url,
                v.company_name as vendor_name
            FROM carts c
            JOIN cart_items ci ON c.id = ci.cart_id
            JOIN products p ON ci.product_id = p.id
            JOIN product_variants pv ON ci.product_variant_id = pv.id
            JOIN vendors v ON ci.vendor_id = v.id
            JOIN vendor_products vp ON vp.product_variant_id = ci.product_variant_id AND vp.vendor_id = ci.vendor_id
            WHERE c.user_id = $1 AND c.status = 'active' AND c.cart_type = $2
            ORDER BY ci.created_at DESC
        `;

        const result = await pool.query(query, [userId, cartType]);
        const rows = await Promise.all(
            result.rows.map(async (row) => {
                const discountedPrice = row.discounted_price !== null && row.discounted_price !== undefined ? Number(row.discounted_price) : null;
                const currentPrice = Number(row.current_price) || 0;
                const activePrice = (discountedPrice !== null && discountedPrice < currentPrice) ? discountedPrice : currentPrice;
                const originalPrice = (discountedPrice !== null && discountedPrice < currentPrice) ? currentPrice : null;
                return {
                    ...row,
                    price_at_added: activePrice,
                    original_price: originalPrice,
                    image_url: await getPresignedUrlOrOriginal(row.image_url),
                };
            })
        );
        return res.status(200).json({ data: rows });
    } catch (error) {
        console.error("Error in getCartDataController: ", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const addCartItemController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    const { product_variant_id, vendor_id, quantity, cart_type } = req.body;
    let product_id = req.body.product_id;
    const cartType = normalizeCartType(cart_type);

    if ((!product_variant_id && !product_id) || !vendor_id || !quantity || quantity < 1) {
        return res.status(400).json({ message: "product_variant_id (or product_id), vendor_id, and quantity (>=1) are required" });
    }

    try {
        // 1. Get or create cart
        let cartResult = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = $2`,
            [userId, cartType]
        );

        let cartId: string;
        if (cartResult.rows.length === 0) {
            cartResult = await pool.query(
                `INSERT INTO carts (user_id, status, total_amount, cart_type) VALUES ($1, 'active', 0, $2) RETURNING id`,
                [userId, cartType]
            );
            cartId = cartResult.rows[0].id;
        } else {
            cartId = cartResult.rows[0].id;
        }

        let resolvedVariantId = product_variant_id;
        if (!resolvedVariantId) {
            const variantRes = await pool.query(
                `SELECT id FROM product_variants WHERE product_id = $1 AND properties = '{}'::jsonb LIMIT 1`,
                [product_id]
            );
            if (variantRes.rows.length > 0) {
                resolvedVariantId = variantRes.rows[0].id;
            } else {
                const insertVariantRes = await pool.query(
                    `INSERT INTO product_variants (product_id, properties, approval_status, is_active)
                     VALUES ($1, '{}'::jsonb, 'approved', true) RETURNING id`,
                    [product_id]
                );
                resolvedVariantId = insertVariantRes.rows[0].id;
            }
        } else if (!product_id) {
            const variantRes = await pool.query(
                `SELECT product_id FROM product_variants WHERE id = $1`,
                [resolvedVariantId]
            );
            if (variantRes.rows.length === 0) {
                return res.status(404).json({ message: "Product variant not found" });
            }
            product_id = variantRes.rows[0].product_id;
        }

        // 2. Get current price from vendor_products
        const priceResult = await pool.query(
            `SELECT vp.price, vp.discounted_price, vp.moq, vp.quotation_enabled, vp.stock_quantity, p.quotation_limit
             FROM vendor_products vp
             JOIN products p ON p.id = vp.product_id
             WHERE vp.product_variant_id = $1 AND vp.vendor_id = $2 AND vp.is_active = true`,
            [resolvedVariantId, vendor_id]
        );
        if (priceResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not available from this vendor" });
        }
        const priceRow = priceResult.rows[0];
        const currentPrice = priceRow.price;
        const discountedPrice = priceRow.discounted_price !== null && priceRow.discounted_price !== undefined ? Number(priceRow.discounted_price) : null;
        const effectivePrice = (discountedPrice !== null && discountedPrice < currentPrice) ? discountedPrice : currentPrice;
        
        const quotationLimit = priceRow.quotation_limit ? Number(priceRow.quotation_limit) : null;
        const moq = Number(priceRow.moq) || 1;

        // Check if quantity requires quotation flow
        if (cartType === "direct" && quotationLimit && quantity >= quotationLimit) {
            return res.status(409).json({
                message: `This product requires quotation for quantities of ${quotationLimit} or more`,
                requiresQuotation: true,
                minQuoteQty: quotationLimit,
            });
        }

        if (cartType === "quotation") {
            if (!quotationLimit) {
                return res.status(400).json({ message: "Quotation is not enabled for this product (no quotation limit set)" });
            }
            const minAllowed = Math.max(quotationLimit, moq);
            if (quantity < minAllowed) {
                return res.status(400).json({ message: `Minimum quotation quantity is ${minAllowed}` });
            }
        }

        // 3. Upsert cart item
        await pool.query(
            `INSERT INTO cart_items (cart_id, product_id, product_variant_id, vendor_id, quantity, price_at_added)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (cart_id, product_variant_id, vendor_id)
             DO UPDATE SET quantity = cart_items.quantity + $5, updated_at = NOW()` ,
            [cartId, product_id, resolvedVariantId, vendor_id, quantity, effectivePrice]
        );

        return res.status(201).json({ message: "Item added to cart", cart_id: cartId });
    } catch (e) {
        console.error("Error in addCartItemController: ", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const updateCartItemController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    const { product_variant_id, vendor_id, quantity, cart_type } = req.body;
    let product_id = req.body.product_id;
    const cartType = normalizeCartType(cart_type);

    if ((!product_variant_id && !product_id) || !vendor_id || !quantity || quantity < 1) {
        return res.status(400).json({ message: "product_variant_id (or product_id), vendor_id, and quantity (>=1) are required" });
    }

    try {
        // Get user's cart
        const cartResult = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = $2`,
            [userId, cartType]
        );
        if (cartResult.rows.length === 0) {
            return res.status(404).json({ message: "Cart not found" });
        }
        const cartId = cartResult.rows[0].id;

        let resolvedVariantId = product_variant_id;
        if (!resolvedVariantId) {
            const variantRes = await pool.query(
                `SELECT id FROM product_variants WHERE product_id = $1 AND properties = '{}'::jsonb LIMIT 1`,
                [product_id]
            );
            if (variantRes.rows.length === 0) {
                return res.status(404).json({ message: "Default variant not found" });
            }
            resolvedVariantId = variantRes.rows[0].id;
        }

        const priceResult = await pool.query(
            `SELECT vp.moq, vp.quotation_enabled, vp.stock_quantity, p.quotation_limit
             FROM vendor_products vp
             JOIN products p ON p.id = vp.product_id
             WHERE vp.product_variant_id = $1 AND vp.vendor_id = $2 AND vp.is_active = true`,
            [resolvedVariantId, vendor_id]
        );
        if (priceResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not available from this vendor" });
        }
        const quotationLimit = priceResult.rows[0].quotation_limit ? Number(priceResult.rows[0].quotation_limit) : null;
        const moq = Number(priceResult.rows[0].moq) || 1;

        if (cartType === "direct" && quotationLimit && quantity >= quotationLimit) {
            return res.status(409).json({
                message: `This product requires quotation for quantities of ${quotationLimit} or more`,
                requiresQuotation: true,
                minQuoteQty: quotationLimit,
            });
        }

        if (cartType === "quotation") {
            if (!quotationLimit) {
                return res.status(400).json({ message: "Quotation is not enabled for this product (no quotation limit set)" });
            }
            const minAllowed = Math.max(quotationLimit, moq);
            if (quantity < minAllowed) {
                return res.status(400).json({ message: `Minimum quotation quantity is ${minAllowed}` });
            }
        }

        // Update quantity
        const updateResult = await pool.query(
            `UPDATE cart_items SET quantity = $1, updated_at = NOW()
             WHERE cart_id = $2 AND product_variant_id = $3 AND vendor_id = $4
             RETURNING id`,
            [quantity, cartId, resolvedVariantId, vendor_id]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({ message: "Cart item not found" });
        }

        return res.status(200).json({ message: "Quantity updated" });
    } catch (e) {
        console.error("Error in updateCartItemController: ", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const removeCartItemController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    const { product_variant_id, vendor_id, cart_type } = req.body;
    let product_id = req.body.product_id;
    const cartType = normalizeCartType(cart_type);

    if ((!product_variant_id && !product_id) || !vendor_id) {
        return res.status(400).json({ message: "product_variant_id (or product_id) and vendor_id are required" });
    }

    try {
        // Get user's cart
        const cartResult = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = $2`,
            [userId, cartType]
        );
        if (cartResult.rows.length === 0) {
            return res.status(404).json({ message: "Cart not found" });
        }
        const cartId = cartResult.rows[0].id;

        let resolvedVariantId = product_variant_id;
        if (!resolvedVariantId) {
            const variantRes = await pool.query(
                `SELECT id FROM product_variants WHERE product_id = $1 AND properties = '{}'::jsonb LIMIT 1`,
                [product_id]
            );
            if (variantRes.rows.length === 0) {
                console.log("not found", product_id)
                return res.status(404).json({ message: "Default variant not found" });
            }
            resolvedVariantId = variantRes.rows[0].id;
        }

        // Delete item
        const deleteResult = await pool.query(
            `DELETE FROM cart_items WHERE cart_id = $1 AND product_variant_id = $2 AND vendor_id = $3 RETURNING id`,
            [cartId, resolvedVariantId, vendor_id]
        );

        if (deleteResult.rows.length === 0) {
            return res.status(404).json({ message: "Cart item not found" });
        }

        return res.status(200).json({ message: "Item removed" });
    } catch (e) {
        console.error("Error in removeCartItemController: ", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const clearCartController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }
    const cartType = normalizeCartType(req.query.type);

    try {
        // Get user's cart
        const cartResult = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = $2`,
            [userId, cartType]
        );
        if (cartResult.rows.length === 0) {
            return res.status(200).json({ message: "Cart is already empty" });
        }
        const cartId = cartResult.rows[0].id;

        // Delete all items
        await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);

        return res.status(200).json({ message: "Cart cleared" });
    } catch (e) {
        console.error("Error in clearCartController: ", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const shareCartController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    const { cart_type } = req.body;
    const cartType = normalizeCartType(cart_type);

    try {
        // 1. Get the active cart for the user and type
        const cartResult = await pool.query(
            `SELECT id FROM carts WHERE user_id = $1 AND status = 'active' AND cart_type = $2`,
            [userId, cartType]
        );
        if (cartResult.rows.length === 0) {
            return res.status(404).json({ message: "No active cart found to share" });
        }
        const activeCartId = cartResult.rows[0].id;

        // 2. Verify there are items in the active cart
        const itemsResult = await pool.query(
            `SELECT COUNT(*) FROM cart_items WHERE cart_id = $1`,
            [activeCartId]
        );
        if (Number(itemsResult.rows[0].count) === 0) {
            return res.status(400).json({ message: "Cannot share an empty cart" });
        }

        // 3. Create a new cart row with status = 'shared'
        const newCartResult = await pool.query(
            `INSERT INTO carts (user_id, status, cart_type, total_amount) 
             VALUES ($1, 'shared', $2, 0) RETURNING id`,
            [userId, cartType]
        );
        const sharedCartId = newCartResult.rows[0].id;

        // 4. Copy all items from the active cart to the new shared cart
        await pool.query(
            `INSERT INTO cart_items (cart_id, product_id, product_variant_id, vendor_id, quantity, price_at_added)
             SELECT $1, product_id, product_variant_id, vendor_id, quantity, price_at_added
             FROM cart_items
             WHERE cart_id = $2`,
            [sharedCartId, activeCartId]
        );

        return res.status(201).json({
            message: "Cart shared successfully",
            shared_cart_id: sharedCartId
        });
    } catch (e) {
        console.error("Error in shareCartController: ", e);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getSharedCartController = async (req: Request, res: Response): Promise<Response> => {
    const { id: sharedCartId } = req.params;
    if (!sharedCartId) {
        return res.status(400).json({ message: "Shared cart ID is required" });
    }

    try {
        // 1. Verify and fetch the shared cart metadata
        const cartResult = await pool.query(
            `SELECT id, cart_type, created_at, user_id FROM carts WHERE id = $1 AND status = 'shared'`,
            [sharedCartId]
        );
        if (cartResult.rows.length === 0) {
            return res.status(404).json({ message: "Shared cart not found" });
        }
        const cart = cartResult.rows[0];

        // 2. Fetch the items for this shared cart, joining with product details
        const query = `
            SELECT
                ci.id as cart_item_id,
                ci.product_id,
                ci.product_variant_id,
                pv.properties as variant_properties,
                ci.vendor_id,
                ci.quantity,
                ci.price_at_added,
                ci.created_at,
                p.name as product_name,
                p.quotation_limit,
                vp.price as current_price,
                vp.discounted_price,
                vp.moq,
                vp.quotation_enabled,
                vp.stock_quantity,
                vp.gst_percentage,
                (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) as image_url,
                v.company_name as vendor_name,
                u.name as sender_name
            FROM carts c
            JOIN cart_items ci ON c.id = ci.cart_id
            JOIN products p ON ci.product_id = p.id
            JOIN product_variants pv ON ci.product_variant_id = pv.id
            JOIN vendors v ON ci.vendor_id = v.id
            JOIN users u ON c.user_id = u.id
            JOIN vendor_products vp ON vp.product_variant_id = ci.product_variant_id AND vp.vendor_id = ci.vendor_id
            WHERE c.id = $1 AND c.status = 'shared'
            ORDER BY ci.created_at DESC
        `;

        const itemsResult = await pool.query(query, [sharedCartId]);
        const items = await Promise.all(
            itemsResult.rows.map(async (row) => {
                const discountedPrice = row.discounted_price !== null && row.discounted_price !== undefined ? Number(row.discounted_price) : null;
                const currentPrice = Number(row.current_price) || 0;
                const activePrice = (discountedPrice !== null && discountedPrice < currentPrice) ? discountedPrice : currentPrice;
                const originalPrice = (discountedPrice !== null && discountedPrice < currentPrice) ? currentPrice : null;
                return {
                    ...row,
                    price_at_added: activePrice,
                    original_price: originalPrice,
                    image_url: await getPresignedUrlOrOriginal(row.image_url),
                };
            })
        );
        return res.status(200).json({
            cart_type: cart.cart_type,
            sender_name: items[0]?.sender_name || "A user",
            items
        });
    } catch (error) {
        console.error("Error in getSharedCartController: ", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
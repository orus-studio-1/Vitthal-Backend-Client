import type { Request, Response } from "express";
import pool from "../DbConnect";

const getWishlistId = async (userId: string): Promise<string> => {
    const existingWishlist = await pool.query(
        `SELECT id FROM wishlists WHERE user_id = $1 AND status = 'active'`,
        [userId]
    );

    if (existingWishlist.rows.length > 0) {
        return existingWishlist.rows[0].id;
    }

    const createdWishlist = await pool.query(
        `INSERT INTO wishlists (user_id, status) VALUES ($1, 'active') RETURNING id`,
        [userId]
    );

    return createdWishlist.rows[0].id;
};

export const getWishlistController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    try {
        const query = `
            SELECT
                wi.product_id,
                wi.product_variant_id,
                pv.properties as variant_properties,
                wi.vendor_id,
                wi.created_at,
                p.name as product_name,
                p.description,
                (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) as image_url,
                v.company_name as vendor_name,
                vp.price as current_price,
                vp.moq,
                vp.stock_quantity
            FROM wishlists w
            JOIN wishlist_items wi ON w.id = wi.wishlist_id
            JOIN products p ON wi.product_id = p.id
            LEFT JOIN product_variants pv ON wi.product_variant_id = pv.id
            LEFT JOIN vendors v ON wi.vendor_id = v.id
            LEFT JOIN vendor_products vp ON vp.product_variant_id = wi.product_variant_id AND vp.vendor_id = wi.vendor_id
            WHERE w.user_id = $1 AND w.status = 'active'
            ORDER BY wi.created_at DESC
        `;

        const result = await pool.query(query, [userId]);
        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error in getWishlistController:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const addWishlistItemController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    const { product_id, product_variant_id = null, vendor_id = null } = req.body;
    if (!product_id && !product_variant_id) {
        return res.status(400).json({ message: "product_id or product_variant_id is required" });
    }

    try {
        let resolvedProductId = product_id;
        let resolvedVariantId = product_variant_id;

        if (resolvedVariantId && !resolvedProductId) {
            const variantRes = await pool.query(
                `SELECT product_id FROM product_variants WHERE id = $1`,
                [resolvedVariantId]
            );
            if (variantRes.rows.length === 0) {
                return res.status(404).json({ message: "Product variant not found" });
            }
            resolvedProductId = variantRes.rows[0].product_id;
        } else if (resolvedProductId && !resolvedVariantId) {
            const variantRes = await pool.query(
                `SELECT id FROM product_variants WHERE product_id = $1 AND properties = '{}'::jsonb LIMIT 1`,
                [resolvedProductId]
            );
            if (variantRes.rows.length > 0) {
                resolvedVariantId = variantRes.rows[0].id;
            } else {
                const insertVariantRes = await pool.query(
                    `INSERT INTO product_variants (product_id, properties, approval_status, is_active)
                     VALUES ($1, '{}'::jsonb, 'approved', true) RETURNING id`,
                    [resolvedProductId]
                );
                resolvedVariantId = insertVariantRes.rows[0].id;
            }
        }

        const wishlistId = await getWishlistId(userId);

        await pool.query(
            `INSERT INTO wishlist_items (wishlist_id, product_id, product_variant_id, vendor_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (wishlist_id, product_variant_id)
             DO UPDATE SET vendor_id = COALESCE(EXCLUDED.vendor_id, wishlist_items.vendor_id), updated_at = NOW()`,
            [wishlistId, resolvedProductId, resolvedVariantId, vendor_id]
        );

        return res.status(201).json({ message: "Item added to wishlist" });
    } catch (error) {
        console.error("Error in addWishlistItemController:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const removeWishlistItemController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    const { product_id, product_variant_id } = req.body;
    if (!product_id && !product_variant_id) {
        return res.status(400).json({ message: "product_id or product_variant_id is required" });
    }

    try {
        const wishlistId = await getWishlistId(userId);

        let deleteResult;
        if (product_variant_id) {
            deleteResult = await pool.query(
                `DELETE FROM wishlist_items WHERE wishlist_id = $1 AND product_variant_id = $2 RETURNING id`,
                [wishlistId, product_variant_id]
            );
        } else {
            deleteResult = await pool.query(
                `DELETE FROM wishlist_items WHERE wishlist_id = $1 AND product_id = $2 RETURNING id`,
                [wishlistId, product_id]
            );
        }

        if (deleteResult.rows.length === 0) {
            return res.status(404).json({ message: "Wishlist item not found" });
        }

        return res.status(200).json({ message: "Item removed from wishlist" });
    } catch (error) {
        console.error("Error in removeWishlistItemController:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const clearWishlistController = async (req: Request, res: Response): Promise<Response> => {
    const userId = (req as any).user?.userId;
    if (!userId) {
        return res.status(401).json({ message: "User Id not found" });
    }

    try {
        const wishlistId = await getWishlistId(userId);
        await pool.query(`DELETE FROM wishlist_items WHERE wishlist_id = $1`, [wishlistId]);
        return res.status(200).json({ message: "Wishlist cleared" });
    } catch (error) {
        console.error("Error in clearWishlistController:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
import type { Request, Response } from "express";
import pool from "../DbConnect";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

const s3Client = new S3Client({
    region: (process.env.AWS_REGION || "ap-south-1").trim(),
    credentials: {
        accessKeyId: (process.env.AWS_ACCESS_KEY_ID || "").trim(),
        secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
    },
});

const actionTaker = ['super_admin', 'admin', 'vendor'];

type SpecificationEntry = {
    spec_key: string;
    spec_value: string;
    approval_status: "pending" | "approved" | "rejected";
};

const approvedSpecificationsSelect = `
                COALESCE(specAgg.specifications, '{}'::jsonb) AS specifications
            `;

const approvedSpecificationsJoin = `
            LEFT JOIN LATERAL (
                SELECT COALESCE(
                    jsonb_object_agg(ps.spec_key, ps.spec_value ORDER BY ps.created_at),
                    '{}'::jsonb
                ) AS specifications
                FROM product_specification ps
                WHERE ps.product_id = p.id
                  AND ps.approval_status = 'approved'
            ) specAgg ON true
        `;

function readVariantProperty(properties: unknown, keys: string[]) {
    if (!properties || typeof properties !== "object") {
        return null;
    }

    const record = properties as Record<string, unknown>;
    const normalizedEntries = Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/[\s_-]+/g, ""), value] as const);
    for (const key of keys) {
        const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, "");
        const match = normalizedEntries.find(([entryKey]) => entryKey === normalizedKey);
        if (match && match[1] !== undefined && match[1] !== null && String(match[1]).trim() !== "") {
            return String(match[1]).trim();
        }
    }

    return null;
}

function normalizeOffer(row: any) {
    const originalPrice = Number(row.price) || 0;
    const discountedPrice = row.discounted_price !== null && row.discounted_price !== undefined ? Number(row.discounted_price) : null;
    const activePrice = discountedPrice !== null && discountedPrice > 0 && discountedPrice < originalPrice ? discountedPrice : originalPrice;
    const gstPercentage = row.gst_percentage !== null && row.gst_percentage !== undefined ? Number(row.gst_percentage) : 0;
    const moq = Number(row.moq) || 1;

    return {
        vendor_product_id: row.vendor_product_id,
        vendor_id: row.vendor_id,
        product_variant_id: row.product_variant_id || null,
        vendor_name: row.vendor_name,
        price: activePrice,
        original_price: originalPrice,
        discounted_price: discountedPrice,
        gst_percentage: gstPercentage,
        unit_price_with_gst: activePrice + (activePrice * gstPercentage / 100),
        moq,
        stock_quantity: Number(row.stock_quantity) || 0,
        quotation_enabled: Boolean(row.quotation_enabled),
        quotation_min_qty: row.quotation_min_qty !== null && row.quotation_min_qty !== undefined ? Number(row.quotation_min_qty) : null,
        rating: Number(row.rating) || 0,
        review_count: Number(row.review_count) || 0,
        latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
        longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
        city: row.city,
        state: row.state,
        delivery_lead_time: row.city || row.state ? "2-5 business days" : "Confirm with vendor",
        is_verified: true,
    };
}

function normalizeSpecificationEntries(
    specifications: unknown,
    defaultApprovalStatus: "pending" | "approved"
): SpecificationEntry[] {
    if (!specifications) {
        return [];
    }

    const rawEntries = Array.isArray(specifications)
        ? specifications
        : typeof specifications === "object"
            ? Object.entries(specifications as Record<string, unknown>).map(([key, value]) => ({ key, value }))
            : (() => {
                if (typeof specifications !== "string") {
                    return [] as Array<{ key: string; value: unknown }>;
                }

                try {
                    const parsed = JSON.parse(specifications) as unknown;
                    if (Array.isArray(parsed)) {
                        return parsed as Array<{ key: string; value: unknown }>;
                    }

                    if (parsed && typeof parsed === "object") {
                        return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({ key, value }));
                    }

                    return [] as Array<{ key: string; value: unknown }>;
                }
                catch {
                    return [] as Array<{ key: string; value: unknown }>;
                }
            })();

    return rawEntries
        .map((entry) => {
            const key = String((entry as { key?: unknown; spec_key?: unknown }).key ?? (entry as { key?: unknown; spec_key?: unknown }).spec_key ?? "").trim();
            const value = String((entry as { value?: unknown; spec_value?: unknown }).value ?? (entry as { value?: unknown; spec_value?: unknown }).spec_value ?? "").trim();
            const approvalStatus = (entry as { approval_status?: unknown }).approval_status;

            if (!key) {
                return null;
            }

            if (approvalStatus === "pending" || approvalStatus === "approved" || approvalStatus === "rejected") {
                return { spec_key: key, spec_value: value, approval_status: approvalStatus };
            }

            return { spec_key: key, spec_value: value, approval_status: defaultApprovalStatus };
        })
        .filter((entry): entry is SpecificationEntry => Boolean(entry));
}

async function getVendorAllowedCategories(userId: string) {
    const categoryResult = await pool.query(
        `
            SELECT pc.code, pc.label
            FROM vendors v
            JOIN vendor_categories vc ON vc.vendor_id = v.id
            JOIN product_category pc ON pc.id = vc.category_id
            WHERE v.user_id = $1
              AND pc.is_active = TRUE
        `,
        [userId]
    );

    if (categoryResult.rows.length > 0) {
        return categoryResult.rows as Array<{ code: string; label: string }>;
    }

    const fallbackResult = await pool.query(
        `
            SELECT code, label
            FROM product_category
            WHERE is_active = TRUE
            ORDER BY sort_order ASC, label ASC
        `
    );

    return fallbackResult.rows as Array<{ code: string; label: string }>;
}

async function resolveCategoryId(rawCategory: string) {
    const normalizedCategory = rawCategory.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (uuidRegex.test(normalizedCategory)) {
        const byIdResult = await pool.query(
            `
                SELECT id
                FROM product_category
                WHERE id = $1
                  AND is_active = TRUE
                LIMIT 1
            `,
            [normalizedCategory]
        );

        if (!byIdResult.rows.length) {
            throw new Error("Selected category is invalid.");
        }

        return byIdResult.rows[0].id as string;
    }

    const byCodeResult = await pool.query(
        `
            SELECT id
            FROM product_category
            WHERE LOWER(code) = LOWER($1)
              AND is_active = TRUE
            LIMIT 1
        `,
        [normalizedCategory]
    );

    if (!byCodeResult.rows.length) {
        throw new Error("Selected category is invalid.");
    }

    return byCodeResult.rows[0].id as string;
}

async function getApprovedVendorProfile(userId: string) {
    const vendorResult = await pool.query(
        `
            SELECT id, approval_status, is_active, is_blocked
            FROM vendors
            WHERE user_id = $1
        `,
        [userId]
    );

    if (!vendorResult.rows.length) {
        throw new Error("Please complete your vendor profile before adding products.");
    }

    const vendor = vendorResult.rows[0];
    if (vendor.approval_status !== "approved" || !vendor.is_active || vendor.is_blocked) {
        throw new Error("Your vendor account must be approved and active before you can add products.");
    }

    return vendor as { id: string; approval_status: string; is_active: boolean; is_blocked: boolean };
}

async function getVendorProfileIfExists(userId: string) {
    const vendorResult = await pool.query(
        `
            SELECT id, approval_status, is_active, is_blocked
            FROM vendors
            WHERE user_id = $1
        `,
        [userId]
    );

    return vendorResult.rows[0] as
        | { id: string; approval_status: string; is_active: boolean; is_blocked: boolean }
        | undefined;
}

export const addProductController = async (req: Request, res: Response): Promise<Response> => {
    const { name, description, category, productType, specifications, quotationLimit, material, grade, application, standard } = req.body;
    const itemCode = req.body.itemCode || req.body.item_code || null;

    const { role, userId } = (req as any).user;
    if (!name || !category || !productType) {
        return res.status(400).json({ message: "Name, category, and productType are required" });
    }

    const vendorProfile = userId ? await getVendorProfileIfExists(userId) : undefined;
    const isApprovedVendorActor = Boolean(
        vendorProfile &&
        vendorProfile.approval_status === "approved" &&
        vendorProfile.is_active &&
        !vendorProfile.is_blocked
    );
    const canCreateProduct = actionTaker.includes(role) || isApprovedVendorActor;

    if (!canCreateProduct) {
        return res.status(403).json({ message: "Unauthorized! Only admins, super admins, and vendors can add products." });
    }

    const actsAsVendor = role === "vendor" || isApprovedVendorActor;
    if (actsAsVendor) {
        const allowedCategories = await getVendorAllowedCategories(userId);
        const normalizedCategory = String(category).trim().toLowerCase();
        const hasAllowedCategory = allowedCategories.some((allowedCategory) => {
            return allowedCategory.code.trim().toLowerCase() === normalizedCategory || allowedCategory.label.trim().toLowerCase() === normalizedCategory;
        });

        if (!hasAllowedCategory) {
            return res.status(403).json({ message: "You can only add products that belong to your assigned vendor categories." });
        }
    }

    const parsedSpecifications = normalizeSpecificationEntries(
        specifications,
        actsAsVendor ? "pending" : "approved"
    );

    const attributesObj: Record<string, string> = {};
    if (req.body.attributes && typeof req.body.attributes === 'object') {
        Object.entries(req.body.attributes).forEach(([key, val]) => {
            attributesObj[key.trim()] = String(val).trim();
        });
    }
    if (material) attributesObj.material = String(material).trim();
    if (grade) attributesObj.grade = String(grade).trim();
    if (application) attributesObj.application = String(application).trim();
    if (standard) attributesObj.standard = String(standard).trim();

    // Map attributes into parsedSpecifications so they are also saved in product_specification
    Object.entries(attributesObj).forEach(([key, val]) => {
        const valueStr = String(val).trim();
        if (valueStr) {
            const normalizedKey = key.trim();
            const exists = parsedSpecifications.some(s => s.spec_key.toLowerCase() === normalizedKey.toLowerCase());
            if (!exists) {
                parsedSpecifications.push({
                    spec_key: normalizedKey,
                    spec_value: valueStr,
                    approval_status: actsAsVendor ? "pending" : "approved"
                });
            }
        }
    });

    if (itemCode) {
        const existingProduct = await pool.query(
            `SELECT id, name, approval_status, created_by_user_id FROM products WHERE LOWER(item_code) = LOWER($1)`,
            [String(itemCode).trim()]
        );
        if (existingProduct.rows.length > 0) {
            const product = existingProduct.rows[0];
            if (product.approval_status === 'pending' && String(product.created_by_user_id) === String(userId)) {
                // Retry scenario for the same vendor: return the existing product and allow them to proceed
                return res.status(200).json({
                    message: "Existing pending product submission found.",
                    result: product
                });
            } else if (product.approval_status === 'approved') {
                return res.status(400).json({
                    message: `A product with this Item Code already exists in the catalog (Approved). Please search for "${product.name}" in Step 1 and link your pricing.`
                });
            } else {
                return res.status(400).json({
                    message: "A product with this Item Code has already been submitted by another vendor and is pending approval."
                });
            }
        }
    }

    const client = await pool.connect();

    try {
        const approvalStatus = actsAsVendor ? "pending" : "approved";
        const resolvedCategoryId = await resolveCategoryId(String(category));
        await client.query("BEGIN");

        const parsedQuotationLimit = quotationLimit ? Number(quotationLimit) : null;
        if (parsedQuotationLimit !== null && (isNaN(parsedQuotationLimit) || parsedQuotationLimit < 1)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Quotation limit must be a positive integer" });
        }

        const subcategoryId = req.body.subcategoryId || req.body.subcategory_id || null;
        let resolvedSubcategoryId: string | null = null;
        if (subcategoryId && typeof subcategoryId === "string" && subcategoryId.trim()) {
            const subCheck = await client.query(
                `SELECT id FROM subcategories WHERE id = $1 AND category_id = $2 LIMIT 1`,
                [subcategoryId.trim(), resolvedCategoryId]
            );
            if (subCheck.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ message: "Selected subcategory does not belong to this category." });
            }
            resolvedSubcategoryId = subCheck.rows[0].id;
        }

        const query = `
            INSERT INTO products (
                name,
                description,
                category,
                subcategory_id,
                product_type,
                attributes,
                approval_status,
                created_by_user_id,
                is_active,
                quotation_limit,
                item_code
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            returning *
        `;
        const values = [
            name,
            description,
            resolvedCategoryId,
            resolvedSubcategoryId,
            productType,
            JSON.stringify(attributesObj),
            approvalStatus,
            userId,
            !actsAsVendor,
            parsedQuotationLimit,
            itemCode
        ];
        const result = await client.query(query, values);

        if (parsedSpecifications.length > 0) {
            for (const specification of parsedSpecifications) {
                await client.query(
                    `
                        INSERT INTO product_specification (
                            product_id,
                            spec_key,
                            spec_value,
                            approval_status,
                            created_by_user_id
                        )
                        VALUES ($1, $2, $3, $4, $5)
                    `,
                    [
                        result.rows[0].id,
                        specification.spec_key,
                        specification.spec_value,
                        specification.approval_status,
                        userId
                    ]
                );
            }
        }

        await client.query("COMMIT");
        return res.status(201).json({
            message: actsAsVendor ? "Product submitted for approval successfully" : "Product added successfully",
            result: result.rows[0]
        });
    }
    catch (error) {
        await client.query("ROLLBACK");
        if (error instanceof Error) {
            return res.status(400).json({ message: error.message });
        }
        console.error("Error while adding Products : ", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
    finally {
        client.release();
    }
}

export const addVendorProductController = async (req: Request, res: Response): Promise<Response> => {
    const { productVariantId, price, moq, stockQuantity, quotationEnabled, quotationMinQty, gstPercentage, discountedPrice } = req.body;
    let productId = req.body.productId;
    const { userId, role } = (req as any).user;

    if ((!productVariantId && !productId) || price === undefined || !moq || stockQuantity === undefined) {
        return res.status(400).json({ message: "Product Variant ID (or Product ID), price, moq, and stockQuantity are required" });
    }

    const client = await pool.connect();
    try {
        const vendorProfile = await getVendorProfileIfExists(userId);
        if (role !== "vendor" && !vendorProfile) {
            return res.status(403).json({ message: "Unauthorized! Only vendors can add pricing/stock to products." });
        }

        const vendor = await getApprovedVendorProfile(userId);
        const vendorId = vendor.id;

        await client.query("BEGIN");

        let resolvedVariantId = productVariantId;

        // If no variant ID is provided, look up or create the default variant for the product
        if (!resolvedVariantId) {
            const variantRes = await client.query(
                `SELECT id FROM product_variants WHERE product_id = $1 AND properties = '{}'::jsonb LIMIT 1`,
                [productId]
            );
            if (variantRes.rows.length > 0) {
                resolvedVariantId = variantRes.rows[0].id;
            } else {
                // Create default variant
                const insertVariantRes = await client.query(
                    `INSERT INTO product_variants (product_id, properties, approval_status, is_active)
                     VALUES ($1, '{}'::jsonb, 'approved', true) RETURNING id`,
                    [productId]
                );
                resolvedVariantId = insertVariantRes.rows[0].id;
            }
        } else {
            // Fetch product ID from the variant to keep vendor_products record aligned
            const variantRes = await client.query(
                `SELECT product_id FROM product_variants WHERE id = $1`,
                [resolvedVariantId]
            );
            if (variantRes.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Product variant not found." });
            }
            productId = variantRes.rows[0].product_id;
        }

        const productResult = await client.query(
            `SELECT id, approval_status, created_by_user_id, quotation_limit FROM products WHERE id = $1`,
            [productId]
        );

        if (productResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Product not found." });
        }

        const product = productResult.rows[0];
        const canAttachPendingOwnProduct =
            product.approval_status === "pending" && product.created_by_user_id === userId;

        if (product.approval_status !== "approved" && !canAttachPendingOwnProduct) {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "You can only add pricing for approved products or your own pending submission." });
        }

        // Validate: vendor stock must be >= product quotation_limit to opt in for quotations
        if (Boolean(quotationEnabled) && product.quotation_limit) {
            if (Number(stockQuantity) < Number(product.quotation_limit)) {
                await client.query("ROLLBACK");
                return res.status(400).json({
                    message: `To enable quotations, your stock (${stockQuantity}) must be at least the product's quotation limit (${product.quotation_limit}).`
                });
            }
        }

        const resolvedGst = gstPercentage !== undefined ? Number(gstPercentage) : 0.00;

        const query = `
            INSERT INTO vendor_products (product_id, product_variant_id, vendor_id, price, moq, stock_quantity, quotation_enabled, quotation_min_qty, is_active, status, gst_percentage, discounted_price)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, 'waiting', $9, $10)
            ON CONFLICT (vendor_id, product_variant_id)
            DO UPDATE SET
                product_id = EXCLUDED.product_id,
                price = EXCLUDED.price,
                moq = EXCLUDED.moq,
                stock_quantity = EXCLUDED.stock_quantity,
                quotation_enabled = EXCLUDED.quotation_enabled,
                quotation_min_qty = EXCLUDED.quotation_min_qty,
                gst_percentage = EXCLUDED.gst_percentage,
                discounted_price = EXCLUDED.discounted_price,
                is_active = FALSE,
                status = 'waiting'
            RETURNING *`;
        const values = [productId, resolvedVariantId, vendorId, price, moq, stockQuantity, Boolean(quotationEnabled), quotationMinQty ?? null, resolvedGst, discountedPrice !== undefined && discountedPrice !== null ? Number(discountedPrice) : null];
        const result = await client.query(query, values);

        await client.query("COMMIT");
        return res.status(201).json({ message: "Vendor product details saved successfully", result: result.rows[0] });
    }
    catch (error) {
        await client.query("ROLLBACK");
        console.error("Error while saving Vendor Product details : ", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
    finally {
        client.release();
    }
};

export const addProductSpecificationsController = async (req: Request, res: Response): Promise<Response> => {
    const { productId, specifications } = req.body;
    const { userId, role } = (req as any).user;

    if (!productId || !specifications) {
        return res.status(400).json({ message: "productId and specifications are required" });
    }

    try {
        // Ensure product exists
        const productResult = await pool.query(`SELECT id, approval_status FROM products WHERE id = $1`, [productId]);
        if (productResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found." });
        }

        const actsAsVendor = role === "vendor";
        const parsedSpecifications = normalizeSpecificationEntries(specifications, actsAsVendor ? "pending" : "approved");

        if (parsedSpecifications.length === 0) {
            return res.status(400).json({ message: "No valid specifications provided." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            for (const specification of parsedSpecifications) {
                await client.query(
                    `INSERT INTO product_specification (product_id, spec_key, spec_value, approval_status, created_by_user_id)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [productId, specification.spec_key, specification.spec_value, specification.approval_status, userId]
                );
            }

            await client.query("COMMIT");
            return res.status(201).json({ message: actsAsVendor ? "Specifications submitted for approval" : "Specifications added successfully" });
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("Error inserting product specifications:", err);
            return res.status(500).json({ message: "Internal Server Error" });
        } finally {
            client.release();
        }
    }
    catch (error) {
        console.error("Error while adding product specifications : ", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const deleteProduct = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.body;
    const { role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (role !== "admin" && role !== "super_admin") {
        return res.status(403).json({ message: "Unauthorized! Only admins and super admins can delete products." });
    }

    try {
        const query = `DELETE FROM products WHERE id = $1`;
        const values = [productId];
        const result = await pool.query(query, values);
        return res.status(200).json({ message: "Product deleted successfully", result });
    }
    catch (error) {
        console.error("Error while deleting Products : ", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const updateProduct = async (req: Request, res: Response): Promise<Response> => {
    const { productId, name, description, category, productType, material, grade, application, standard, attributes } = req.body;
    const { role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (role !== "admin" && role !== "super_admin") {
        return res.status(403).json({ message: "Unauthorized! Only admins and super admins can update products." });
    }

    try {
        const existingResult = await pool.query(`SELECT attributes FROM products WHERE id = $1`, [productId]);
        if (existingResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        const existingAttributes = existingResult.rows[0].attributes || {};
        const newAttributes = { ...existingAttributes };

        if (attributes && typeof attributes === 'object') {
            Object.entries(attributes).forEach(([key, val]) => {
                newAttributes[key.trim()] = String(val).trim();
            });
        }
        if (material !== undefined) {
            if (material === null || material === "") delete newAttributes.material;
            else newAttributes.material = String(material).trim();
        }
        if (grade !== undefined) {
            if (grade === null || grade === "") delete newAttributes.grade;
            else newAttributes.grade = String(grade).trim();
        }
        if (application !== undefined) {
            if (application === null || application === "") delete newAttributes.application;
            else newAttributes.application = String(application).trim();
        }
        if (standard !== undefined) {
            if (standard === null || standard === "") delete newAttributes.standard;
            else newAttributes.standard = String(standard).trim();
        }

        const query = `UPDATE products SET name = $1, description = $2, category = $3, product_type = $4, attributes = $5 WHERE id = $6`;
        const values = [name, description, category, productType, JSON.stringify(newAttributes), productId];
        const result = await pool.query(query, values);

        // Sync newAttributes into product_specification table
        for (const [key, val] of Object.entries(newAttributes)) {
            const specKey = String(key).trim();
            const specVal = String(val).trim();
            if (specKey && specVal) {
                const checkRes = await pool.query(
                    `SELECT id FROM product_specification WHERE product_id = $1 AND LOWER(spec_key) = LOWER($2)`,
                    [productId, specKey]
                );
                if (checkRes.rows.length > 0) {
                    await pool.query(
                        `UPDATE product_specification SET spec_value = $1, approval_status = 'approved' WHERE id = $2`,
                        [specVal, checkRes.rows[0].id]
                    );
                } else {
                    await pool.query(
                        `INSERT INTO product_specification (product_id, spec_key, spec_value, approval_status, created_by_user_id)
                         VALUES ($1, $2, $3, 'approved', $4)`,
                        [productId, specKey, specVal, (req as any).user.userId]
                    );
                }
            }
        }

        return res.status(200).json({ message: "Product updated successfully", result });
    }
    catch (error) {
        console.error("Error while updating Products : ", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getAllProducts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { offset, limit, search, category, subcategory, productType, brand } = req.query;
        if (offset === undefined || offset === null || isNaN(Number(offset))) {
            return res.status(400).json({ message: "Invalid offset value" });
        }
        const limitValue = Number(limit) > 20 ? 20 : Number(limit) || 20;
        const offsetValue = Number(offset) * limitValue;

        let baseQuery = `
            SELECT p.id, p.name, p.description, p.category, p.product_type
            FROM products p
            WHERE p.approval_status = 'approved' AND p.is_active = TRUE
              AND EXISTS (
                  SELECT 1
                  FROM vendor_products vp
                  JOIN vendors v ON v.id = vp.vendor_id
                  JOIN users u ON u.id = v.user_id
                  WHERE vp.product_id = p.id
                    AND vp.is_active = true
                    AND v.approval_status = 'approved'
                    AND v.is_active = true
                    AND v.is_blocked = false
                    AND u.is_active = true
              )
        `;
        let countQuery = `
            SELECT COUNT(*) AS total
            FROM products p
            WHERE p.approval_status = 'approved' AND p.is_active = TRUE
              AND EXISTS (
                  SELECT 1
                  FROM vendor_products vp
                  JOIN vendors v ON v.id = vp.vendor_id
                  JOIN users u ON u.id = v.user_id
                  WHERE vp.product_id = p.id
                    AND vp.is_active = true
                    AND v.approval_status = 'approved'
                    AND v.is_active = true
                    AND v.is_blocked = false
                    AND u.is_active = true
              )
        `;

        const values: any[] = [];
        let paramCount = 1;

        if (search && typeof search === 'string' && search.trim() !== '') {
            baseQuery += ` AND (
                p.name ILIKE $${paramCount}
                OR COALESCE(p.item_code, '') ILIKE $${paramCount}
                OR COALESCE(p.attributes->>'brand', '') ILIKE $${paramCount}
            )`;
            countQuery += ` AND (
                p.name ILIKE $${paramCount}
                OR COALESCE(p.item_code, '') ILIKE $${paramCount}
                OR COALESCE(p.attributes->>'brand', '') ILIKE $${paramCount}
            )`;
            values.push(`%${search.trim()}%`);
            paramCount++;
        }

        if (category && typeof category === 'string' && category.trim() !== '') {
            baseQuery += ` AND EXISTS (
                SELECT 1
                FROM product_category pc_filter
                WHERE pc_filter.is_active = TRUE
                  AND LOWER(pc_filter.code) = LOWER($${paramCount})
                  AND (p.category::text = pc_filter.id::text OR p.category::text = pc_filter.code)
            )`;
            countQuery += ` AND EXISTS (
                SELECT 1
                FROM product_category pc_filter
                WHERE pc_filter.is_active = TRUE
                  AND LOWER(pc_filter.code) = LOWER($${paramCount})
                  AND (p.category::text = pc_filter.id::text OR p.category::text = pc_filter.code)
            )`;
            values.push(category.trim());
            paramCount++;
        }

        if (subcategory && typeof subcategory === 'string' && subcategory.trim() !== '') {
            baseQuery += ` AND (p.subcategory_id::text = $${paramCount} OR EXISTS (SELECT 1 FROM subcategories ps2 WHERE ps2.id = p.subcategory_id AND LOWER(ps2.name) = LOWER($${paramCount})))`;
            countQuery += ` AND (p.subcategory_id::text = $${paramCount} OR EXISTS (SELECT 1 FROM subcategories ps2 WHERE ps2.id = p.subcategory_id AND LOWER(ps2.name) = LOWER($${paramCount})))`;
            values.push(subcategory.trim());
            paramCount++;
        }

        if (productType && typeof productType === 'string' && productType.trim() !== '') {
            baseQuery += ` AND p.product_type = $${paramCount}`;
            countQuery += ` AND p.product_type = $${paramCount}`;
            values.push(productType.trim());
            paramCount++;
        }

        if (brand && typeof brand === 'string' && brand.trim() !== '') {
            baseQuery += ` AND COALESCE(p.attributes->>'brand', '') ILIKE $${paramCount}`;
            countQuery += ` AND COALESCE(p.attributes->>'brand', '') ILIKE $${paramCount}`;
            values.push(brand.trim());
            paramCount++;
        }

        baseQuery += ` ORDER BY p.created_at DESC, p.id ASC LIMIT $${paramCount + 1} OFFSET $${paramCount}`;

        // Snapshot count values (without offset/limit) BEFORE appending pagination params
        const countValues = [...values];
        const queryValues = [...values, offsetValue, limitValue];

        const query = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.description,
                pc.code AS category,
                pc.label AS category_label,
                p.subcategory_id,
                psub.name AS subcategory_name,
                p.product_type,
                p.item_code AS product_code,
                p.attributes->>'brand' AS brand,
                COALESCE(
                    NULLIF(p.attributes->>'unit', ''),
                    NULLIF(p.attributes->>'uom', ''),
                    NULLIF(p.attributes->>'unit_of_measure', ''),
                    NULLIF(specAgg.specifications->>'Unit', ''),
                    NULLIF(specAgg.specifications->>'unit', ''),
                    'Unit'
                ) AS unit,
                ${approvedSpecificationsSelect},

                -- Primary image
                pImg.image_url AS primary_image,

                -- Seller count (cast to int)
                COALESCE(vc.vendor_count, 0)::int AS seller_count,

                -- Price range (cast to numeric)
                COALESCE(pr.min_price, 0)::numeric AS min_price,
                COALESCE(pr.max_price, 0)::numeric AS max_price,
                COALESCE(pr.min_original_price, 0)::numeric AS min_original_price,
                COALESCE(pr.max_original_price, 0)::numeric AS max_original_price,
                COALESCE(pr.min_moq, 1)::int AS min_moq

            FROM (
                ${baseQuery}
            ) p

            ${approvedSpecificationsJoin}

            LEFT JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)
            LEFT JOIN subcategories psub ON psub.id = p.subcategory_id

            -- Primary image (no duplication)
            LEFT JOIN products_images pImg 
                ON p.id = pImg.product_id 
                AND pImg.is_primary = true
                AND pImg.approval_status = 'approved'

            -- Vendor count (lightweight aggregation)
            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT vendor_id)::int AS vendor_count
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) vc ON true

            -- Price range from vendor_products
            LEFT JOIN LATERAL (
                SELECT 
                    MIN(COALESCE(vp.discounted_price, vp.price))::numeric AS min_price, 
                    MAX(COALESCE(vp.discounted_price, vp.price))::numeric AS max_price,
                    MIN(vp.price)::numeric AS min_original_price,
                    MAX(vp.price)::numeric AS max_original_price,
                    MIN(moq)::int AS min_moq
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) pr ON true;
        `;

        const result = await pool.query(query, queryValues);
        for (const row of result.rows) {
            row.primary_image = await getPresignedUrlOrOriginal(row.primary_image);
        }
        const countResult = await pool.query(countQuery, countValues);
        const totalCount = countResult.rows[0].total_count;
        return res.status(200).json({ message: "Products fetched successfully", totalCount, data: result.rows });
    }
    catch (e) {
        console.error("Error while fetching Products : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const getProductById = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    const isFromVendor = req.headers["x-request-from"] === "vendor";
    const approvalCondition = isFromVendor
        ? "p.approval_status != 'rejected'"
        : "p.approval_status = 'approved' AND p.is_active = TRUE";

    const specApprovalCondition = isFromVendor
        ? "ps.approval_status != 'rejected'"
        : "ps.approval_status = 'approved'";

    const dynamicSpecificationsJoin = `
            LEFT JOIN LATERAL (
                SELECT COALESCE(
                    jsonb_object_agg(ps.spec_key, ps.spec_value ORDER BY ps.created_at),
                    '{}'::jsonb
                ) AS specifications
                FROM product_specification ps
                WHERE ps.product_id = p.id
                  AND ${specApprovalCondition}
            ) specAgg ON true
        `;

    try {
        const productQuery = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.description,
                pc.code AS category,
                pc.label AS category_name,
                p.subcategory_id,
                psub.name AS subcategory_name,
                p.product_type,
                p.item_code AS product_code,
                p.attributes,
                p.attributes->>'brand' AS brand,
                p.attributes->>'material' AS material,
                p.attributes->>'grade' AS grade,
                p.attributes->>'application' AS application,
                p.attributes->>'standard' AS standard,
                COALESCE(
                    NULLIF(p.attributes->>'unit', ''),
                    NULLIF(p.attributes->>'uom', ''),
                    NULLIF(p.attributes->>'unit_of_measure', ''),
                    NULLIF(specAgg.specifications->>'Unit', ''),
                    NULLIF(specAgg.specifications->>'unit', ''),
                    'Unit'
                ) AS unit,
                p.rating,
                p.review_count,
                p.quotation_limit,
                p.vendor_can_set_quotation_limit,
                COALESCE(specAgg.specifications, '{}'::jsonb) AS specifications
            FROM products p
            LEFT JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)
            LEFT JOIN subcategories psub ON psub.id = p.subcategory_id
            ${dynamicSpecificationsJoin}
            WHERE p.id = $1 AND ${approvalCondition}
        `;
        const productRes = await pool.query(productQuery, [productId]);
        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        const product = productRes.rows[0];

        // Fetch images
        const imagesApprovalCondition = isFromVendor
            ? "approval_status != 'rejected'"
            : "approval_status = 'approved'";
        const imagesQuery = `
            SELECT image_url, is_primary, display_order, media_type, product_variant_id
            FROM products_images
            WHERE product_id = $1 AND ${imagesApprovalCondition}
            ORDER BY display_order ASC
        `;
        const imagesRes = await pool.query(imagesQuery, [productId]);
        for (const img of imagesRes.rows) {
            img.image_url = await getPresignedUrlOrOriginal(img.image_url);
        }
        product.images = imagesRes.rows;

        // Fetch variants
        const variantApprovalCondition = isFromVendor
            ? "approval_status != 'rejected'"
            : "(approval_status = 'approved' AND is_active = TRUE) OR (id IN (SELECT DISTINCT product_variant_id FROM vendor_products WHERE product_id = $1 AND is_active = true))";
        const variantsQuery = `
            SELECT
                id AS variant_id,
                sku,
                name AS variant_name,
                properties,
                properties->>'modelNo' AS model_no,
                properties->>'model_no' AS model_no_alt,
                properties->>'size' AS size,
                properties->>'variant' AS variant_label,
                approval_status
            FROM product_variants
            WHERE product_id = $1 AND (${variantApprovalCondition})
            ORDER BY created_at ASC
        `;
        const variantsRes = await pool.query(variantsQuery, [productId]);
        const variants = variantsRes.rows.map((variant) => ({
            ...variant,
            model_no: variant.model_no || variant.model_no_alt || readVariantProperty(variant.properties, ["modelNo", "model_no", "model", "model number", "modelNumber"]),
            size: variant.size || readVariantProperty(variant.properties, ["size", "dimension", "dimensions"]),
            variant_label: variant.variant_label || readVariantProperty(variant.properties, ["variant", "color", "type", "finish", "grade"]),
        }));

        // For each variant, fetch the associated vendor products
        for (const variant of variants) {
            const vendorsQuery = `
                SELECT 
                    vp.id AS vendor_product_id,
                    v.id AS vendor_id,
                    vp.product_variant_id,
                    v.company_name AS vendor_name,
                    vp.price,
                    vp.discounted_price,
                    vp.moq,
                    vp.stock_quantity,
                    vp.quotation_enabled,
                    vp.quotation_min_qty,
                    vp.gst_percentage,
                    v.rating,
                    v.review_count,
                    va.latitude,
                    va.longitude,
                    va.city,
                    va.state
                FROM vendor_products vp
                JOIN vendors v ON vp.vendor_id = v.id
                JOIN users u ON v.user_id = u.id
                LEFT JOIN addresses va ON v.user_id = va.user_id
                WHERE vp.product_variant_id = $1
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
                ORDER BY vp.price ASC
            `;
            const vendorsRes = await pool.query(vendorsQuery, [variant.variant_id]);
            variant.vendors = vendorsRes.rows.map(normalizeOffer);
        }

        product.variants = variants;

        if (variants.length === 0) {
            const fallbackVendorsQuery = `
                SELECT 
                    vp.id AS vendor_product_id,
                    v.id AS vendor_id,
                    vp.product_variant_id,
                    v.company_name AS vendor_name,
                    vp.price,
                    vp.discounted_price,
                    vp.moq,
                    vp.stock_quantity,
                    vp.quotation_enabled,
                    vp.quotation_min_qty,
                    vp.gst_percentage,
                    v.rating,
                    v.review_count,
                    va.latitude,
                    va.longitude,
                    va.city,
                    va.state
                FROM vendor_products vp
                JOIN vendors v ON vp.vendor_id = v.id
                JOIN users u ON v.user_id = u.id
                LEFT JOIN addresses va ON v.user_id = va.user_id
                WHERE vp.product_id = $1
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
                ORDER BY vp.price ASC
            `;
            const fallbackVendorsRes = await pool.query(fallbackVendorsQuery, [productId]);
            product.vendors = fallbackVendorsRes.rows.map(normalizeOffer);
        } else {
            // Provide a flat list of all vendors across all variants for fallback/legacy compatibility
            const allVendors: any[] = [];
            const vendorIdsSeen = new Set<string>();
            for (const variant of variants) {
                for (const vendor of variant.vendors) {
                    const vendorKey = `${vendor.vendor_id}-${vendor.product_variant_id || variant.variant_id}`;
                    if (!vendorIdsSeen.has(vendorKey)) {
                        vendorIdsSeen.add(vendorKey);
                        allVendors.push(vendor);
                    }
                }
            }
            product.vendors = allVendors;
        }

        return res.status(200).json({ message: "Product fetched successfully", data: product });
    }
    catch (e) {
        console.error("Error while fetching Product by Id : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getCategories = async (req: Request, res: Response): Promise<Response> => {
    const { type } = req.query;
    try {
        let query = `
             SELECT id, code, label, description, image, min_commision_percentage, max_commision_percentage, sort_order, category_type
             FROM product_category
             WHERE is_active = TRUE
        `;
        const params: any[] = [];
        if (type === 'service') {
            query += ` AND category_type IN ('service', 'both')`;
        } else if (type === 'product') {
            query += ` AND category_type IN ('product', 'both')`;
        }
        query += ` ORDER BY sort_order ASC, label ASC`;

        const result = await pool.query(query, params);
        for (const row of result.rows) {
            const originalImage = typeof row.image === "string" ? row.image.trim() : "";
            if (
                !originalImage
                || /^[a-z]:[\\/]/i.test(originalImage)
                || originalImage.startsWith("file:")
            ) {
                row.image = null;
                continue;
            }
            const resolvedImage = await getPresignedUrlOrOriginal(row.image);
            row.image = typeof resolvedImage === "string" && /^https?:\/\//i.test(resolvedImage)
                ? resolvedImage
                : null;
        }
        return res.status(200).json({ message: "Categories fetched successfully", data: result.rows });
    } catch (e) {
        console.error("Error while fetching categories: ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getProductsByCategory = async (req: Request, res: Response): Promise<Response> => {
    const { category } = req.params;
    const { offset, limit, search, subcategory, productType } = req.query;
    const limitValue = Number(limit) > 20 ? 20 : Number(limit) || 20;
    const offsetValue = Number(offset) * limitValue;

    try {
        if (!category || typeof category !== "string")
            return res.status(400).json({ message: "Category is required" });

        // Validate against the product_category table dynamically
        const categoryCheck = await pool.query(
            `SELECT id FROM product_category WHERE LOWER(code) = LOWER($1) AND is_active = TRUE`,
            [category]
        );
        if (categoryCheck.rows.length === 0)
            return res.status(400).json({ message: "Invalid category! Please provide a valid active category." });

        if (offset === undefined || offset === null || isNaN(Number(offset)))
            return res.status(400).json({ message: "Invalid offset value" });

        // Build dynamic filter conditions
        const filterValues: any[] = [category.trim()];
        let filterConditions = `EXISTS (
            SELECT 1
            FROM product_category pc
            WHERE pc.is_active = TRUE
              AND LOWER(pc.code) = LOWER($1)
              AND (category::text = pc.id::text OR category::text = pc.code)
        ) AND approval_status = 'approved' AND is_active = TRUE
          AND EXISTS (
              SELECT 1
              FROM vendor_products vp
              JOIN vendors v ON v.id = vp.vendor_id
              JOIN users u ON u.id = v.user_id
              WHERE vp.product_id = products.id
                AND vp.is_active = true
                AND v.approval_status = 'approved'
                AND v.is_active = true
                AND v.is_blocked = false
                AND u.is_active = true
          )`;
        let paramCount = 2;

        if (search && typeof search === 'string' && search.trim() !== '') {
            filterConditions += ` AND (
                name ILIKE $${paramCount}
                OR COALESCE(item_code, '') ILIKE $${paramCount}
                OR COALESCE(attributes->>'brand', '') ILIKE $${paramCount}
            )`;
            filterValues.push(`%${search.trim()}%`);
            paramCount++;
        }

        if (subcategory && typeof subcategory === 'string' && subcategory.trim() !== '') {
            filterConditions += ` AND (subcategory_id::text = $${paramCount} OR EXISTS (SELECT 1 FROM subcategories ps WHERE ps.id = products.subcategory_id AND LOWER(ps.name) = LOWER($${paramCount})))`;
            filterValues.push(subcategory.trim());
            paramCount++;
        }

        if (productType && typeof productType === 'string' && productType.trim() !== '') {
            filterConditions += ` AND product_type = $${paramCount}`;
            filterValues.push(productType.trim());
            paramCount++;
        }

        const offsetParam = paramCount;
        const limitParam = paramCount + 1;
        const queryValues = [...filterValues, offsetValue, limitValue];

        const query = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.description,
                pc.code AS category,
                pc.label AS category_label,
                p.subcategory_id,
                psub.name AS subcategory_name,
                p.product_type,
                p.item_code AS product_code,
                p.attributes->>'brand' AS brand,
                ${approvedSpecificationsSelect},

                -- Primary image
                pImg.image_url AS primary_image,

                -- Vendor count (optimized, cast to int)
                COALESCE(vc.vendor_count, 0)::int AS vendor_count,

                -- Seller count alias for frontend compatibility
                COALESCE(vc.vendor_count, 0)::int AS seller_count,

                -- Price range (cast to numeric)
                COALESCE(pr.min_price, 0)::numeric AS min_price,
                COALESCE(pr.max_price, 0)::numeric AS max_price,
                COALESCE(pr.min_original_price, 0)::numeric AS min_original_price,
                COALESCE(pr.max_original_price, 0)::numeric AS max_original_price,
                COALESCE(pr.min_moq, 1)::int AS min_moq

            FROM (
                SELECT id, name, description, category, product_type
                FROM products
                WHERE ${filterConditions}
                ORDER BY created_at DESC, id ASC
                LIMIT $${limitParam} OFFSET $${offsetParam}
            ) p

            ${approvedSpecificationsJoin}

            LEFT JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)
            LEFT JOIN subcategories psub ON psub.id = p.subcategory_id

            -- Primary image (no duplication)
            LEFT JOIN products_images pImg 
                ON p.id = pImg.product_id 
                AND pImg.is_primary = true
                AND pImg.approval_status = 'approved'

            -- Vendor count (ONLY for selected products)
            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT vendor_id)::int AS vendor_count
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) vc ON true

            -- Price range from vendor_products
            LEFT JOIN LATERAL (
                SELECT 
                    MIN(COALESCE(vp.discounted_price, vp.price))::numeric AS min_price, 
                    MAX(COALESCE(vp.discounted_price, vp.price))::numeric AS max_price,
                    MIN(vp.price)::numeric AS min_original_price,
                    MAX(vp.price)::numeric AS max_original_price,
                    MIN(moq)::int AS min_moq
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) pr ON true;
        `;

        const result = await pool.query(query, queryValues);
        for (const row of result.rows) {
            row.primary_image = await getPresignedUrlOrOriginal(row.primary_image);
        }
        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total_count FROM products WHERE ${filterConditions}`,
            filterValues
        );
        const totalCount = countResult.rows[0].total_count;
        return res.status(200).json({ message: "Products fetched successfully", totalCount, data: result.rows });
    }
    catch (e) {
        console.error("Error while fetching Product by category : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

export const getProductByName = async (req: Request, res: Response): Promise<Response> => {
    const { name } = req.query;
    const { offset, limit } = req.query;

    if (!name || typeof name !== "string") {
        return res.status(400).json({ message: "Product name is required and should be a string" });
    }

    const limitValue = Number(limit) > 20 ? 20 : Number(limit) || 20;
    const offsetValue = offset ? Number(offset) * limitValue : 0;

    const isFromVendor = req.headers["x-request-from"] === "vendor";
    const approvalCondition = isFromVendor
        ? "approval_status != 'rejected'"
        : "approval_status = 'approved' AND is_active = TRUE";

    const imageApprovalCondition = isFromVendor
        ? "pImg.approval_status != 'rejected'"
        : "pImg.approval_status = 'approved'";

    const specApprovalCondition = isFromVendor
        ? "ps.approval_status != 'rejected'"
        : "ps.approval_status = 'approved'";

    const dynamicSpecificationsJoin = `
            LEFT JOIN LATERAL (
                SELECT COALESCE(
                    jsonb_object_agg(ps.spec_key, ps.spec_value ORDER BY ps.created_at),
                    '{}'::jsonb
                ) AS specifications
                FROM product_specification ps
                WHERE ps.product_id = p.id
                  AND ${specApprovalCondition}
            ) specAgg ON true
        `;

    try {
        //fuzzy search using ILIKE for case-insensitive partial matching
        const query = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.description,
                pc.code AS category,
                p.product_type,
                COALESCE(specAgg.specifications, '{}'::jsonb) AS specifications,

                pImg.image_url AS primary_image,

                COALESCE(vc.vendor_count, 0)::int AS vendor_count

            FROM (
                SELECT id, name, description, category, product_type
                FROM products
                WHERE name ILIKE $1
                  AND ${approvalCondition}
                ORDER BY created_at DESC, id ASC
                LIMIT $3 OFFSET $2
            ) p

            ${dynamicSpecificationsJoin}

            LEFT JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)

            LEFT JOIN products_images pImg 
                ON p.id = pImg.product_id 
                AND pImg.is_primary = true
                AND ${imageApprovalCondition}

            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT vendor_id)::int AS vendor_count
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) vc ON true;
        `;
        const result = await pool.query(query, [`%${name}%`, offsetValue, limitValue]);
        for (const row of result.rows) {
            row.primary_image = await getPresignedUrlOrOriginal(row.primary_image);
        }
        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total_count FROM products WHERE name ILIKE $1 AND ${approvalCondition}`,
            [`%${name}%`]
        );
        const totalCount = countResult.rows[0].total_count;
        return res.status(200).json({ message: "Product fetched successfully", totalCount, data: result.rows });
    }
    catch (e) {
        console.error("Error while fetching Product by name : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getVendorProductsController = async (req: Request, res: Response): Promise<Response> => {
    const { userId, role } = (req as any).user;
    const { search, category, productType, status } = req.query;

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their products." });
    }

    try {
        const vendorResult = await pool.query(
            `
                SELECT id, approval_status, approval_notes, is_active, is_blocked
                FROM vendors
                WHERE user_id = $1
            `,
            [userId]
        );

        if (vendorResult.rows.length === 0) {
            return res.status(403).json({ message: "Please setup your profile first! Go to Profile -> Setup Profile to complete your registration." });
        }

        const vendor = vendorResult.rows[0];
        const vendorId = vendor.id;

        let query = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.category,
                p.product_type,
                (SELECT image_url FROM products_images WHERE product_id = p.id AND is_primary = true LIMIT 1) AS primary_image,
                p.approval_status,
                p.approval_notes,
                MIN(vp.created_at) AS created_date,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'vendor_product_id', vp.id,
                        'product_variant_id', vp.product_variant_id,
                        'price', vp.price,
                        'pending_price', vp.pending_price,
                        'moq', vp.moq,
                        'stock_quantity', vp.stock_quantity,
                        'is_active', vp.is_active,
                        'status', vp.status,
                        'gst_percentage', vp.gst_percentage,
                        'properties', pv.properties,
                        'sku', pv.sku,
                        'name', pv.name
                    ) ORDER BY pv.created_at ASC
                ) AS variants
            FROM vendor_products vp
            JOIN products p ON vp.product_id = p.id
            JOIN product_variants pv ON vp.product_variant_id = pv.id
            WHERE vp.vendor_id = $1
        `;

        const values: any[] = [vendorId];
        let paramCount = 2;

        if (search && typeof search === 'string' && search.trim() !== '') {
            query += ` AND p.name ILIKE $${paramCount}`;
            values.push(`%${search.trim()}%`);
            paramCount++;
        }

        if (category && typeof category === 'string' && category.trim() !== '') {
            const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
            let categoryId = category.trim();
            if (!uuidRegex.test(categoryId)) {
                const catCheck = await pool.query(
                    `SELECT id FROM product_category WHERE LOWER(code) = LOWER($1)`,
                    [categoryId]
                );
                if (catCheck.rows.length > 0) {
                    categoryId = catCheck.rows[0].id;
                } else {
                    categoryId = "00000000-0000-0000-0000-000000000000";
                }
            }
            query += ` AND p.category = $${paramCount}`;
            values.push(categoryId);
            paramCount++;
        }

        if (productType && typeof productType === 'string' && productType.trim() !== '') {
            query += ` AND p.product_type = $${paramCount}`;
            values.push(productType.trim());
            paramCount++;
        }

        if (status && typeof status === 'string' && status.trim() !== '') {
            const isActiveFilter = status.trim() === 'active';
            if (isActiveFilter) {
                query += ` AND vp.is_active = TRUE AND p.approval_status = 'approved'`;
            } else {
                query += ` AND (vp.is_active = FALSE OR p.approval_status != 'approved')`;
            }
        }

        query += ` GROUP BY p.id, p.name, p.category, p.product_type, p.approval_status, p.approval_notes`;
        query += ` ORDER BY MIN(vp.created_at) DESC`;

        const result = await pool.query(query, values);
        for (const row of result.rows) {
            row.primary_image = await getPresignedUrlOrOriginal(row.primary_image);
        }
        return res.status(200).json({ message: "Vendor products fetched successfully", data: result.rows });
    } catch (error) {
        console.error("Error while fetching vendor products : ", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export const getRankedVendors = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { userLat, userLng } = req.query;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    const parsedLat = Number(userLat);
    const parsedLng = Number(userLng);

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
        return res.status(400).json({ message: "Valid userLat and userLng query parameters are required" });
    }

    try {
        const variantId = req.query.variantId as string | undefined;
        let query;
        let queryParams;
        if (variantId) {
            query = `
                SELECT
                    vp.id AS vendor_product_id,
                    v.id AS vendor_id,
                    vp.product_variant_id,
                    v.company_name AS vendor_name,
                    vp.price,
                    vp.discounted_price,
                    vp.moq,
                    vp.stock_quantity,
                    vp.quotation_enabled,
                    vp.quotation_min_qty,
                    vp.gst_percentage,
                    v.rating,
                    v.review_count,
                    va.latitude,
                    va.longitude,
                    va.city,
                    va.state
                FROM vendor_products vp
                JOIN vendors v ON vp.vendor_id = v.id
                JOIN users u ON v.user_id = u.id
                LEFT JOIN addresses va ON v.user_id = va.user_id
                WHERE vp.product_variant_id = $1
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            `;
            queryParams = [variantId];
        } else {
            query = `
                SELECT
                    vp.id AS vendor_product_id,
                    v.id AS vendor_id,
                    vp.product_variant_id,
                    v.company_name AS vendor_name,
                    vp.price,
                    vp.discounted_price,
                    vp.moq,
                    vp.stock_quantity,
                    vp.quotation_enabled,
                    vp.quotation_min_qty,
                    vp.gst_percentage,
                    v.rating,
                    v.review_count,
                    va.latitude,
                    va.longitude,
                    va.city,
                    va.state
                FROM vendor_products vp
                JOIN vendors v ON vp.vendor_id = v.id
                JOIN users u ON v.user_id = u.id
                LEFT JOIN addresses va ON v.user_id = va.user_id
                WHERE vp.product_id = $1
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            `;
            queryParams = [productId];
        }
        const result = await pool.query(query, queryParams);

        const vendors = result.rows.map((row) => {
            const originalPrice = Number(row.price) || 0;
            const discountedPrice = row.discounted_price !== null ? Number(row.discounted_price) : null;
            const price = discountedPrice !== null && discountedPrice < originalPrice ? discountedPrice : originalPrice;
            const rating = Number(row.rating) || 0;
            const reviewCount = Number(row.review_count) || 0;
            const vendorLat = row.latitude !== null ? Number(row.latitude) : null;
            const vendorLng = row.longitude !== null ? Number(row.longitude) : null;

            let distance: number | null = null;
            if (vendorLat !== null && vendorLng !== null) {
                distance = haversineDistance(parsedLat, parsedLng, vendorLat, vendorLng);
            }

            return {
                vendor_product_id: row.vendor_product_id,
                vendor_id: row.vendor_id,
                product_variant_id: row.product_variant_id || null,
                vendor_name: row.vendor_name,
                price,
                original_price: originalPrice,
                discounted_price: discountedPrice,
                moq: row.moq,
                stock_quantity: row.stock_quantity,
                quotation_enabled: Boolean(row.quotation_enabled),
                quotation_min_qty: row.quotation_min_qty,
                gst_percentage: row.gst_percentage !== null && row.gst_percentage !== undefined ? Number(row.gst_percentage) : 0,
                rating,
                review_count: reviewCount,
                latitude: vendorLat,
                longitude: vendorLng,
                city: row.city,
                state: row.state,
                distance,
            };
        });

        if (vendors.length === 0) {
            return res.status(200).json({ message: "No vendors found", data: [] });
        }

        const prices = vendors.map((v) => v.price).filter((p) => p > 0);
        const distances = vendors.map((v) => v.distance).filter((d): d is number => d !== null);
        const ratings = vendors.map((v) => v.rating);

        const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
        const minDist = distances.length > 0 ? Math.min(...distances) : 0;
        const maxDist = distances.length > 0 ? Math.max(...distances) : 0;
        const maxRating = ratings.length > 0 ? Math.max(...ratings) : 5;

        const PRICE_WEIGHT = 0.4;
        const DISTANCE_WEIGHT = 0.4;
        const REVIEW_WEIGHT = 0.2;

        const scoredVendors = vendors.map((v) => {
            const priceScore = maxPrice > minPrice ? (maxPrice - v.price) / (maxPrice - minPrice) : 1;
            const distanceScore = v.distance !== null && maxDist > minDist
                ? (maxDist - v.distance) / (maxDist - minDist)
                : v.distance !== null ? 1 : 0.5;
            const reviewScore = maxRating > 0 ? v.rating / maxRating : 0;

            const totalScore = (PRICE_WEIGHT * priceScore) + (DISTANCE_WEIGHT * distanceScore) + (REVIEW_WEIGHT * reviewScore);

            return {
                ...v,
                price_score: Math.round(priceScore * 100) / 100,
                distance_score: Math.round(distanceScore * 100) / 100,
                review_score: Math.round(reviewScore * 100) / 100,
                total_score: Math.round(totalScore * 100) / 100,
            };
        });

        scoredVendors.sort((a, b) => b.total_score - a.total_score);

        scoredVendors.forEach((v, index) => {
            (v as any).rank = index + 1;
        });

        return res.status(200).json({ message: "Ranked vendors fetched successfully", data: scoredVendors });
    } catch (e) {
        console.error("Error while ranking vendors : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getVendorProductByIdController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { userId, role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their products." });
    }

    try {
        const vendorResult = await pool.query(
            `SELECT id, approval_status, is_active, is_blocked FROM vendors WHERE user_id = $1`,
            [userId]
        );

        if (vendorResult.rows.length === 0) {
            return res.status(403).json({ message: "Vendor profile not found." });
        }

        const vendor = vendorResult.rows[0];
        const vendorId = vendor.id;

        const query = `
            SELECT 
                p.id AS product_id,
                p.name AS product_name,
                p.description,
                p.category,
                p.product_type,
                p.attributes,
                p.attributes->>'material' AS material,
                p.attributes->>'grade' AS grade,
                p.attributes->>'application' AS application,
                p.attributes->>'standard' AS standard,
                p.quotation_limit,
                p.vendor_can_set_quotation_limit,
                ${approvedSpecificationsSelect},
                COALESCE(imgAgg.images, '[]'::jsonb) AS images,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'vendor_product_id', vp.id,
                        'product_variant_id', vp.product_variant_id,
                        'price', vp.price,
                        'discounted_price', vp.discounted_price,
                        'pending_price', vp.pending_price,
                        'moq', vp.moq,
                        'stock_quantity', vp.stock_quantity,
                        'is_active', vp.is_active,
                        'status', vp.status,
                        'gst_percentage', vp.gst_percentage,
                        'properties', pv.properties,
                        'sku', pv.sku,
                        'name', pv.name
                    ) ORDER BY pv.created_at ASC
                ) AS variants
            FROM vendor_products vp
            JOIN products p ON vp.product_id = p.id
            JOIN product_variants pv ON vp.product_variant_id = pv.id
            ${approvedSpecificationsJoin}
            LEFT JOIN LATERAL (
                SELECT COALESCE(
                    JSONB_AGG(
                        JSONB_BUILD_OBJECT(
                            'image_url', pi.image_url,
                            'is_primary', pi.is_primary,
                            'display_order', pi.display_order,
                            'media_type', pi.media_type
                        ) ORDER BY pi.display_order ASC, pi.created_at ASC
                    ),
                    '[]'::jsonb
                ) AS images
                FROM products_images pi
                WHERE pi.product_id = p.id
            ) imgAgg ON true
            WHERE vp.vendor_id = $1 AND vp.product_id = $2
            GROUP BY p.id, specAgg.specifications, p.attributes, imgAgg.images
        `;

        const result = await pool.query(query, [vendorId, productId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Product not found or you don't have access to this product." });
        }

        const product = result.rows[0];
        if (product && Array.isArray(product.images)) {
            for (const img of product.images) {
                img.image_url = await getPresignedUrlOrOriginal(img.image_url);
            }
        }

        return res.status(200).json({
            message: "Vendor product fetched successfully",
            data: product
        });
    } catch (error) {
        console.error("Error while fetching vendor product:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const updateVendorProductController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { price, moq, stockQuantity, isActive, quotationEnabled, quotationMinQty, gstPercentage, productVariantId, discountedPrice } = req.body;
    const { userId, role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (price === undefined || moq === undefined || stockQuantity === undefined || isActive === undefined || quotationEnabled === undefined) {
        return res.status(400).json({ message: "Price, MOQ, stock quantity, active status, and quotation enabled are required" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can update their products." });
    }

    try {
        const vendorResult = await pool.query(
            `SELECT id, approval_status, is_active, is_blocked FROM vendors WHERE user_id = $1`,
            [userId]
        );

        if (vendorResult.rows.length === 0) {
            return res.status(403).json({ message: "Vendor profile not found." });
        }

        const vendor = vendorResult.rows[0];
        if (vendor.approval_status !== "approved" || !vendor.is_active || vendor.is_blocked) {
            return res.status(403).json({ message: "Your vendor account must be approved and active to update products." });
        }

        const vendorId = vendor.id;

        let resolvedProductId = productId;
        if (productVariantId) {
            const variantRes = await pool.query(
                `SELECT product_id FROM product_variants WHERE id = $1`,
                [productVariantId]
            );
            if (variantRes.rows.length > 0) {
                resolvedProductId = variantRes.rows[0].product_id;
            }
        }

        // Fetch product quotation_limit for validation
        const productCheck = await pool.query(
            `SELECT quotation_limit FROM products WHERE id = $1`,
            [resolvedProductId]
        );
        if (productCheck.rows.length > 0 && Boolean(quotationEnabled) && productCheck.rows[0].quotation_limit) {
            if (Number(stockQuantity) < Number(productCheck.rows[0].quotation_limit)) {
                return res.status(400).json({
                    message: `To enable quotations, your stock (${stockQuantity}) must be at least the product's quotation limit (${productCheck.rows[0].quotation_limit}).`
                });
            }
        }

        // Check if the vendor product exists
        let existingProductResult;
        if (productVariantId) {
            existingProductResult = await pool.query(
                `SELECT id, status, is_active, price FROM vendor_products WHERE vendor_id = $1 AND product_variant_id = $2`,
                [vendorId, productVariantId]
            );
        } else {
            existingProductResult = await pool.query(
                `SELECT id, status, is_active, price FROM vendor_products WHERE vendor_id = $1 AND product_id = $2`,
                [vendorId, productId]
            );
        }

        if (existingProductResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found or you don't have access to this product." });
        }

        const existingVP = existingProductResult.rows[0];
        const requestedIsActive = Boolean(isActive);

        // Supreme control: vendor cannot set is_active = true if the catalog mapping status is not active (i.e. not approved by admin)
        if (requestedIsActive && existingVP.status !== 'active') {
            return res.status(403).json({
                message: "Cannot activate product listing. Admin approval is required before this product can be listed."
            });
        }

        let updateQuery;
        let queryParams;
        const isPriceChanged = Number(price) !== Number(existingVP.price);
        const requiresApproval = existingVP.status === 'active' && isPriceChanged;

        if (requiresApproval) {
            updateQuery = `
                UPDATE vendor_products 
                SET pending_price = $1,
                    moq = $2,
                    stock_quantity = $3,
                    is_active = $4,
                    quotation_enabled = $5,
                    quotation_min_qty = $6,
                    gst_percentage = COALESCE($7, gst_percentage),
                    discounted_price = $8,
                    updated_at = NOW()
                WHERE vendor_id = $9 AND ${productVariantId ? "product_variant_id" : "product_id"} = $10
                RETURNING *
            `;
            queryParams = [
                Number(price),
                Number(moq),
                Number(stockQuantity),
                requestedIsActive,
                Boolean(quotationEnabled),
                quotationMinQty ?? null,
                gstPercentage !== undefined ? Number(gstPercentage) : null,
                discountedPrice !== undefined && discountedPrice !== null ? Number(discountedPrice) : null,
                vendorId,
                productVariantId || productId
            ];
        } else {
            updateQuery = `
                UPDATE vendor_products 
                SET price = $1,
                    pending_price = NULL,
                    moq = $2,
                    stock_quantity = $3,
                    is_active = $4,
                    quotation_enabled = $5,
                    quotation_min_qty = $6,
                    gst_percentage = COALESCE($7, gst_percentage),
                    discounted_price = $8,
                    updated_at = NOW()
                WHERE vendor_id = $9 AND ${productVariantId ? "product_variant_id" : "product_id"} = $10
                RETURNING *
            `;
            queryParams = [
                Number(price),
                Number(moq),
                Number(stockQuantity),
                requestedIsActive,
                Boolean(quotationEnabled),
                quotationMinQty ?? null,
                gstPercentage !== undefined ? Number(gstPercentage) : null,
                discountedPrice !== undefined && discountedPrice !== null ? Number(discountedPrice) : null,
                vendorId,
                productVariantId || productId
            ];
        }

        const result = await pool.query(updateQuery, queryParams);

        return res.status(200).json({
            message: requiresApproval
                ? "Product details updated. The price change request has been submitted to admin for approval."
                : "Vendor product updated successfully",
            data: result.rows[0]
        });
    } catch (error) {
        console.error("Error while updating vendor product:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const deleteVendorProductController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { userId, role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can delete their products." });
    }

    try {
        const vendorResult = await pool.query(
            `SELECT id, approval_status, is_active, is_blocked FROM vendors WHERE user_id = $1`,
            [userId]
        );

        if (vendorResult.rows.length === 0) {
            return res.status(403).json({ message: "Vendor profile not found." });
        }

        const vendor = vendorResult.rows[0];
        if (vendor.approval_status !== "approved" || !vendor.is_active || vendor.is_blocked) {
            return res.status(403).json({ message: "Your vendor account must be approved and active to delete products." });
        }

        const productVariantId = req.query.productVariantId || req.body.productVariantId;
        let deleteResult;
        if (productVariantId) {
            deleteResult = await pool.query(
                `DELETE FROM vendor_products WHERE vendor_id = $1 AND product_variant_id = $2 RETURNING *`,
                [vendor.id, productVariantId]
            );
        } else {
            deleteResult = await pool.query(
                `DELETE FROM vendor_products WHERE vendor_id = $1 AND product_id = $2 RETURNING *`,
                [vendor.id, productId]
            );
        }

        if (deleteResult.rows.length === 0) {
            return res.status(404).json({ message: "Product or variation not found or you don't have permission to delete it!" });
        }

        return res.status(200).json({ message: "Product removed from your catalog successfully" });
    } catch (error) {
        console.error("Error deleting vendor product:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getVendorProductAnalyticsController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { userId, role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their product analytics." });
    }

    try {
        const vendorResult = await pool.query(
            `SELECT id, approval_status, is_active, is_blocked FROM vendors WHERE user_id = $1`,
            [userId]
        );

        if (vendorResult.rows.length === 0) {
            return res.status(403).json({ message: "Vendor profile not found." });
        }

        const vendor = vendorResult.rows[0];
        const vendorId = vendor.id;

        // Get basic analytics
        const analyticsQuery = `
            SELECT 
                vp.price,
                vp.moq,
                vp.stock_quantity,
                vp.is_active,
                vp.created_at AS vendor_product_created_at,
                vp.updated_at AS vendor_product_updated_at,
                p.name AS product_name,
                p.category,
                p.product_type,
                p.rating AS product_rating,
                p.review_count AS total_reviews,
                
                -- Order statistics
                COALESCE(order_stats.total_orders, 0)::int AS total_orders,
                COALESCE(order_stats.total_revenue, 0)::numeric AS total_revenue,
                COALESCE(order_stats.avg_order_value, 0)::numeric AS avg_order_value,
                COALESCE(order_stats.last_order_date, NULL) AS last_order_date,
                
                -- View statistics (simulated - you might want to add a views table)
                COALESCE(view_stats.total_views, 0)::int AS total_views,
                COALESCE(view_stats.unique_views, 0)::int AS unique_views,
                
                -- Cart statistics
                COALESCE(cart_stats.cart_additions, 0)::int AS cart_additions,
                COALESCE(cart_stats.conversion_rate, 0)::numeric AS conversion_rate
                
            FROM vendor_products vp
            JOIN products p ON vp.product_id = p.id
            LEFT JOIN LATERAL (
                SELECT 
                    COUNT(DISTINCT oi.order_id)::int AS total_orders,
                    COALESCE(SUM(oi.quantity * oi.price), 0)::numeric AS total_revenue,
                    COALESCE(AVG(oi.quantity * oi.price), 0)::numeric AS avg_order_value,
                    MAX(o.created_at) AS last_order_date
                FROM order_items oi
                JOIN orders o ON oi.order_id = o.id
                WHERE oi.product_id = vp.product_id 
                  AND oi.vendor_id = vp.vendor_id
                  AND o.status NOT IN ('cancelled', 'refunded')
            ) order_stats ON true
            
            LEFT JOIN LATERAL (
                SELECT 
                    0::int AS total_views,  -- Placeholder - implement views tracking
                    0::int AS unique_views   -- Placeholder - implement unique views tracking
            ) view_stats ON true
            
            LEFT JOIN LATERAL (
                SELECT 
                    COUNT(DISTINCT c.user_id)::int AS cart_additions,
                    CASE 
                        WHEN COUNT(DISTINCT oi.order_id) > 0 
                        THEN (COUNT(DISTINCT oi.order_id)::numeric / NULLIF(COUNT(DISTINCT c.user_id), 0)) * 100
                        ELSE 0 
                    END::numeric AS conversion_rate
                FROM cart_items ci
                JOIN carts c ON ci.cart_id = c.id
                LEFT JOIN order_items oi ON ci.product_id = oi.product_id AND ci.vendor_id = oi.vendor_id
                WHERE ci.product_id = vp.product_id AND ci.vendor_id = vp.vendor_id
            ) cart_stats ON true
            
            WHERE vp.vendor_id = $1 AND vp.product_id = $2
        `;

        const analyticsResult = await pool.query(analyticsQuery, [vendorId, productId]);

        if (analyticsResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found or you don't have access to this product." });
        }

        const analytics = analyticsResult.rows[0];

        // Get monthly sales data for the last 6 months
        const monthlySalesQuery = `
            SELECT 
                DATE_TRUNC('month', o.created_at)::date AS month,
                COUNT(DISTINCT oi.order_id)::int AS orders_count,
                COALESCE(SUM(oi.quantity * oi.price), 0)::numeric AS revenue,
                COALESCE(SUM(oi.quantity), 0)::int AS quantity_sold
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE oi.product_id = $1 
              AND oi.vendor_id = $2
              AND o.status NOT IN ('cancelled', 'refunded')
              AND o.created_at >= NOW() - INTERVAL '6 months'
            GROUP BY DATE_TRUNC('month', o.created_at)
            ORDER BY month DESC
        `;

        const monthlySalesResult = await pool.query(monthlySalesQuery, [productId, vendorId]);

        // Get recent orders
        const recentOrdersQuery = `
            SELECT 
                o.id AS order_id,
                o.created_at AS order_date,
                o.total_amount,
                o.status AS order_status,
                oi.quantity,
                oi.price AS unit_price,
                oi.quantity * oi.price AS total_price,
                u.name AS customer_name,
                u.email AS customer_email
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN users u ON o.user_id = u.id
            WHERE oi.product_id = $1 
              AND oi.vendor_id = $2
            ORDER BY o.created_at DESC
            LIMIT 10
        `;

        const recentOrdersResult = await pool.query(recentOrdersQuery, [productId, vendorId]);

        return res.status(200).json({
            message: "Vendor product analytics fetched successfully",
            data: {
                ...analytics,
                monthly_sales: monthlySalesResult.rows,
                recent_orders: recentOrdersResult.rows
            }
        });
    } catch (error) {
        console.error("Error while fetching vendor product analytics:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getProductReviewsController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { userId, role } = (req as any).user;
    const { offset = "0", limit = "10" } = req.query;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Unauthorized! Only vendors can access their product reviews." });
    }

    try {
        const vendorResult = await pool.query(
            `SELECT id, approval_status, is_active, is_blocked FROM vendors WHERE user_id = $1`,
            [userId]
        );

        if (vendorResult.rows.length === 0) {
            return res.status(403).json({ message: "Vendor profile not found." });
        }

        const vendor = vendorResult.rows[0];
        const vendorId = vendor.id;

        // Check if vendor has access to this product
        const productAccessResult = await pool.query(
            `SELECT id FROM vendor_products WHERE vendor_id = $1 AND product_id = $2`,
            [vendorId, productId]
        );

        if (productAccessResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found or you don't have access to this product." });
        }

        const offsetValue = Number(offset) * Number(limit);
        const limitValue = Math.min(Number(limit), 50); // Max 50 reviews per page

        // Get reviews with pagination
        const reviewsQuery = `
            SELECT 
                oir.id AS review_id,
                oir.rating,
                oir.review_title,
                oir.review_text,
                oir.images,
                oir.is_verified_purchase AS verified_purchase,
                0::int AS helpful_count,
                oir.created_at AS review_date,
                u.name AS customer_name,
                u.email AS customer_email,
                o.id AS order_id,
                o.created_at AS order_date,
                oi.quantity AS purchased_quantity,
                oi.price AS unit_price,
                CASE 
                    WHEN oir.rating >= 5 THEN 'Excellent'
                    WHEN oir.rating >= 4 THEN 'Good'
                    WHEN oir.rating >= 3 THEN 'Average'
                    WHEN oir.rating >= 2 THEN 'Poor'
                    ELSE 'Very Poor'
                END AS rating_label
            FROM order_item_reviews oir
            JOIN order_items oi ON oir.order_item_id = oi.id
            JOIN orders o ON oi.order_id = o.id
            JOIN users u ON oir.user_id = u.id
            WHERE oi.product_id = $1 
              AND oi.vendor_id = $2
            ORDER BY oir.created_at DESC
            LIMIT $3 OFFSET $4
        `;

        const reviewsResult = await pool.query(reviewsQuery, [productId, vendorId, limitValue, offsetValue]);

        const reviews = reviewsResult.rows;
        for (const r of reviews) {
            if (r.images && Array.isArray(r.images)) {
                r.images = await Promise.all(
                    r.images.map((img: string) => getPresignedUrlOrOriginal(img))
                );
            }
        }

        // Get review statistics
        const statsQuery = `
            SELECT 
                COUNT(*)::int AS total_reviews,
                COALESCE(AVG(rating), 0)::numeric AS avg_rating,
                COUNT(CASE WHEN rating = 5 THEN 1 END)::int AS five_star_count,
                COUNT(CASE WHEN rating = 4 THEN 1 END)::int AS four_star_count,
                COUNT(CASE WHEN rating = 3 THEN 1 END)::int AS three_star_count,
                COUNT(CASE WHEN rating = 2 THEN 1 END)::int AS two_star_count,
                COUNT(CASE WHEN rating = 1 THEN 1 END)::int AS one_star_count
            FROM order_item_reviews oir
            JOIN order_items oi ON oir.order_item_id = oi.id
            WHERE oi.product_id = $1 
              AND oi.vendor_id = $2
        `;

        const statsResult = await pool.query(statsQuery, [productId, vendorId]);

        const stats = statsResult.rows[0];

        return res.status(200).json({
            message: "Product reviews fetched successfully",
            data: {
                reviews,
                stats: {
                    total_reviews: stats.total_reviews,
                    avg_rating: Number(stats.avg_rating).toFixed(1),
                    rating_distribution: {
                        5: stats.five_star_count,
                        4: stats.four_star_count,
                        3: stats.three_star_count,
                        2: stats.two_star_count,
                        1: stats.one_star_count
                    }
                },
                pagination: {
                    current_page: Number(offset),
                    per_page: limitValue,
                    has_more: reviews.length === limitValue
                }
            }
        });
    } catch (error) {
        console.error("Error while fetching product reviews:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getPublicProductReviewsController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    const { page = "0", limit = "10" } = req.query;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    try {
        const pageNumber = Number(page);
        const limitValue = Math.min(Number(limit), 50); // Max 50 reviews per page
        const offsetValue = pageNumber * limitValue;

        // Get reviews with pagination (no vendor filtering, open to public)
        const reviewsQuery = `
            SELECT 
                oir.id AS review_id,
                oir.rating,
                oir.review_title,
                oir.review_text,
                oir.images,
                oir.is_verified_purchase AS verified_purchase,
                0::int AS helpful_count,
                oir.created_at AS review_date,
                u.name AS customer_name,
                v.id AS vendor_id,
                CASE 
                    WHEN oir.rating >= 5 THEN 'Excellent'
                    WHEN oir.rating >= 4 THEN 'Good'
                    WHEN oir.rating >= 3 THEN 'Average'
                    WHEN oir.rating >= 2 THEN 'Poor'
                    ELSE 'Very Poor'
                END AS rating_label
            FROM order_item_reviews oir
            JOIN users u ON oir.user_id = u.id
            JOIN vendors v ON oir.vendor_id = v.id
            WHERE oir.product_id = $1 
            ORDER BY oir.created_at DESC
            LIMIT $2 OFFSET $3
        `;

        const reviewsResult = await pool.query(reviewsQuery, [productId, limitValue, offsetValue]);

        const reviews = reviewsResult.rows;
        for (const r of reviews) {
            if (r.images && Array.isArray(r.images)) {
                r.images = await Promise.all(
                    r.images.map((img: string) => getPresignedUrlOrOriginal(img))
                );
            }
        }

        let stats = null;
        // Optimization: only calculate stats on the first page load (page = 0)
        if (pageNumber === 0) {
            const statsQuery = `
                SELECT 
                    COUNT(*)::int AS total_reviews,
                    COALESCE(AVG(rating), 0)::numeric AS avg_rating,
                    COUNT(CASE WHEN rating = 5 THEN 1 END)::int AS five_star_count,
                    COUNT(CASE WHEN rating = 4 THEN 1 END)::int AS four_star_count,
                    COUNT(CASE WHEN rating = 3 THEN 1 END)::int AS three_star_count,
                    COUNT(CASE WHEN rating = 2 THEN 1 END)::int AS two_star_count,
                    COUNT(CASE WHEN rating = 1 THEN 1 END)::int AS one_star_count
                FROM order_item_reviews oir
                WHERE oir.product_id = $1
            `;

            const statsResult = await pool.query(statsQuery, [productId]);
            const dbStats = statsResult.rows[0];
            stats = {
                total_reviews: dbStats.total_reviews,
                avg_rating: Number(dbStats.avg_rating).toFixed(1),
                rating_distribution: {
                    5: dbStats.five_star_count,
                    4: dbStats.four_star_count,
                    3: dbStats.three_star_count,
                    2: dbStats.two_star_count,
                    1: dbStats.one_star_count
                }
            };
        }

        return res.status(200).json({
            message: "Product reviews fetched successfully",
            data: {
                reviews,
                stats,
                pagination: {
                    current_page: pageNumber,
                    per_page: limitValue,
                    has_more: reviews.length === limitValue
                }
            }
        });
    } catch (error) {
        console.error("Error while fetching public product reviews:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getRelatedProducts = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    try {
        const query = `
            SELECT
                p.id AS product_id,
                p.name AS product_name,
                p.category,
                p.product_type,
                p.item_code AS product_code,
                p.attributes->>'brand' AS brand,
                p.rating,
                p.review_count,
                pImg.image_url AS primary_image,
                COALESCE(vc.vendor_count, 0)::int AS seller_count,
                COALESCE(pr.min_price, 0)::numeric AS min_price,
                COALESCE(pr.max_price, 0)::numeric AS max_price,
                COALESCE(pr.min_moq, 1)::int AS min_moq
            FROM products p
            LEFT JOIN products_images pImg
                ON p.id = pImg.product_id AND pImg.is_primary = true AND pImg.approval_status = 'approved'
            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT vendor_id)::int AS vendor_count
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) vc ON true
            LEFT JOIN LATERAL (
                SELECT
                    MIN(price)::numeric AS min_price,
                    MAX(price)::numeric AS max_price,
                    MIN(moq)::int AS min_moq
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) pr ON true
            WHERE p.approval_status = 'approved'
              AND p.is_active = TRUE
              AND p.id != $1
              AND p.category = (SELECT category FROM products WHERE id = $1)
              AND EXISTS (
                  SELECT 1
                  FROM vendor_products vp
                  JOIN vendors v ON v.id = vp.vendor_id
                  JOIN users u ON u.id = v.user_id
                  WHERE vp.product_id = p.id
                    AND vp.is_active = true
                    AND v.approval_status = 'approved'
                    AND v.is_active = true
                    AND v.is_blocked = false
                    AND u.is_active = true
              )
            ORDER BY p.rating DESC NULLS LAST, p.review_count DESC NULLS LAST, p.created_at DESC
            LIMIT 8
        `;
        const result = await pool.query(query, [productId]);
        return res.status(200).json({ message: "Related products fetched successfully", data: result.rows });
    } catch (e) {
        console.error("Error while fetching related products : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const uploadProductImagesController = async (req: Request, res: Response): Promise<Response> => {
    const { productId, productVariantId } = req.body;
    const { userId, role } = (req as any).user;

    if (!productId) {
        return res.status(400).json({ message: "Product ID is required" });
    }

    const filesMap = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const images = filesMap?.["images"] || [];
    const videoFile = filesMap?.["video"]?.[0] || null;

    if (images.length === 0 && !videoFile) {
        return res.status(400).json({ message: "No images or video provided" });
    }

    try {
        const productResult = await pool.query(`SELECT id, approval_status, created_by_user_id FROM products WHERE id = $1`, [productId]);
        if (productResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found." });
        }

        const isVendor = role === "vendor";
        const approvalStatus = isVendor ? "pending" : "approved";

        const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "";
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const targetPrimaryIndex = req.body.primaryImageIndex !== undefined ? Number(req.body.primaryImageIndex) : -1;

            if (targetPrimaryIndex >= 0 && targetPrimaryIndex < images.length) {
                await client.query(`UPDATE products_images SET is_primary = false WHERE product_id = $1`, [productId]);
            }

            // Check if product already has a primary image
            const existingImages = await client.query(`SELECT id FROM products_images WHERE product_id = $1 AND is_primary = true`, [productId]);
            let hasPrimary = existingImages.rows.length > 0;

            const uploadedImages = [];

            // 1. Process Images
            for (let i = 0; i < images.length; i++) {
                const file = images[i];
                const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
                const fileName = `products/${productId}/${Date.now()}_${originalName}`;

                const command = new PutObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: fileName,
                    Body: file.buffer,
                    ContentType: file.mimetype,
                });

                await s3Client.send(command);

                let isPrimary = false;
                if (targetPrimaryIndex >= 0) {
                    isPrimary = (i === targetPrimaryIndex);
                } else {
                    isPrimary = !hasPrimary && i === 0;
                    if (isPrimary) hasPrimary = true;
                }

                const isApproved = !isVendor;

                // Insert into products_images
                const insertQuery = `
                    INSERT INTO products_images (product_id, product_variant_id, image_url, is_primary, display_order, approval_status, is_approved, created_by_user_id, media_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'image')
                    RETURNING *
                `;
                const fullUrl = `https://${BUCKET_NAME}.s3.${(process.env.AWS_REGION || "ap-south-1").trim()}.amazonaws.com/${fileName}`;
                const values = [productId, productVariantId || null, fullUrl, isPrimary, i, approvalStatus, isApproved, userId];
                const result = await client.query(insertQuery, values);
                uploadedImages.push(result.rows[0]);
            }

            // 2. Process Video (if present)
            if (videoFile) {
                const originalName = videoFile.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
                const fileName = `products/${productId}/${Date.now()}_${originalName}`;

                const command = new PutObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: fileName,
                    Body: videoFile.buffer,
                    ContentType: videoFile.mimetype,
                });

                await s3Client.send(command);

                const isApproved = !isVendor;

                // Insert into products_images with media_type = 'video'
                const insertQuery = `
                    INSERT INTO products_images (product_id, product_variant_id, image_url, is_primary, display_order, approval_status, is_approved, created_by_user_id, media_type)
                    VALUES ($1, $2, $3, FALSE, 99, $4, $5, $6, 'video')
                    RETURNING *
                `;
                const fullUrl = `https://${BUCKET_NAME}.s3.${(process.env.AWS_REGION || "ap-south-1").trim()}.amazonaws.com/${fileName}`;
                const values = [productId, productVariantId || null, fullUrl, approvalStatus, isApproved, userId];
                const result = await client.query(insertQuery, values);
                uploadedImages.push(result.rows[0]);
            }

            await client.query("COMMIT");
            return res.status(201).json({ message: "Media files uploaded successfully", data: uploadedImages });
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("Error uploading product media:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getProductTypes = async (_req: Request, res: Response): Promise<Response> => {
    try {
        const result = await pool.query(
            `SELECT DISTINCT product_type 
             FROM products 
             WHERE product_type IS NOT NULL AND product_type != '' AND is_active = TRUE AND approval_status = 'approved'
             ORDER BY product_type ASC`
        );
        const types = result.rows.map(row => row.product_type);
        return res.status(200).json({ message: "Product types fetched successfully", data: types });
    } catch (e) {
        console.error("Error while fetching product types : ", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const addProductVariantController = async (req: Request, res: Response): Promise<Response> => {
    const { productId, sku, name, properties } = req.body;
    const { userId, role } = (req as any).user;

    if (!productId || !properties || typeof properties !== 'object') {
        return res.status(400).json({ message: "Product ID and properties object are required." });
    }

    try {
        const productResult = await pool.query(`SELECT id, created_by_user_id FROM products WHERE id = $1`, [productId]);
        if (productResult.rows.length === 0) {
            return res.status(404).json({ message: "Product not found." });
        }

        const isVendor = role === "vendor";
        const approvalStatus = isVendor ? "pending" : "approved";

        // Check if the variant already exists
        const duplicateResult = await pool.query(
            `SELECT id FROM product_variants WHERE product_id = $1 AND properties = $2::jsonb`,
            [productId, JSON.stringify(properties)]
        );
        if (duplicateResult.rows.length > 0) {
            return res.status(409).json({ message: "A variant with these exact properties already exists." });
        }

        let finalName = name ? String(name).trim() : null;
        if (!finalName && properties && typeof properties === 'object') {
            finalName = Object.entries(properties)
                .map(([key, val]) => `${key}: ${val}`)
                .join(', ') || "Default Variation";
        }

        const query = `
            INSERT INTO product_variants (
                product_id,
                sku,
                name,
                properties,
                approval_status,
                created_by_user_id,
                is_active
            )
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
            RETURNING *
        `;
        const values = [
            productId,
            sku || null,
            finalName,
            JSON.stringify(properties),
            approvalStatus,
            userId,
            !isVendor
        ];

        const result = await pool.query(query, values);

        return res.status(201).json({
            message: isVendor ? "Product variant submitted for approval successfully" : "Product variant added successfully",
            result: result.rows[0]
        });
    } catch (error) {
        console.error("Error in addProductVariantController:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getProductVariantsController = async (req: Request, res: Response): Promise<Response> => {
    const { productId } = req.params;
    if (!productId) {
        return res.status(400).json({ message: "Product ID is required." });
    }

    try {
        const result = await pool.query(
            `SELECT id, product_id, sku, name, properties, approval_status, is_active 
             FROM product_variants 
             WHERE product_id = $1 AND approval_status = 'approved' AND is_active = TRUE`,
            [productId]
        );
        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error in getProductVariantsController:", error);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getLatestOrOrderedProducts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const latestQuery = `
            SELECT
                p.id AS product_id,
                p.name AS product_name,
                p.category,
                p.product_type,
                p.rating,
                p.review_count,
                pImg.image_url AS primary_image,
                COALESCE(vc.vendor_count, 0)::int AS seller_count,
                COALESCE(pr.min_price, 0)::numeric AS min_price,
                COALESCE(pr.max_price, 0)::numeric AS max_price,
                COALESCE(pr.min_moq, 1)::int AS min_moq
            FROM products p
            LEFT JOIN products_images pImg
                ON p.id = pImg.product_id AND pImg.is_primary = true AND pImg.approval_status = 'approved'
            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT vendor_id)::int AS vendor_count
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) vc ON true
            LEFT JOIN LATERAL (
                SELECT
                    MIN(price)::numeric AS min_price,
                    MAX(price)::numeric AS max_price,
                    MIN(moq)::int AS min_moq
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) pr ON true
            WHERE p.approval_status = 'approved'
              AND p.is_active = TRUE
            ORDER BY p.created_at DESC
            LIMIT 8
        `;

        const orderedQuery = `
            SELECT DISTINCT ON (p.id)
                p.id AS product_id,
                p.name AS product_name,
                p.category,
                p.product_type,
                p.rating,
                p.review_count,
                pImg.image_url AS primary_image,
                COALESCE(vc.vendor_count, 0)::int AS seller_count,
                COALESCE(pr.min_price, 0)::numeric AS min_price,
                COALESCE(pr.max_price, 0)::numeric AS max_price,
                COALESCE(pr.min_moq, 1)::int AS min_moq,
                o.created_at AS order_date
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            LEFT JOIN products_images pImg
                ON p.id = pImg.product_id AND pImg.is_primary = true AND pImg.approval_status = 'approved'
            LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT vendor_id)::int AS vendor_count
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) vc ON true
            LEFT JOIN LATERAL (
                SELECT
                    MIN(price)::numeric AS min_price,
                    MAX(price)::numeric AS max_price,
                    MIN(moq)::int AS min_moq
                FROM vendor_products vp
                JOIN vendors v ON v.id = vp.vendor_id
                JOIN users u ON u.id = v.user_id
                WHERE vp.product_id = p.id
                  AND vp.is_active = true
                  AND v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND u.is_active = true
            ) pr ON true
            WHERE p.approval_status = 'approved'
              AND p.is_active = TRUE
            ORDER BY p.id, o.created_at DESC
            LIMIT 8
        `;

        const [latestRes, orderedRes] = await Promise.all([
            pool.query(latestQuery),
            pool.query(orderedQuery)
        ]);

        const orderedRows = orderedRes.rows;
        orderedRows.sort((a: any, b: any) => new Date(b.order_date).getTime() - new Date(a.order_date).getTime());

        return res.status(200).json({
            message: "Latest and ordered products fetched successfully",
            data: {
                latest: latestRes.rows,
                ordered: orderedRows
            }
        });
    } catch (e) {
        console.error("Error fetching latest or ordered products:", e);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

export const getSubcategoriesController = async (req: Request, res: Response): Promise<Response> => {
    const categoryId = req.params.categoryId || req.query.categoryId;
    try {
        let query = `
            SELECT s.id, s.category_id, s.name, s.description, pc.code AS category_code, pc.label AS category_label
            FROM subcategories s
            JOIN product_category pc ON pc.id = s.category_id
            WHERE pc.is_active = TRUE
        `;
        const params: any[] = [];
        if (categoryId && typeof categoryId === "string") {
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(categoryId);
            if (isUuid) {
                query += ` AND s.category_id = $1`;
                params.push(categoryId);
            } else {
                query += ` AND (LOWER(pc.code) = LOWER($1) OR LOWER(pc.label) = LOWER($1))`;
                params.push(categoryId.trim());
            }
        }
        query += ` ORDER BY s.name ASC`;
        const result = await pool.query(query, params);
        return res.status(200).json({ message: "Subcategories fetched successfully", data: result.rows });
    } catch (error) {
        console.error("Error fetching subcategories:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

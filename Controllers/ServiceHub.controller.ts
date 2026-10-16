import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";
import { createNotification } from "./Notification.controller";
import { razorpay } from "../services/razorpay.service";
import crypto from "crypto";

type AuthUser = { userId: string; role: string; email?: string };

function getAuthUser(req: Request): AuthUser | null {
  const user = (req as any).user;
  if (!user?.userId) return null;
  return user as AuthUser;
}

function isGoogleMapsLink(value: unknown) {
  return typeof value === "string" && (/^https:\/\/(?:[a-z0-9-]+\.)*google\.[a-z.]+(?:\/maps)?(?:\/|[?#]|$)/i.test(value) || /^https:\/\/maps\.app\.goo\.gl\//i.test(value));
}

// ────────────────────────────────────────────────────────────────────
// 1. DYNAMIC CATEGORIES & SUB-CATEGORIES WITH FORM SCHEMAS
// ────────────────────────────────────────────────────────────────────
export const getServiceCategoriesWithSchema = async (
  _req: Request,
  res: Response,
): Promise<Response> => {
  try {
    const categoriesResult = await pool.query(
      `SELECT sc.id, sc.code, sc.label, sc.description, sc.image,
                    'service'::text AS category_type, sc.sort_order,
                    COALESCE(
                        (
                            SELECT json_agg(
                                json_build_object(
                                    'id', root.id,
                                    'name', root.name,
                                    'description', root.description,
                                    'form_schema', COALESCE(root.form_schema, '[]'::jsonb),
                                    'children', COALESCE((
                                        SELECT json_agg(json_build_object(
                                            'id', child.id,
                                            'name', child.name,
                                            'description', child.description,
                                            'form_schema', COALESCE(child.form_schema, '[]'::jsonb),
                                            'children', '[]'::json
                                        ) ORDER BY child.name)
                                        FROM service_subcategories child
                                        WHERE child.parent_id = root.id
                                    ), '[]'::json)
                                ) ORDER BY root.name
                            )
                            FROM service_subcategories root
                            WHERE root.category_id = sc.id AND root.parent_id IS NULL
                        ), '[]'::json
                    ) AS subcategories
             FROM service_categories sc
             WHERE sc.is_active = true
             ORDER BY sc.sort_order ASC, sc.label ASC`,
    );

    const rows = await Promise.all(
      categoriesResult.rows.map(async (row) => ({
        ...row,
        image: await getPresignedUrlOrOriginal(row.image),
      })),
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching service categories:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load service categories." });
  }
};

const MAX_VENDOR_SERVICE_CATEGORIES = 3;

export const getVendorServiceCoverage = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser || authUser.role !== "vendor") {
    return res.status(403).json({ success: false, message: "Vendor access required." });
  }

  try {
    const result = await pool.query(
      `SELECT service_category_id, service_subcategory_id
       FROM vendor_service_category_selections
       WHERE vendor_id = (SELECT id FROM vendors WHERE user_id = $1)`,
      [authUser.userId],
    );
    return res.status(200).json({
      success: true,
      data: {
        category_ids: result.rows.filter((row) => row.service_subcategory_id === null).map((row) => row.service_category_id),
        subcategory_ids: result.rows.filter((row) => row.service_subcategory_id !== null).map((row) => row.service_subcategory_id),
      },
    });
  } catch (error) {
    console.error("Error fetching vendor service coverage:", error);
    return res.status(500).json({ success: false, message: "Failed to load service coverage." });
  }
};

export const saveVendorServiceCoverage = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser || authUser.role !== "vendor") {
    return res.status(403).json({ success: false, message: "Vendor access required." });
  }

  const requestedCategoryIds = Array.isArray(req.body?.category_ids)
    ? [...new Set(req.body.category_ids.filter((id: unknown) => typeof id === "string"))] as string[]
    : [];
  let categoryIds: string[] = [];
  const subcategoryIds = Array.isArray(req.body?.subcategory_ids)
    ? [...new Set(req.body.subcategory_ids.filter((id: unknown) => typeof id === "string"))] as string[]
    : [];

  if (requestedCategoryIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
      subcategoryIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    return res.status(400).json({ success: false, message: "Invalid service category selection." });
  }

  let transactionClient: PoolClient | undefined;
  try {
    const vendorResult = await pool.query(`SELECT id FROM vendors WHERE user_id = $1`, [authUser.userId]);
    const vendorId = vendorResult.rows[0]?.id;
    if (!vendorId) return res.status(404).json({ success: false, message: "Vendor profile not found." });

    const assignedCategories = await pool.query(
      `SELECT DISTINCT service_category_id
       FROM vendor_service_category_selections
       WHERE vendor_id = $1 AND service_subcategory_id IS NULL`,
      [vendorId],
    );
    categoryIds = assignedCategories.rows.map((row) => row.service_category_id);
    if (categoryIds.length > MAX_VENDOR_SERVICE_CATEGORIES) {
      return res.status(400).json({ success: false, message: `Contact an administrator to change your assigned service categories.` });
    }
    if (!categoryIds.length) {
      return res.status(400).json({ success: false, message: "Main service categories are managed by an administrator." });
    }
    if (requestedCategoryIds.length) {
      const requestedSet = new Set(requestedCategoryIds);
      if (requestedSet.size !== categoryIds.length || categoryIds.some((id) => !requestedSet.has(id))) {
        return res.status(403).json({ success: false, message: "Main service categories are managed by an administrator." });
      }
    }

    if (categoryIds.length) {
      const categories = await pool.query(
        `SELECT id FROM service_categories WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [categoryIds],
      );
      if (categories.rows.length !== categoryIds.length) {
        return res.status(400).json({ success: false, message: "One or more selected service categories are unavailable." });
      }
    }

    if (subcategoryIds.length) {
      const nodes = await pool.query(
        `SELECT id, category_id, parent_id FROM service_subcategories WHERE id = ANY($1::uuid[])`,
        [subcategoryIds],
      );
      if (nodes.rows.length !== subcategoryIds.length || nodes.rows.some((node) => !categoryIds.includes(node.category_id))) {
        return res.status(400).json({ success: false, message: "Selected subcategories must belong to one of your selected service categories." });
      }
      const selectedNodeIds = new Set(subcategoryIds);
      if (nodes.rows.some((node) => node.parent_id && !selectedNodeIds.has(node.parent_id))) {
        return res.status(400).json({ success: false, message: "Select the parent subcategory before its sub-subcategory." });
      }
    }

    const client = await pool.connect();
    transactionClient = client;
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM vendor_service_category_selections
       WHERE vendor_id = $1 AND service_subcategory_id IS NOT NULL`,
      [vendorId],
    );
    if (subcategoryIds.length) {
      await client.query(
        `INSERT INTO vendor_service_category_selections (vendor_id, service_category_id, service_subcategory_id)
         SELECT $1, sub.category_id, sub.id
         FROM service_subcategories sub WHERE sub.id = ANY($2::uuid[])`,
        [vendorId, subcategoryIds],
      );
    }
    await client.query("COMMIT");
    return res.status(200).json({ success: true, message: "Service coverage saved." });
  } catch (error) {
    if (transactionClient) await transactionClient.query("ROLLBACK");
    console.error("Error saving vendor service coverage:", error);
    return res.status(500).json({ success: false, message: "Failed to save service coverage." });
  } finally {
    transactionClient?.release();
  }
};

// ────────────────────────────────────────────────────────────────────
// 2. CLIENT ASSET REGISTRY (MACHINERY / EQUIPMENT / FLEET)
// ────────────────────────────────────────────────────────────────────
export const getMyAssets = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  try {
    const result = await pool.query(
      `SELECT ca.*, COALESCE(sc.label, pc.label) AS category_name,
                    sc.label AS service_category_name, s.name AS subcategory_name,
                    service_sub.name AS service_subcategory_name
             FROM client_assets ca
             LEFT JOIN product_category pc ON pc.id = ca.category_id
             LEFT JOIN service_categories sc ON sc.id = ca.service_category_id
             LEFT JOIN subcategories s ON s.id = ca.subcategory_id
             LEFT JOIN service_subcategories service_sub ON service_sub.id = ca.service_subcategory_id
             WHERE ca.user_id = $1 AND ca.is_active = true
             ORDER BY ca.created_at DESC`,
      [authUser.userId],
    );

    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Error fetching client assets:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load assets." });
  }
};

export const createClientAsset = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const {
    asset_name,
    asset_code,
    brand,
    model_number,
    serial_number,
    installation_year,
    category_id,
    service_category_id,
    subcategory_id,
    service_subcategory_id,
    specs,
    location_details,
    documents,
  } = req.body;
  if (!asset_name) {
    return res
      .status(400)
      .json({ success: false, message: "asset_name is required." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO client_assets
                (user_id, category_id, service_category_id, subcategory_id, service_subcategory_id, asset_name, asset_code,
                 brand, model_number, serial_number, installation_year,
                 specs, location_details, documents)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb)
             RETURNING *`,
      [
        authUser.userId,
        category_id || null,
        service_category_id || null,
        subcategory_id || null,
        service_subcategory_id || null,
        asset_name.trim(),
        asset_code?.trim() || null,
        brand?.trim() || null,
        model_number?.trim() || null,
        serial_number?.trim() || null,
        installation_year ? Number(installation_year) : null,
        JSON.stringify(specs || {}),
        JSON.stringify(location_details || {}),
        JSON.stringify(Array.isArray(documents) ? documents : []),
      ],
    );

    return res.status(201).json({
      success: true,
      message: "Asset registered successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error creating asset:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to register asset." });
  }
};

export const updateClientAsset = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const { id } = req.params;
  const {
    asset_name,
    asset_code,
    brand,
    model_number,
    serial_number,
    installation_year,
    category_id,
    service_category_id,
    subcategory_id,
    service_subcategory_id,
    specs,
    location_details,
    documents,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE client_assets
             SET asset_name = COALESCE($1, asset_name),
                 asset_code = COALESCE($2, asset_code),
                 brand = COALESCE($3, brand),
                 model_number = COALESCE($4, model_number),
                 serial_number = COALESCE($5, serial_number),
                 installation_year = COALESCE($6, installation_year),
                 category_id = COALESCE($7, category_id),
                 service_category_id = COALESCE($8, service_category_id),
                 subcategory_id = COALESCE($9, subcategory_id),
                 service_subcategory_id = COALESCE($10, service_subcategory_id),
                 specs = COALESCE($11::jsonb, specs),
                 location_details = COALESCE($12::jsonb, location_details),
                 documents = COALESCE($13::jsonb, documents),
                 updated_at = NOW()
             WHERE id = $14 AND user_id = $15
             RETURNING *`,
      [
        asset_name?.trim() || null,
        asset_code?.trim() || null,
        brand?.trim() || null,
        model_number?.trim() || null,
        serial_number?.trim() || null,
        installation_year ? Number(installation_year) : null,
        category_id || null,
        service_category_id || null,
        subcategory_id || null,
        service_subcategory_id || null,
        specs ? JSON.stringify(specs) : null,
        location_details ? JSON.stringify(location_details) : null,
        documents ? JSON.stringify(documents) : null,
        id,
        authUser.userId,
      ],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Asset not found or unauthorized." });
    }

    return res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Error updating asset:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update asset." });
  }
};

export const deleteClientAsset = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE client_assets SET is_active = false, updated_at = NOW()
             WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, authUser.userId],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Asset not found or unauthorized." });
    }

    return res.status(200).json({ success: true, message: "Asset removed." });
  } catch (error) {
    console.error("Error deleting asset:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete asset." });
  }
};

// ────────────────────────────────────────────────────────────────────
// 3. UNIVERSAL SERVICE TICKETS (INTAKE, RETRIEVAL, OTP VERIFICATION)
// ────────────────────────────────────────────────────────────────────
export const createServiceTicket = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const {
    category_id,
    subcategory_id,
    service_subcategory_id,
    service_sub_subcategory_id,
    vendor_id,
    asset_id,
    priority,
    ticket_payload,
    documents,
  } = req.body;
  const safeTicketPayload = ticket_payload && typeof ticket_payload === "object" && !Array.isArray(ticket_payload)
    ? { ...ticket_payload }
    : {};

  if (!category_id) {
    return res
      .status(400)
      .json({ success: false, message: "category_id is required." });
  }

  try {
    const serviceCategory = await pool.query(
      `SELECT sc.id, sc.code,
                    EXISTS (SELECT 1 FROM service_subcategories sub WHERE sub.category_id = sc.id AND sub.parent_id IS NULL) AS has_subcategories
             FROM service_categories sc
             WHERE sc.id = $1 AND sc.is_active = true LIMIT 1`,
      [category_id],
    );
    if (serviceCategory.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Selected service category is unavailable.",
      });
    }

      const serviceCategoryCode = String(serviceCategory.rows[0].code || "").toLowerCase();
      const isLogisticsRequest = serviceCategoryCode === "logistics";
    const requiresVendorFleet = isLogisticsRequest && safeTicketPayload.web_vehicle_selection === true;
    const vehicleClassKey = requiresVendorFleet && typeof safeTicketPayload.vehicle_class_key === "string"
      ? safeTicketPayload.vehicle_class_key.trim().toLowerCase()
      : "";
    if (requiresVendorFleet) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vehicleClassKey)) {
        return res.status(400).json({ success: false, message: "Select a vehicle class from the available fleet." });
      }
      const lat = Number(safeTicketPayload.pickup_latitude);
      const lng = Number(safeTicketPayload.pickup_longitude);
      const dropLat = Number(safeTicketPayload.delivery_latitude);
      const dropLng = Number(safeTicketPayload.delivery_longitude);
      const deliveryDate = typeof safeTicketPayload.delivery_date === "string" ? safeTicketPayload.delivery_date : "";
      if (!isGoogleMapsLink(safeTicketPayload.pickup_google_maps_url) || !isGoogleMapsLink(safeTicketPayload.delivery_google_maps_url) || ![lat, lng, dropLat, dropLng].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(dropLat) > 90 || Math.abs(lng) > 180 || Math.abs(dropLng) > 180 || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
        return res.status(400).json({ success: false, message: "Choose Google Maps pickup and delivery locations and a delivery date." });
      }
      const matchingVehicle = await pool.query(
        `SELECT vlv.vehicle_class, vlv.vehicle_name, vlv.payload, vlv.dimensions, vlv.image_key FROM vendor_logistics_vehicles vlv
         JOIN vendors v ON v.id = vlv.vendor_id
         WHERE vlv.vehicle_class_key = $1 AND vlv.is_active = true
           AND v.approval_status = 'approved' AND v.is_active = true AND v.is_blocked = false
           AND v.vendor_type IN ('service', 'both')
           AND ($2::uuid IS NULL OR v.id = $2)
         LIMIT 1`,
        [vehicleClassKey, vendor_id || null],
      );
      if (!matchingVehicle.rows.length) {
        return res.status(400).json({ success: false, message: "No approved vendor currently offers that vehicle class. Please choose another vehicle." });
      }
      safeTicketPayload.vehicle_class_key = vehicleClassKey;
      safeTicketPayload.vehicle_class = matchingVehicle.rows[0].vehicle_class;
      safeTicketPayload.vehicle_name = matchingVehicle.rows[0].vehicle_name;
      safeTicketPayload.vehicle_payload = matchingVehicle.rows[0].payload;
      safeTicketPayload.vehicle_dimensions = matchingVehicle.rows[0].dimensions;
      safeTicketPayload.vehicle_image_key = matchingVehicle.rows[0].image_key;
      const rad = (degrees: number) => degrees * Math.PI / 180;
      const dLat = rad(dropLat - lat);
      const dLng = rad(dropLng - lng);
      const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(dropLat)) * Math.sin(dLng / 2) ** 2;
      safeTicketPayload.approximate_distance_km = Number((6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))).toFixed(1));
    }

    let resolvedLegacySubcategoryId: string | null = null;
    let resolvedServiceSubcategoryId = service_subcategory_id || null;
    let resolvedServiceSubSubcategoryId = service_sub_subcategory_id || null;

    if (
      !resolvedServiceSubcategoryId &&
      !subcategory_id &&
      serviceCategory.rows[0].has_subcategories
    ) {
      return res.status(400).json({
        success: false,
        message: "Select a service subcategory before submitting this request.",
      });
    }

    // Older app versions send `subcategory_id`; keep accepting it while new web flows
    // use the dedicated service taxonomy IDs.
    if (!resolvedServiceSubcategoryId && subcategory_id) {
      const legacySubcategory = await pool.query(
        `SELECT id FROM subcategories WHERE id = $1 AND category_id = $2 LIMIT 1`,
        [subcategory_id, category_id],
      );
      if (legacySubcategory.rows.length > 0)
        resolvedLegacySubcategoryId = legacySubcategory.rows[0].id;

      const legacyMapping = await pool.query(
        `SELECT id FROM service_subcategories WHERE id = $1 AND category_id = $2 AND parent_id IS NULL LIMIT 1`,
        [subcategory_id, category_id],
      );
      if (legacyMapping.rows.length > 0)
        resolvedServiceSubcategoryId = legacyMapping.rows[0].id;
    }

    if (resolvedServiceSubcategoryId) {
      const rootResult = await pool.query(
        `SELECT id,
                        EXISTS (SELECT 1 FROM service_subcategories child WHERE child.parent_id = service_subcategories.id) AS has_children
                 FROM service_subcategories WHERE id = $1 AND category_id = $2 AND parent_id IS NULL LIMIT 1`,
        [resolvedServiceSubcategoryId, category_id],
      );
      if (rootResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "Selected service subcategory does not belong to this category.",
        });
      }
      if (rootResult.rows[0].has_children && !resolvedServiceSubSubcategoryId) {
        return res.status(400).json({
          success: false,
          message:
            "Select a service sub-subcategory before submitting this request.",
        });
      }
    }

    if (resolvedServiceSubSubcategoryId) {
      if (!resolvedServiceSubcategoryId) {
        return res.status(400).json({
          success: false,
          message:
            "Select a service subcategory before selecting a sub-subcategory.",
        });
      }
      const childResult = await pool.query(
        `SELECT id FROM service_subcategories WHERE id = $1 AND category_id = $2 AND parent_id = $3 LIMIT 1`,
        [
          resolvedServiceSubSubcategoryId,
          category_id,
          resolvedServiceSubcategoryId,
        ],
      );
      if (childResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message:
            "Selected service sub-subcategory does not belong to the selected subcategory.",
        });
      }
    }

    if (vendor_id) {
      const selectedVendorCoverage = await pool.query(
        `SELECT 1
         FROM vendor_service_category_selections category_coverage
         WHERE category_coverage.vendor_id = $1
           AND category_coverage.service_category_id = $2
           AND category_coverage.service_subcategory_id IS NULL
           AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM vendor_service_category_selections subcategory_coverage
             WHERE subcategory_coverage.vendor_id = category_coverage.vendor_id
               AND subcategory_coverage.service_category_id = $2
               AND subcategory_coverage.service_subcategory_id = $3
           ))
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM vendor_service_category_selections child_coverage
             WHERE child_coverage.vendor_id = category_coverage.vendor_id
               AND child_coverage.service_category_id = $2
               AND child_coverage.service_subcategory_id = $4
           ))
         LIMIT 1`,
        [vendor_id, category_id, resolvedServiceSubcategoryId, resolvedServiceSubSubcategoryId],
      );
      if (!selectedVendorCoverage.rows.length) {
        return res.status(400).json({
          success: false,
          message: "The selected vendor does not accept this service category and subcategory combination.",
        });
      }
    }

    // Generate friendly ticket number: SRV-YYYYMMDD-XXXX
    const prefix = "SRV";
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const ticketNumber = `${prefix}-${dateStr}-${randomNum}`;

    // 6-digit OTP for secure completion
    const completionOtp = Math.floor(
      100000 + Math.random() * 900000,
    ).toString();

    const initialStatus = vendor_id ? "quote_pending" : "broadcasted";
    const initialTimeline = [
      {
        status: initialStatus,
        note: "Ticket raised by client.",
        timestamp: new Date().toISOString(),
        by_user_id: authUser.userId,
      },
    ];

    const ticketResult = await pool.query(
      `INSERT INTO service_tickets
                (ticket_number, category_id, subcategory_id, service_subcategory_id, service_sub_subcategory_id, client_user_id, vendor_id,
                 asset_id, status, priority, ticket_payload, completion_otp, timeline_logs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb)
             RETURNING *`,
      [
        ticketNumber,
        category_id,
        resolvedLegacySubcategoryId,
        resolvedServiceSubcategoryId,
        resolvedServiceSubSubcategoryId,
        authUser.userId,
        vendor_id || null,
        asset_id || null,
        initialStatus,
        priority || "medium",
        JSON.stringify({
          ...safeTicketPayload,
          service_subcategory_id: resolvedServiceSubcategoryId,
          service_sub_subcategory_id: resolvedServiceSubSubcategoryId,
        }),
        completionOtp,
        JSON.stringify(initialTimeline),
      ],
    );

    const createdTicket = ticketResult.rows[0];

    // Attach documents if provided
    if (Array.isArray(documents) && documents.length > 0) {
      for (const doc of documents) {
        if (doc.doc_url && doc.doc_type) {
          await pool.query(
            `INSERT INTO service_ticket_documents (ticket_id, doc_type, doc_name, doc_url, uploaded_by_user_id, metadata)
                         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              createdTicket.id,
              doc.doc_type,
              doc.doc_name || null,
              doc.doc_url,
              authUser.userId,
              JSON.stringify(doc.metadata || {}),
            ],
          );
        }
      }
    }

    // Dispatch notifications to matching vendors (if <= 10, notify all; if > 10, notify 10 nearest)
    try {
      let vendorQuery = `
                SELECT DISTINCT v.id AS vendor_id, v.user_id AS vendor_user_id, va.latitude, va.longitude
                FROM vendors v
                LEFT JOIN vendor_services vs ON vs.vendor_id = v.id AND vs.is_active = true
                LEFT JOIN services s ON s.id = vs.service_id
                LEFT JOIN (
                    SELECT DISTINCT ON (user_id) user_id, latitude, longitude
                    FROM addresses
                    ORDER BY user_id, created_at DESC
                ) va ON v.user_id = va.user_id
                WHERE v.approval_status = 'approved'
                  AND v.is_active = true
                  AND v.is_blocked = false
                  AND v.vendor_type IN ('service', 'both')
            `;
      const vParams: any[] = [];
      if (vendor_id) {
        vendorQuery += ` AND v.id = $1`;
        vParams.push(vendor_id);
      }
      if (category_id) {
        const categoryParam = vParams.length + 1;
        vParams.push(category_id);
        vendorQuery += ` AND EXISTS (
          SELECT 1 FROM vendor_service_category_selections coverage
          WHERE coverage.vendor_id = v.id
            AND coverage.service_category_id = $${categoryParam}
            AND coverage.service_subcategory_id IS NULL
        )`;
        if (resolvedServiceSubcategoryId) {
          const subcategoryParam = vParams.length + 1;
          vParams.push(resolvedServiceSubcategoryId);
          vendorQuery += ` AND EXISTS (
            SELECT 1 FROM vendor_service_category_selections coverage
            WHERE coverage.vendor_id = v.id
              AND coverage.service_category_id = $${categoryParam}
              AND coverage.service_subcategory_id = $${subcategoryParam}
          )`;
        }
        if (resolvedServiceSubSubcategoryId) {
          const childParam = vParams.length + 1;
          vParams.push(resolvedServiceSubSubcategoryId);
          vendorQuery += ` AND EXISTS (
            SELECT 1 FROM vendor_service_category_selections coverage
            WHERE coverage.vendor_id = v.id
              AND coverage.service_category_id = $${categoryParam}
              AND coverage.service_subcategory_id = $${childParam}
          )`;
        }
        if (serviceCategoryCode === "freelancer_work") {
          vendorQuery += ` AND EXISTS (SELECT 1 FROM vendor_services freelancer_vs JOIN services freelancer_s ON freelancer_s.id = freelancer_vs.service_id WHERE freelancer_vs.vendor_id = v.id AND freelancer_vs.is_active = true AND freelancer_s.category_id = $${categoryParam})`;
        }
      }
      if (requiresVendorFleet) {
        vendorQuery += ` AND EXISTS (SELECT 1 FROM vendor_logistics_vehicles vlv WHERE vlv.vendor_id = v.id AND vlv.vehicle_class_key = $${vParams.length + 1} AND vlv.is_active = true)`;
        vParams.push(vehicleClassKey);
      }

      const vendorRes = await pool.query(vendorQuery, vParams);
      let targetVendors = vendorRes.rows;

      if (targetVendors.length > 10) {
        const clientAddrRes = await pool.query(
          `SELECT latitude, longitude FROM addresses WHERE user_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          [authUser.userId],
        );
        const cLat =
          clientAddrRes.rows[0]?.latitude != null
            ? Number(clientAddrRes.rows[0].latitude)
            : null;
        const cLng =
          clientAddrRes.rows[0]?.longitude != null
            ? Number(clientAddrRes.rows[0].longitude)
            : null;

        if (cLat !== null && cLng !== null && !isNaN(cLat) && !isNaN(cLng)) {
          targetVendors = targetVendors.map((v) => {
            const vLat = v.latitude != null ? Number(v.latitude) : null;
            const vLng = v.longitude != null ? Number(v.longitude) : null;
            let dist = 99999;
            if (
              vLat !== null &&
              vLng !== null &&
              !isNaN(vLat) &&
              !isNaN(vLng)
            ) {
              const R = 6371;
              const dLat = (vLat - cLat) * (Math.PI / 180);
              const dLng = (vLng - cLng) * (Math.PI / 180);
              const a =
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(cLat * (Math.PI / 180)) *
                  Math.cos(vLat * (Math.PI / 180)) *
                  Math.sin(dLng / 2) *
                  Math.sin(dLng / 2);
              const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
              dist = R * c;
            }
            return { ...v, dist };
          });
          targetVendors.sort((a, b) => a.dist - b.dist);
        }
        targetVendors = targetVendors.slice(0, 10);
      }

      const jobTitleText = ticket_payload?.job_title || "Service Request";
      for (const v of targetVendors) {
        if (v.vendor_user_id) {
          await createNotification({
            userId: v.vendor_user_id,
            type: "quotation_request_received",
            title: "New Service Request Received",
            body: `New service category request received: "${jobTitleText}". Review and submit your bid!`,
            referenceType: "service_quotation",
            referenceId: createdTicket.id,
          }).catch((err) =>
            console.error("Error creating vendor notification:", err),
          );
        }
      }
    } catch (notifErr) {
      console.error(
        "Error dispatching vendor notifications for ticket:",
        notifErr,
      );
    }

    return res.status(201).json({
      success: true,
      message: `Service ticket ${ticketNumber} created successfully.`,
      data: createdTicket,
    });
  } catch (error) {
    console.error("Error creating service ticket:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create service ticket." });
  }
};

export const getMyServiceTickets = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const { status, category_id, page, limit } = req.query;
  const pageNum = Math.max(1, parseInt(String(page || "1"), 10));
  const limitNum = Math.min(
    50,
    Math.max(1, parseInt(String(limit || "20"), 10)),
  );
  const offset = (pageNum - 1) * limitNum;

  const conditions: string[] = [`st.client_user_id = $1`];
  const values: unknown[] = [authUser.userId];
  let idx = 2;

  if (status && typeof status === "string" && status.trim()) {
    conditions.push(`st.status = $${idx}`);
    values.push(status.trim());
    idx++;
  }

  if (category_id && typeof category_id === "string" && category_id.trim()) {
    conditions.push(`st.category_id = $${idx}`);
    values.push(category_id.trim());
    idx++;
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM service_tickets st ${whereClause}`,
      values,
    );
    const total = countResult.rows[0]?.total || 0;

    const result = await pool.query(
      `SELECT st.*,
                    sc.label AS category_name,
                    s.name AS subcategory_name,
                    service_sub.name AS service_subcategory_name,
                    service_child.name AS service_sub_subcategory_name,
                    v.company_name AS vendor_name,
                    ca.asset_name, ca.brand AS asset_brand, ca.model_number AS asset_model,
                    (SELECT COUNT(*)::int FROM service_ticket_quotations stq WHERE stq.ticket_id = st.id) AS quotes_count
             FROM service_tickets st
             LEFT JOIN service_categories sc ON sc.id = st.category_id
             LEFT JOIN subcategories s ON s.id = st.subcategory_id
             LEFT JOIN service_subcategories service_sub ON service_sub.id = st.service_subcategory_id
             LEFT JOIN service_subcategories service_child ON service_child.id = st.service_sub_subcategory_id
             LEFT JOIN vendors v ON v.id = st.vendor_id
             LEFT JOIN client_assets ca ON ca.id = st.asset_id
             ${whereClause}
             ORDER BY st.created_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limitNum, offset],
    );

    return res.status(200).json({
      success: true,
      data: result.rows,
      pagination: { page: pageNum, limit: limitNum, total },
    });
  } catch (error) {
    console.error("Error fetching service tickets:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load service tickets." });
  }
};

export const getServiceTicketDetail = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const { id } = req.params;

  try {
    const ticketResult = await pool.query(
      `SELECT st.*,
                    sc.label AS category_name,
                    s.name AS subcategory_name,
                    service_sub.name AS service_subcategory_name,
                    service_child.name AS service_sub_subcategory_name,
                    v.company_name AS vendor_name, v.phone AS vendor_phone,
                    ca.asset_name, ca.brand AS asset_brand, ca.model_number AS asset_model,
                    ca.serial_number AS asset_serial, ca.specs AS asset_specs,
                    agent.name AS agent_name, agent.email AS agent_email
             FROM service_tickets st
             LEFT JOIN service_categories sc ON sc.id = st.category_id
             LEFT JOIN subcategories s ON s.id = st.subcategory_id
             LEFT JOIN service_subcategories service_sub ON service_sub.id = st.service_subcategory_id
             LEFT JOIN service_subcategories service_child ON service_child.id = st.service_sub_subcategory_id
             LEFT JOIN vendors v ON v.id = st.vendor_id
             LEFT JOIN client_assets ca ON ca.id = st.asset_id
             LEFT JOIN users agent ON agent.id = st.assigned_agent_id
             WHERE st.id = $1 AND (st.client_user_id = $2 OR st.assigned_agent_id = $2 OR $3 = 'admin')`,
      [id, authUser.userId, authUser.role],
    );

    if (ticketResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found." });
    }
    const ticketRow = ticketResult.rows[0];

    // Fetch quotations
    const quotesResult = await pool.query(
      `SELECT stq.*, v.company_name AS vendor_name, v.rating AS vendor_rating
             FROM service_ticket_quotations stq
             JOIN vendors v ON v.id = stq.vendor_id
             WHERE stq.ticket_id = $1
             ORDER BY stq.created_at DESC`,
      [id],
    );

    let quotations = quotesResult.rows;

    // If ticket is already accepted/assigned, only return the assigned/accepted quotation
    if (
      ticketRow.vendor_id ||
      ["accepted", "in_progress", "completed"].includes(ticketRow.status)
    ) {
      quotations = quotations.filter(
        (q: any) =>
          q.status === "accepted" ||
          (ticketRow.vendor_id && q.vendor_id === ticketRow.vendor_id),
      );
    }

    // Fetch attached documents
    const docsResult = await pool.query(
      `SELECT std.*, u.name AS uploader_name
             FROM service_ticket_documents std
             LEFT JOIN users u ON u.id = std.uploaded_by_user_id
             WHERE std.ticket_id = $1
             ORDER BY std.created_at ASC`,
      [id],
    );

    return res.status(200).json({
      success: true,
      data: {
        ...ticketRow,
        ticket_payload: {
          ...(ticketRow.ticket_payload || {}),
          vehicle_image_url: ticketRow.ticket_payload?.vehicle_image_key
            ? await getPresignedUrlOrOriginal(ticketRow.ticket_payload.vehicle_image_key)
            : undefined,
        },
        quotations,
        documents: docsResult.rows,
      },
    });
  } catch (error) {
    console.error("Error fetching ticket detail:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load ticket detail." });
  }
};

// ────────────────────────────────────────────────────────────────────
// 4. QUOTE ACCEPTANCE & OTP COMPLETION
// ────────────────────────────────────────────────────────────────────
export const acceptTicketQuote = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });
  if (authUser.role !== "client")
    return res.status(403).json({
      success: false,
      message: "Only clients can accept maintenance quotations.",
    });

  const id = String(req.params.id);
  const quoteId = String(req.params.quoteId);

  const paidCheck = await pool.query(
    `SELECT 1 FROM payments WHERE user_id = $1 AND status = 'successful' AND payment_type IN ('service_maintenance', 'service_logistics', 'service_goods_ticket') AND $2 = ANY(booking_ids) AND $3 = ANY(order_ids) LIMIT 1`,
    [authUser.userId, id, quoteId],
  );
  if (paidCheck.rows.length === 0)
    return res.status(402).json({
      success: false,
      message: "Pay the accepted quotation before assigning the vendor.",
    });

  try {
    // Verify ticket belongs to client
    const ticketCheck = await pool.query(
      `SELECT id, status, vendor_id, timeline_logs FROM service_tickets WHERE id = $1 AND client_user_id = $2`,
      [id, authUser.userId],
    );
    if (ticketCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found or unauthorized." });
    }

    const ticketRow = ticketCheck.rows[0];
    if (
      ticketRow.vendor_id ||
      ["accepted", "in_progress", "completed"].includes(ticketRow.status)
    ) {
      return res.status(400).json({
        success: false,
        message: "An offer has already been accepted for this service request.",
      });
    }

    // Get quote details
    const quoteCheck = await pool.query(
      `SELECT * FROM service_ticket_quotations WHERE id = $1 AND ticket_id = $2`,
      [quoteId, id],
    );
    if (quoteCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found." });
    }

    const selectedQuote = quoteCheck.rows[0];

    // Update all quotes status
    await pool.query(
      `UPDATE service_ticket_quotations SET status = 'rejected' WHERE ticket_id = $1 AND id != $2`,
      [id, quoteId],
    );
    await pool.query(
      `UPDATE service_ticket_quotations SET status = 'accepted' WHERE id = $1`,
      [quoteId],
    );

    // Update ticket with agreed amount, vendor_id, and status
    const updatedTimeline = [
      ...(ticketCheck.rows[0].timeline_logs || []),
      {
        status: "accepted",
        note: `Quotation of ₹${selectedQuote.total_price} accepted by client. Work starting.`,
        timestamp: new Date().toISOString(),
        by_user_id: authUser.userId,
      },
    ];

    const result = await pool.query(
      `UPDATE service_tickets
             SET vendor_id = $1,
                 total_amount = $2,
                 quotation_breakdown = $3::jsonb,
                 status = 'accepted',
                 timeline_logs = $4::jsonb,
                 updated_at = NOW()
             WHERE id = $5
             RETURNING *`,
      [
        selectedQuote.vendor_id,
        selectedQuote.total_price,
        JSON.stringify(selectedQuote.quote_breakdown || {}),
        JSON.stringify(updatedTimeline),
        id,
      ],
    );

    // Notify accepted vendor
    const ticketIdStr = Array.isArray(id) ? id[0] : id;
    const acceptedVendorUserRes = await pool.query(
      `SELECT user_id FROM vendors WHERE id = $1 LIMIT 1`,
      [selectedQuote.vendor_id],
    );
    if (acceptedVendorUserRes.rows[0]?.user_id) {
      await createNotification({
        userId: acceptedVendorUserRes.rows[0].user_id,
        type: "quotation_accepted",
        title: "Quotation Accepted ✓",
        body: `Your quotation for service ticket ${result.rows[0].ticket_number || ""} was accepted by the client! Work is now in progress.`,
        referenceType: "service_ticket",
        referenceId: ticketIdStr,
      }).catch((err) => console.error("Error notifying accepted vendor:", err));
    }

    // Notify other vendors that request has been claimed by another vendor
    const otherQuotesRes = await pool.query(
      `SELECT DISTINCT v.user_id FROM service_ticket_quotations stq JOIN vendors v ON v.id = stq.vendor_id WHERE stq.ticket_id = $1 AND stq.vendor_id != $2`,
      [id, selectedQuote.vendor_id],
    );
    for (const row of otherQuotesRes.rows) {
      if (row.user_id) {
        await createNotification({
          userId: row.user_id,
          type: "quotation_rejected",
          title: "Service Request Claimed",
          body: `The service request "${result.rows[0].ticket_payload?.job_title || "Service Ticket"}" has been claimed and accepted by another vendor. Thank you for your response.`,
          referenceType: "service_ticket",
          referenceId: ticketIdStr,
        }).catch((err) => console.error("Error notifying other vendor:", err));
      }
    }

    return res.status(200).json({
      success: true,
      message:
        "Quotation accepted. The vendor has been assigned to start work.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error accepting quote:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to accept quotation." });
  }
};

export const createMaintenancePaymentOrder = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser || authUser.role !== "client")
    return res.status(403).json({
      success: false,
      message: "Only clients can pay maintenance quotations.",
    });
  const id = String(req.params.id);
  const quoteId = String(req.params.quoteId);
  try {
    const quote = await pool.query(
      `SELECT stq.total_price, stq.status, st.client_user_id, st.ticket_payload->>'service_code' AS service_code FROM service_ticket_quotations stq JOIN service_tickets st ON st.id = stq.ticket_id WHERE stq.id = $1 AND st.id = $2 AND st.client_user_id = $3`,
      [quoteId, id, authUser.userId],
    );
    if (!quote.rows[0])
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found." });
    if (["accepted", "rejected"].includes(quote.rows[0].status))
      return res.status(409).json({
        success: false,
        message: "This quotation is no longer available.",
      });
    const amount = Number(quote.rows[0].total_price);
    if (!Number.isFinite(amount) || amount <= 0)
      return res
        .status(400)
        .json({ success: false, message: "Quotation amount is invalid." });
    const serviceCode = quote.rows[0].service_code;
    const paymentType = serviceCode === "logistics" ? "service_logistics" : serviceCode === "goods_ticket_inquiry" ? "service_goods_ticket" : "service_maintenance";
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `${paymentType === "service_logistics" ? "log" : paymentType === "service_goods_ticket" ? "goods" : "maint"}_${id.slice(0, 8)}_${Date.now()}`,
      notes: { ticketId: id, quoteId, clientId: authUser.userId },
    });
    await pool.query(
      `INSERT INTO payments (user_id, amount, status, payment_method, razorpay_order_id, booking_ids, order_ids, payment_type) VALUES ($1, $2, 'pending', 'razorpay', $3, ARRAY[$4]::uuid[], ARRAY[$5]::uuid[], $6)`,
      [authUser.userId, amount, order.id, id, quoteId, paymentType],
    );
    return res.status(200).json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      razorpayOrderId: order.id,
    });
  } catch (error) {
    console.error("Error creating maintenance payment order:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create payment order." });
  }
};

export const verifyMaintenancePayment = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser || authUser.role !== "client")
    return res.status(403).json({
      success: false,
      message: "Only clients can verify maintenance payments.",
    });
  const id = String(req.params.id);
  const quoteId = String(req.params.quoteId);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({
      success: false,
      message: "Payment verification details are required.",
    });
  const client = await pool.connect();
  try {
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature)
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment signature." });
    await client.query("BEGIN");
    const paid = await client.query(
      `UPDATE payments SET status = 'successful', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = NOW() WHERE razorpay_order_id = $3 AND user_id = $4 AND payment_type IN ('service_maintenance', 'service_logistics', 'service_goods_ticket') AND $5 = ANY(booking_ids) AND $6 = ANY(order_ids) RETURNING amount`,
      [
        razorpay_payment_id,
        razorpay_signature,
        razorpay_order_id,
        authUser.userId,
        id,
        quoteId,
      ],
    );
    if (!paid.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Maintenance payment order not found.",
      });
    }
    const quote = await client.query(
      `SELECT stq.*, st.status AS ticket_status, st.vendor_id AS assigned_vendor FROM service_ticket_quotations stq JOIN service_tickets st ON st.id = stq.ticket_id WHERE stq.id = $1 AND stq.ticket_id = $2 AND st.client_user_id = $3 FOR UPDATE`,
      [quoteId, id, authUser.userId],
    );
    if (!quote.rows[0]) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Quotation not found." });
    }
    if (Number(paid.rows[0].amount) !== Number(quote.rows[0].total_price)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Payment amount does not match this quotation.",
      });
    }
    if (
      quote.rows[0].assigned_vendor &&
      quote.rows[0].assigned_vendor !== quote.rows[0].vendor_id
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Another quotation has already been accepted.",
      });
    }
    await client.query(
      `UPDATE service_ticket_quotations SET status = CASE WHEN id = $2 THEN 'accepted' ELSE 'rejected' END, updated_at = NOW() WHERE ticket_id = $1`,
      [id, quoteId],
    );
    const timeline = await client.query(
      `SELECT timeline_logs FROM service_tickets WHERE id = $1`,
      [id],
    );
    const logs = Array.isArray(timeline.rows[0]?.timeline_logs)
      ? timeline.rows[0].timeline_logs
      : [];
    logs.push({
      status: "accepted",
      note: `Quotation of ₹${quote.rows[0].total_price} paid and accepted by client.`,
      timestamp: new Date().toISOString(),
      by_user_id: authUser.userId,
    });
    const ticket = await client.query(
      `UPDATE service_tickets SET vendor_id = $1, total_amount = $2, advance_paid = $2, quotation_breakdown = $3::jsonb, status = 'accepted', timeline_logs = $4::jsonb, updated_at = NOW() WHERE id = $5 RETURNING *`,
      [
        quote.rows[0].vendor_id,
        quote.rows[0].total_price,
        JSON.stringify(quote.rows[0].quote_breakdown || {}),
        JSON.stringify(logs),
        id,
      ],
    );
    await client.query("COMMIT");
    const vendorUser = await pool.query(
      `SELECT user_id FROM vendors WHERE id = $1 LIMIT 1`,
      [quote.rows[0].vendor_id],
    );
    if (vendorUser.rows[0]?.user_id) {
      await createNotification({
        userId: vendorUser.rows[0].user_id,
        type: "quotation_accepted",
        title: "Quotation Accepted ✓",
        body: `Your quotation for service ticket ${ticket.rows[0].ticket_number || ""} was paid and accepted by the client.`,
        referenceType: "service_ticket",
        referenceId: id,
      }).catch((error) =>
        console.error("Error notifying maintenance vendor:", error),
      );
    }
    return res.status(200).json({
      success: true,
      message: "Payment verified and quotation accepted.",
      data: ticket.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error verifying maintenance payment:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify maintenance payment.",
    });
  } finally {
    client.release();
  }
};

export const createJobInquiryPaymentOrder = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser || authUser.role !== "client")
    return res
      .status(403)
      .json({
        success: false,
        message: "Only clients can pay job inquiry quotations.",
      });
  const id = String(req.params.id);
  const quoteId = String(req.params.quoteId);
  const stage = req.body?.stage === "final" ? "final" : "advance";
  try {
    const result = await pool.query(
      `SELECT stq.total_price, stq.status AS quote_status, st.status AS ticket_status, st.client_user_id FROM service_ticket_quotations stq JOIN service_tickets st ON st.id = stq.ticket_id WHERE stq.id = $1 AND st.id = $2 AND st.client_user_id = $3 AND (st.ticket_payload->>'service_code' = 'job_inquiry' OR st.ticket_payload->>'service_name' = 'Job Inquiry')`,
      [quoteId, id, authUser.userId],
    );
    const row = result.rows[0];
    if (!row)
      return res
        .status(404)
        .json({ success: false, message: "Job inquiry quotation not found." });
    if (stage === "advance" && row.quote_status !== "pending")
      return res
        .status(409)
        .json({
          success: false,
          message: "This quotation is no longer available.",
        });
    if (
      stage === "final" &&
      (row.quote_status !== "accepted" || row.ticket_status !== "completed")
    )
      return res
        .status(409)
        .json({
          success: false,
          message:
            "Final payment is available after the accepted service is completed.",
        });
    const alreadyPaid = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS amount FROM payments WHERE user_id = $1 AND status = 'successful' AND payment_type = 'service_job_inquiry' AND $2 = ANY(booking_ids) AND $3 = ANY(order_ids)`,
      [authUser.userId, id, quoteId],
    );
    const total = Number(row.total_price);
    const due =
      stage === "advance"
        ? Math.round(total * 0.25 * 100) / 100
        : Math.max(
            0,
            Math.round((total - Number(alreadyPaid.rows[0].amount)) * 100) /
              100,
          );
    if (stage === "final" && Number(alreadyPaid.rows[0].amount) < total * 0.2)
      return res
        .status(409)
        .json({
          success: false,
          message: "Pay the 25% confirmation amount first.",
        });
    if (due <= 0)
      return res
        .status(409)
        .json({ success: false, message: "No payment is due for this stage." });
    const order: any = await (razorpay.orders.create as any)({
      amount: Math.round(due * 100),
      currency: "INR",
      receipt: `job_${id.slice(0, 8)}_${stage}_${Date.now()}`,
      notes: { ticketId: id, quoteId, clientId: authUser.userId, stage },
    });
    await pool.query(
      `INSERT INTO payments (user_id, amount, status, payment_method, razorpay_order_id, booking_ids, order_ids, payment_type) VALUES ($1, $2, 'pending', 'razorpay', $3, ARRAY[$4]::uuid[], ARRAY[$5]::uuid[], 'service_job_inquiry')`,
      [authUser.userId, due, order.id, id, quoteId],
    );
    return res
      .status(200)
      .json({
        success: true,
        keyId: process.env.RAZORPAY_KEY_ID,
        amount: order.amount,
        currency: order.currency,
        razorpayOrderId: order.id,
        stage,
        due,
      });
  } catch (error) {
    console.error("Error creating job inquiry payment order:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create payment order." });
  }
};

export const verifyJobInquiryPayment = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser || authUser.role !== "client")
    return res
      .status(403)
      .json({
        success: false,
        message: "Only clients can verify job inquiry payments.",
      });
  const id = String(req.params.id);
  const quoteId = String(req.params.quoteId);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res
      .status(400)
      .json({
        success: false,
        message: "Payment verification details are required.",
      });
  const client = await pool.connect();
  try {
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature)
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment signature." });
    await client.query("BEGIN");
    const payment = await client.query(
      `UPDATE payments SET status = 'successful', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = NOW() WHERE razorpay_order_id = $3 AND user_id = $4 AND payment_type = 'service_job_inquiry' AND $5 = ANY(booking_ids) AND $6 = ANY(order_ids) RETURNING amount`,
      [
        razorpay_payment_id,
        razorpay_signature,
        razorpay_order_id,
        authUser.userId,
        id,
        quoteId,
      ],
    );
    if (!payment.rows[0]) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({
          success: false,
          message: "Job inquiry payment order not found.",
        });
    }
    const rowResult = await client.query(
      `SELECT stq.*, st.status AS ticket_status, st.vendor_id AS assigned_vendor, st.timeline_logs, st.ticket_number FROM service_ticket_quotations stq JOIN service_tickets st ON st.id = stq.ticket_id WHERE stq.id = $1 AND stq.ticket_id = $2 AND st.client_user_id = $3 AND (st.ticket_payload->>'service_code' = 'job_inquiry' OR st.ticket_payload->>'service_name' = 'Job Inquiry') FOR UPDATE`,
      [quoteId, id, authUser.userId],
    );
    const quote = rowResult.rows[0];
    if (!quote) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Job inquiry quotation not found." });
    }
    const paidTotal = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS amount FROM payments WHERE user_id = $1 AND status = 'successful' AND payment_type = 'service_job_inquiry' AND $2 = ANY(booking_ids) AND $3 = ANY(order_ids)`,
      [authUser.userId, id, quoteId],
    );
    const total = Number(quote.total_price);
    const logs = Array.isArray(quote.timeline_logs) ? quote.timeline_logs : [];
    if (!quote.assigned_vendor) {
      if (
        Number(payment.rows[0].amount) < total * 0.2 ||
        quote.status === "rejected"
      ) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({
            success: false,
            message: "Advance payment does not match this quotation.",
          });
      }
      await client.query(
        `UPDATE service_ticket_quotations SET status = CASE WHEN id = $2 THEN 'accepted' ELSE 'rejected' END, updated_at = NOW() WHERE ticket_id = $1`,
        [id, quoteId],
      );
      logs.push({
        status: "accepted",
        note: `25% confirmation payment received for quotation ₹${total}.`,
        timestamp: new Date().toISOString(),
        by_user_id: authUser.userId,
      });
      const ticket = await client.query(
        `UPDATE service_tickets SET vendor_id = $1, total_amount = $2, advance_paid = $3, quotation_breakdown = $4::jsonb, status = 'accepted', timeline_logs = $5::jsonb, updated_at = NOW() WHERE id = $6 RETURNING *`,
        [
          quote.vendor_id,
          total,
          Number(payment.rows[0].amount),
          JSON.stringify(quote.quote_breakdown || {}),
          JSON.stringify(logs),
          id,
        ],
      );
      await client.query("COMMIT");
      return res
        .status(200)
        .json({
          success: true,
          message: "25% payment confirmed and vendor assigned.",
          data: ticket.rows[0],
        });
    }
    if (
      quote.assigned_vendor !== quote.vendor_id ||
      quote.ticket_status !== "completed" ||
      Number(paidTotal.rows[0].amount) < total * 0.99
    ) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({
          success: false,
          message: "Final payment does not match the completed job inquiry.",
        });
    }
    logs.push({
      status: "payment_completed",
      note: `Remaining payment received. Total paid ₹${paidTotal.rows[0].amount}.`,
      timestamp: new Date().toISOString(),
      by_user_id: authUser.userId,
    });
    const ticket = await client.query(
      `UPDATE service_tickets SET advance_paid = $1, timeline_logs = $2::jsonb, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [Number(paidTotal.rows[0].amount), JSON.stringify(logs), id],
    );
    await client.query("COMMIT");
    return res
      .status(200)
      .json({
        success: true,
        message: "Final payment verified.",
        data: ticket.rows[0],
      });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error verifying job inquiry payment:", error);
    return res
      .status(500)
      .json({
        success: false,
        message: "Failed to verify job inquiry payment.",
      });
  } finally {
    client.release();
  }
};

export const verifyTicketOtp = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const authUser = getAuthUser(req);
  if (!authUser)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required." });

  const { id } = req.params;
  const { otp, notes } = req.body;

  if (!otp) {
    return res
      .status(400)
      .json({ success: false, message: "Completion OTP is required." });
  }

  try {
    const ticketCheck = await pool.query(
      `SELECT id, completion_otp, status, timeline_logs, client_user_id, ticket_number FROM service_tickets WHERE id = $1`,
      [id],
    );

    if (ticketCheck.rows.length === 0) {
      // Check legacy service_quotations table
      const sqCheck = await pool.query(
        `SELECT id, user_id, status FROM service_quotations WHERE id = $1`,
        [id],
      );
      if (sqCheck.rows.length > 0) {
        const sq = sqCheck.rows[0];
        await pool.query(
          `UPDATE service_quotations SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [id],
        );
        if (sq.user_id) {
          await createNotification({
            userId: sq.user_id,
            type: "service_completed",
            title: "Service Completed 🎉",
            body: `Your service request has been verified and marked as completed by the vendor. Thank you!`,
            referenceType: "service_quotation",
            referenceId: sq.id,
          }).catch((err) =>
            console.error("Error sending completion notification:", err),
          );
        }
        return res.status(200).json({
          success: true,
          message: "Service verified and marked as completed!",
        });
      }
      return res
        .status(404)
        .json({ success: false, message: "Ticket or quotation not found." });
    }

    const ticket = ticketCheck.rows[0];

    if (ticket.status === "completed") {
      return res
        .status(400)
        .json({ success: false, message: "Ticket is already completed." });
    }

    if (ticket.completion_otp && ticket.completion_otp !== String(otp).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid OTP code." });
    }

    const updatedTimeline = [
      ...(ticket.timeline_logs || []),
      {
        status: "completed",
        note: notes || "Service verified and completed via OTP.",
        timestamp: new Date().toISOString(),
        by_user_id: authUser.userId,
      },
    ];

    const result = await pool.query(
      `UPDATE service_tickets
             SET status = 'completed',
                 otp_verified_at = NOW(),
                 timeline_logs = $1::jsonb,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
      [JSON.stringify(updatedTimeline), id],
    );

    const completedTicket = result.rows[0];
    if (completedTicket && completedTicket.client_user_id) {
      await createNotification({
        userId: completedTicket.client_user_id,
        type: "service_completed",
        title: "Service Completed 🎉",
        body: `Your service request "${completedTicket.ticket_number || "Service Ticket"}" has been verified and marked as completed by the vendor. Thank you!`,
        referenceType: "service_ticket",
        referenceId: completedTicket.id,
      }).catch((err) =>
        console.error("Error sending completion notification:", err),
      );
    }

    return res.status(200).json({
      success: true,
      message: "Service verified and marked as completed!",
      data: completedTicket,
    });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to complete service." });
  }
};

import type { Request, Response } from "express";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

function authUser(req: Request): { userId: string; role: string } | null {
  const user = (req as any).user;
  return user?.userId ? user : null;
}

async function vendorIdForUser(userId: string) {
  const result = await pool.query("SELECT id FROM vendors WHERE user_id = $1 AND approval_status = 'approved' AND is_active = true AND is_blocked = false AND vendor_type IN ('service', 'both') LIMIT 1", [userId]);
  return result.rows[0]?.id as string | undefined;
}

function normalizeClass(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function getAvailableLogisticsVehicleClasses(req: Request, res: Response) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Authentication required." });
  if (user.role !== "client") return res.status(403).json({ success: false, message: "Only clients can browse logistics vehicles." });
  try {
    const result = await pool.query(
      `SELECT v.vehicle_class_key, MIN(v.vehicle_class) AS vehicle_class,
              COUNT(DISTINCT v.vendor_id)::int AS vendor_count,
              (ARRAY_AGG(v.vehicle_name ORDER BY v.created_at DESC))[1] AS vehicle_name,
              (ARRAY_AGG(v.payload ORDER BY v.created_at DESC))[1] AS payload,
              (ARRAY_AGG(v.dimensions ORDER BY v.created_at DESC))[1] AS dimensions,
              (ARRAY_AGG(v.image_key ORDER BY v.created_at DESC))[1] AS image_key
       FROM vendor_logistics_vehicles v
       JOIN vendors supplier ON supplier.id = v.vendor_id
       WHERE v.is_active = true AND supplier.approval_status = 'approved'
         AND supplier.is_active = true AND supplier.is_blocked = false
         AND supplier.vendor_type IN ('service', 'both')
       GROUP BY v.vehicle_class_key ORDER BY MIN(v.vehicle_class)`
    );
    const data = await Promise.all(result.rows.map(async (row) => ({ ...row, image_url: await getPresignedUrlOrOriginal(row.image_key) })));
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error loading available logistics vehicle classes:", error);
    return res.status(500).json({ success: false, message: "Failed to load available vehicles." });
  }
}

export async function getMyLogisticsVehicles(req: Request, res: Response) {
  const user = authUser(req);
  if (!user || user.role !== "vendor") return res.status(403).json({ success: false, message: "Only vendors can access fleet vehicles." });
  try {
    const vendorId = await vendorIdForUser(user.userId);
    if (!vendorId) return res.status(403).json({ success: false, message: "An approved vendor profile is required." });
    const result = await pool.query("SELECT * FROM vendor_logistics_vehicles WHERE vendor_id = $1 AND is_active = true ORDER BY created_at DESC", [vendorId]);
    const data = await Promise.all(result.rows.map(async (row) => ({ ...row, image_url: await getPresignedUrlOrOriginal(row.image_key) })));
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error loading vendor logistics vehicles:", error);
    return res.status(500).json({ success: false, message: "Failed to load fleet vehicles." });
  }
}

export async function createLogisticsVehicle(req: Request, res: Response) {
  const user = authUser(req);
  if (!user || user.role !== "vendor") return res.status(403).json({ success: false, message: "Only vendors can add fleet vehicles." });
  const { vehicle_class, vehicle_name, payload, dimensions, image_key } = req.body || {};
  const cleanClass = typeof vehicle_class === "string" ? vehicle_class.trim().slice(0, 120) : "";
  const cleanName = typeof vehicle_name === "string" ? vehicle_name.trim().slice(0, 160) : "";
  const cleanPayload = typeof payload === "string" ? payload.trim().slice(0, 120) : "";
  const cleanDimensions = typeof dimensions === "string" ? dimensions.trim().slice(0, 160) : "";
  const cleanImageKey = typeof image_key === "string" ? image_key.trim() : "";
  const classKey = normalizeClass(cleanClass);
  if (!cleanClass || !cleanName || !cleanPayload || !cleanDimensions || !/^uploads\/[a-zA-Z0-9._/-]+$/.test(cleanImageKey) || !classKey) {
    return res.status(400).json({ success: false, message: "Enter vehicle class, name, payload, dimensions, and upload its image." });
  }
  try {
    const vendorId = await vendorIdForUser(user.userId);
    if (!vendorId) return res.status(403).json({ success: false, message: "An approved vendor profile is required." });
    const result = await pool.query(
      `INSERT INTO vendor_logistics_vehicles (vendor_id, vehicle_class_key, vehicle_class, vehicle_name, payload, dimensions, image_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [vendorId, classKey, cleanClass, cleanName, cleanPayload, cleanDimensions, cleanImageKey],
    );
    const row = result.rows[0];
    return res.status(201).json({ success: true, data: { ...row, image_url: await getPresignedUrlOrOriginal(row.image_key) } });
  } catch (error) {
    console.error("Error adding vendor logistics vehicle:", error);
    return res.status(500).json({ success: false, message: "Failed to add fleet vehicle." });
  }
}

export async function deactivateLogisticsVehicle(req: Request, res: Response) {
  const user = authUser(req);
  if (!user || user.role !== "vendor") return res.status(403).json({ success: false, message: "Only vendors can remove fleet vehicles." });
  try {
    const vendorId = await vendorIdForUser(user.userId);
    if (!vendorId) return res.status(403).json({ success: false, message: "An approved vendor profile is required." });
    const result = await pool.query("UPDATE vendor_logistics_vehicles SET is_active = false, updated_at = NOW() WHERE id = $1 AND vendor_id = $2 RETURNING id", [req.params.id, vendorId]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Vehicle not found." });
    return res.status(200).json({ success: true, message: "Vehicle removed from fleet." });
  } catch (error) {
    console.error("Error removing vendor logistics vehicle:", error);
    return res.status(500).json({ success: false, message: "Failed to remove fleet vehicle." });
  }
}

import type { NextFunction, Request, Response } from "express";
import pool from "../DbConnect";

type VendorApprovalStatus = "pending" | "agreement_sent" | "approved" | "rejected" | "reconsideration";

const ALLOWED_VENDOR_STATUSES = new Set<VendorApprovalStatus>([
    "pending",
    "agreement_sent",
    "approved",
    "rejected",
    "reconsideration",
]);

export const getVendorApprovalStatusByUserId = async (userId: string): Promise<VendorApprovalStatus | null> => {
    const result = await pool.query(
        `SELECT approval_status FROM vendors WHERE user_id = $1 LIMIT 1`,
        [userId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const status = String(result.rows[0].approval_status || "pending").toLowerCase() as VendorApprovalStatus;

    if (!ALLOWED_VENDOR_STATUSES.has(status)) {
        return "pending";
    }

    return status;
};

export const requireApprovedVendor = async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
    const user = (req as any).user;
    const userId = user?.userId as string | undefined;
    const role = user?.role as string | undefined;

    if (!userId) {
        return res.status(401).json({ message: "Unauthorized! User not found in token." });
    }

    if (role !== "vendor") {
        return res.status(403).json({ message: "Forbidden! Only vendors can access this resource." });
    }

    try {
        const approvalStatus = await getVendorApprovalStatusByUserId(userId);

        if (!approvalStatus) {
            return res.status(404).json({ message: "Vendor profile not found.", approval_status: "pending" });
        }

        if (approvalStatus !== "approved") {
            return res.status(403).json({
                message: "Vendor is not approved yet.",
                approval_status: approvalStatus,
            });
        }

        return next();
    }
    catch (error) {
        console.error("Error validating vendor approval status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

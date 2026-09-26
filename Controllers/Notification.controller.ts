import type { Request, Response } from "express";
import pool from "../DbConnect";
import { sendNotificationToUser } from "../socket";

export const getNotificationsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId) {
        return res.status(403).json({ message: "Authentication required" });
    }

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const cursor = req.query.cursor as string | undefined; // ISO timestamp cursor

    try {
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_read = FALSE) AS unread FROM notifications WHERE user_id = $1`,
            [authUser.userId]
        );

        let result;
        if (cursor) {
            // Cursor-based: fetch notifications older than the cursor
            result = await pool.query(
                `SELECT id, type, title, body, reference_type, reference_id, is_read, created_at
                 FROM notifications
                 WHERE user_id = $1 AND created_at < $2
                 ORDER BY created_at DESC
                 LIMIT $3`,
                [authUser.userId, cursor, limit]
            );
        } else {
            // First page: no cursor
            result = await pool.query(
                `SELECT id, type, title, body, reference_type, reference_id, is_read, created_at
                 FROM notifications
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [authUser.userId, limit]
            );
        }

        const rows = result.rows;
        const hasMore = rows.length === limit;
        const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].created_at : null;

        return res.status(200).json({
            data: {
                notifications: rows,
                total: Number(countResult.rows[0].total),
                unread: Number(countResult.rows[0].unread),
                hasMore,
                nextCursor,
            },
        });
    } catch (error) {
        console.error("Error fetching notifications:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getUnreadCountController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId) {
        return res.status(403).json({ message: "Authentication required" });
    }

    try {
        const result = await pool.query(
            `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
            [authUser.userId]
        );

        return res.status(200).json({ data: { unread: Number(result.rows[0].unread) } });
    } catch (error) {
        console.error("Error fetching unread count:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const markNotificationReadController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId) {
        return res.status(403).json({ message: "Authentication required" });
    }

    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ message: "Notification ID is required" });
    }

    try {
        await pool.query(
            `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
            [id, authUser.userId]
        );

        return res.status(200).json({ message: "Notification marked as read" });
    } catch (error) {
        console.error("Error marking notification as read:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const markAllNotificationsReadController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = (req as any).user;
    if (!authUser?.userId) {
        return res.status(403).json({ message: "Authentication required" });
    }

    try {
        await pool.query(
            `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
            [authUser.userId]
        );

        return res.status(200).json({ message: "All notifications marked as read" });
    } catch (error) {
        console.error("Error marking all notifications as read:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

// Helper to create notifications (used by other controllers)
export async function createNotification(params: {
    userId: string;
    type: string;
    title: string;
    body: string;
    referenceType?: string;
    referenceId?: string;
}): Promise<void> {
    try {
        let result;
        try {
            result = await pool.query(
                `INSERT INTO notifications (user_id, type, title, body, reference_type, reference_id)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, type, title, body, reference_type, reference_id, is_read, created_at`,
                [params.userId, params.type, params.title, params.body, params.referenceType || null, params.referenceId || null]
            );
        } catch (dbErr: any) {
            console.warn(`[createNotification] Initial insert failed (${dbErr.message}), retrying with general fallback...`);
            result = await pool.query(
                `INSERT INTO notifications (user_id, type, title, body, reference_type, reference_id)
                 VALUES ($1, 'general', $2, $3, $4, $5)
                 RETURNING id, type, title, body, reference_type, reference_id, is_read, created_at`,
                [params.userId, params.title, params.body, params.referenceType || null, params.referenceId || null]
            );
        }
        
        if (result && result.rows.length > 0) {
            sendNotificationToUser(params.userId, result.rows[0]);
        }
    } catch (error) {
        console.error("Error creating notification:", error);
    }
}

// Helper to notify all admins
export async function notifyAllAdmins(params: {
    type: string;
    title: string;
    body: string;
    referenceType?: string;
    referenceId?: string;
}): Promise<void> {
    try {
        const adminResult = await pool.query(
            `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND is_active = TRUE`
        );

        for (const admin of adminResult.rows) {
            await createNotification({
                userId: admin.id,
                type: params.type,
                title: params.title,
                body: params.body,
                referenceType: params.referenceType,
                referenceId: params.referenceId,
            });
        }
    } catch (error) {
        console.error("Error notifying admins:", error);
    }
}

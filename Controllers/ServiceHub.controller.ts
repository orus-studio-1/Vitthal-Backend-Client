import type { Request, Response } from "express";
import pool from "../DbConnect";
import { getPresignedUrlOrOriginal } from "../services/s3.service";

type AuthUser = { userId: string; role: string; email?: string };

function getAuthUser(req: Request): AuthUser | null {
    const user = (req as any).user;
    if (!user?.userId) return null;
    return user as AuthUser;
}

// ────────────────────────────────────────────────────────────────────
// 1. DYNAMIC CATEGORIES & SUB-CATEGORIES WITH FORM SCHEMAS
// ────────────────────────────────────────────────────────────────────
export const getServiceCategoriesWithSchema = async (_req: Request, res: Response): Promise<Response> => {
    try {
        const categoriesResult = await pool.query(
            `SELECT pc.id, pc.code, pc.label, pc.description, pc.image,
                    pc.category_type, pc.sort_order,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', s.id,
                                'name', s.name,
                                'description', s.description,
                                'form_schema', COALESCE(s.form_schema, '[]'::jsonb)
                            )
                        ) FILTER (WHERE s.id IS NOT NULL), '[]'
                    ) AS subcategories
             FROM product_category pc
             LEFT JOIN subcategories s ON s.category_id = pc.id
             WHERE pc.category_type = 'service' AND pc.is_active = true
             GROUP BY pc.id
             ORDER BY pc.sort_order ASC, pc.label ASC`
        );

        const rows = await Promise.all(
            categoriesResult.rows.map(async (row) => ({
                ...row,
                image: await getPresignedUrlOrOriginal(row.image),
            }))
        );

        return res.status(200).json({
            success: true,
            data: rows,
        });
    } catch (error) {
        console.error("Error fetching service categories:", error);
        return res.status(500).json({ success: false, message: "Failed to load service categories." });
    }
};

// ────────────────────────────────────────────────────────────────────
// 2. CLIENT ASSET REGISTRY (MACHINERY / EQUIPMENT / FLEET)
// ────────────────────────────────────────────────────────────────────
export const getMyAssets = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    try {
        const result = await pool.query(
            `SELECT ca.*, pc.label AS category_name, s.name AS subcategory_name
             FROM client_assets ca
             LEFT JOIN product_category pc ON pc.id = ca.category_id
             LEFT JOIN subcategories s ON s.id = ca.subcategory_id
             WHERE ca.user_id = $1 AND ca.is_active = true
             ORDER BY ca.created_at DESC`,
            [authUser.userId]
        );

        return res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching client assets:", error);
        return res.status(500).json({ success: false, message: "Failed to load assets." });
    }
};

export const createClientAsset = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const {
        asset_name, asset_code, brand, model_number, serial_number,
        installation_year, category_id, subcategory_id, specs,
        location_details, documents,
    } = req.body;

    if (!asset_name) {
        return res.status(400).json({ success: false, message: "asset_name is required." });
    }

    try {
        const result = await pool.query(
            `INSERT INTO client_assets
                (user_id, category_id, subcategory_id, asset_name, asset_code,
                 brand, model_number, serial_number, installation_year,
                 specs, location_details, documents)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)
             RETURNING *`,
            [
                authUser.userId,
                category_id || null,
                subcategory_id || null,
                asset_name.trim(),
                asset_code?.trim() || null,
                brand?.trim() || null,
                model_number?.trim() || null,
                serial_number?.trim() || null,
                installation_year ? Number(installation_year) : null,
                JSON.stringify(specs || {}),
                JSON.stringify(location_details || {}),
                JSON.stringify(Array.isArray(documents) ? documents : []),
            ]
        );

        return res.status(201).json({
            success: true,
            message: "Asset registered successfully.",
            data: result.rows[0],
        });
    } catch (error) {
        console.error("Error creating asset:", error);
        return res.status(500).json({ success: false, message: "Failed to register asset." });
    }
};

export const updateClientAsset = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const { id } = req.params;
    const {
        asset_name, asset_code, brand, model_number, serial_number,
        installation_year, category_id, subcategory_id, specs,
        location_details, documents,
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
                 subcategory_id = COALESCE($8, subcategory_id),
                 specs = COALESCE($9::jsonb, specs),
                 location_details = COALESCE($10::jsonb, location_details),
                 documents = COALESCE($11::jsonb, documents),
                 updated_at = NOW()
             WHERE id = $12 AND user_id = $13
             RETURNING *`,
            [
                asset_name?.trim() || null,
                asset_code?.trim() || null,
                brand?.trim() || null,
                model_number?.trim() || null,
                serial_number?.trim() || null,
                installation_year ? Number(installation_year) : null,
                category_id || null,
                subcategory_id || null,
                specs ? JSON.stringify(specs) : null,
                location_details ? JSON.stringify(location_details) : null,
                documents ? JSON.stringify(documents) : null,
                id,
                authUser.userId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Asset not found or unauthorized." });
        }

        return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error updating asset:", error);
        return res.status(500).json({ success: false, message: "Failed to update asset." });
    }
};

export const deleteClientAsset = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE client_assets SET is_active = false, updated_at = NOW()
             WHERE id = $1 AND user_id = $2 RETURNING id`,
            [id, authUser.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Asset not found or unauthorized." });
        }

        return res.status(200).json({ success: true, message: "Asset removed." });
    } catch (error) {
        console.error("Error deleting asset:", error);
        return res.status(500).json({ success: false, message: "Failed to delete asset." });
    }
};

// ────────────────────────────────────────────────────────────────────
// 3. UNIVERSAL SERVICE TICKETS (INTAKE, RETRIEVAL, OTP VERIFICATION)
// ────────────────────────────────────────────────────────────────────
export const createServiceTicket = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const {
        category_id, subcategory_id, vendor_id, asset_id,
        priority, ticket_payload, documents,
    } = req.body;

    if (!category_id) {
        return res.status(400).json({ success: false, message: "category_id is required." });
    }

    try {
        // Generate friendly ticket number: SRV-YYYYMMDD-XXXX
        const prefix = "SRV";
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const ticketNumber = `${prefix}-${dateStr}-${randomNum}`;

        // 6-digit OTP for secure completion
        const completionOtp = Math.floor(100000 + Math.random() * 900000).toString();

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
                (ticket_number, category_id, subcategory_id, client_user_id, vendor_id,
                 asset_id, status, priority, ticket_payload, completion_otp, timeline_logs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
             RETURNING *`,
            [
                ticketNumber,
                category_id,
                subcategory_id || null,
                authUser.userId,
                vendor_id || null,
                asset_id || null,
                initialStatus,
                priority || "medium",
                JSON.stringify(ticket_payload || {}),
                completionOtp,
                JSON.stringify(initialTimeline),
            ]
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
                        ]
                    );
                }
            }
        }

        return res.status(201).json({
            success: true,
            message: `Service ticket ${ticketNumber} created successfully.`,
            data: createdTicket,
        });
    } catch (error) {
        console.error("Error creating service ticket:", error);
        return res.status(500).json({ success: false, message: "Failed to create service ticket." });
    }
};

export const getMyServiceTickets = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const { status, category_id, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(String(limit || "20"), 10)));
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
            values
        );
        const total = countResult.rows[0]?.total || 0;

        const result = await pool.query(
            `SELECT st.*,
                    pc.label AS category_name,
                    s.name AS subcategory_name,
                    v.company_name AS vendor_name,
                    ca.asset_name, ca.brand AS asset_brand, ca.model_number AS asset_model,
                    (SELECT COUNT(*)::int FROM service_ticket_quotations stq WHERE stq.ticket_id = st.id) AS quotes_count
             FROM service_tickets st
             LEFT JOIN product_category pc ON pc.id = st.category_id
             LEFT JOIN subcategories s ON s.id = st.subcategory_id
             LEFT JOIN vendors v ON v.id = st.vendor_id
             LEFT JOIN client_assets ca ON ca.id = st.asset_id
             ${whereClause}
             ORDER BY st.created_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
            [...values, limitNum, offset]
        );

        return res.status(200).json({
            success: true,
            data: result.rows,
            pagination: { page: pageNum, limit: limitNum, total },
        });
    } catch (error) {
        console.error("Error fetching service tickets:", error);
        return res.status(500).json({ success: false, message: "Failed to load service tickets." });
    }
};

export const getServiceTicketDetail = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const { id } = req.params;

    try {
        const ticketResult = await pool.query(
            `SELECT st.*,
                    pc.label AS category_name,
                    s.name AS subcategory_name,
                    v.company_name AS vendor_name, v.phone AS vendor_phone,
                    ca.asset_name, ca.brand AS asset_brand, ca.model_number AS asset_model,
                    ca.serial_number AS asset_serial, ca.specs AS asset_specs,
                    agent.name AS agent_name, agent.email AS agent_email
             FROM service_tickets st
             LEFT JOIN product_category pc ON pc.id = st.category_id
             LEFT JOIN subcategories s ON s.id = st.subcategory_id
             LEFT JOIN vendors v ON v.id = st.vendor_id
             LEFT JOIN client_assets ca ON ca.id = st.asset_id
             LEFT JOIN users agent ON agent.id = st.assigned_agent_id
             WHERE st.id = $1 AND (st.client_user_id = $2 OR st.assigned_agent_id = $2 OR $3 = 'admin')`,
            [id, authUser.userId, authUser.role]
        );

        if (ticketResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Ticket not found." });
        }

        // Fetch quotations
        const quotesResult = await pool.query(
            `SELECT stq.*, v.company_name AS vendor_name, v.rating AS vendor_rating
             FROM service_ticket_quotations stq
             JOIN vendors v ON v.id = stq.vendor_id
             WHERE stq.ticket_id = $1
             ORDER BY stq.created_at DESC`,
            [id]
        );

        // Fetch attached documents
        const docsResult = await pool.query(
            `SELECT std.*, u.name AS uploader_name
             FROM service_ticket_documents std
             LEFT JOIN users u ON u.id = std.uploaded_by_user_id
             WHERE std.ticket_id = $1
             ORDER BY std.created_at ASC`,
            [id]
        );

        return res.status(200).json({
            success: true,
            data: {
                ...ticketResult.rows[0],
                quotations: quotesResult.rows,
                documents: docsResult.rows,
            },
        });
    } catch (error) {
        console.error("Error fetching ticket detail:", error);
        return res.status(500).json({ success: false, message: "Failed to load ticket detail." });
    }
};

// ────────────────────────────────────────────────────────────────────
// 4. QUOTE ACCEPTANCE & OTP COMPLETION
// ────────────────────────────────────────────────────────────────────
export const acceptTicketQuote = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const { id, quoteId } = req.params;

    try {
        // Verify ticket belongs to client
        const ticketCheck = await pool.query(
            `SELECT id, status, timeline_logs FROM service_tickets WHERE id = $1 AND client_user_id = $2`,
            [id, authUser.userId]
        );
        if (ticketCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Ticket not found or unauthorized." });
        }

        // Get quote details
        const quoteCheck = await pool.query(
            `SELECT * FROM service_ticket_quotations WHERE id = $1 AND ticket_id = $2`,
            [quoteId, id]
        );
        if (quoteCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Quotation not found." });
        }

        const selectedQuote = quoteCheck.rows[0];

        // Update all quotes status
        await pool.query(
            `UPDATE service_ticket_quotations SET status = 'rejected' WHERE ticket_id = $1 AND id != $2`,
            [id, quoteId]
        );
        await pool.query(
            `UPDATE service_ticket_quotations SET status = 'accepted' WHERE id = $1`,
            [quoteId]
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
            ]
        );

        return res.status(200).json({
            success: true,
            message: "Quotation accepted. The vendor has been assigned to start work.",
            data: result.rows[0],
        });
    } catch (error) {
        console.error("Error accepting quote:", error);
        return res.status(500).json({ success: false, message: "Failed to accept quotation." });
    }
};

export const verifyTicketOtp = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

    const { id } = req.params;
    const { otp, notes } = req.body;

    if (!otp) {
        return res.status(400).json({ success: false, message: "Completion OTP is required." });
    }

    try {
        const ticketCheck = await pool.query(
            `SELECT id, completion_otp, status, timeline_logs FROM service_tickets WHERE id = $1`,
            [id]
        );
        if (ticketCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Ticket not found." });
        }

        const ticket = ticketCheck.rows[0];

        if (ticket.status === "completed") {
            return res.status(400).json({ success: false, message: "Ticket is already completed." });
        }

        if (ticket.completion_otp !== String(otp).trim()) {
            return res.status(400).json({ success: false, message: "Invalid OTP code." });
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
            [JSON.stringify(updatedTimeline), id]
        );

        return res.status(200).json({
            success: true,
            message: "Service verified and marked as completed!",
            data: result.rows[0],
        });
    } catch (error) {
        console.error("Error verifying OTP:", error);
        return res.status(500).json({ success: false, message: "Failed to complete service." });
    }
};

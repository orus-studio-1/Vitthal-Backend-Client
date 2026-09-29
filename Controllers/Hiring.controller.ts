import type { Request, Response } from "express";
import pool from "../DbConnect";
import Razorpay from "razorpay";
import crypto from "crypto";
import { emitHireChatMessage } from "../socket";

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || "",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});

type AuthUser = { userId: string; role: string; email?: string };

function getAuthUser(req: Request): AuthUser | null {
    const user = (req as any).user;
    if (!user?.userId) return null;
    return user as AuthUser;
}

// ────────────────────────────────────────────────────────────────────
// PUBLIC: Browse verified & available candidates
// ────────────────────────────────────────────────────────────────────
export const browseCandidatesController = async (req: Request, res: Response): Promise<Response> => {
    const { city, skills, designation, experience_min, experience_max, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(String(limit || "20"), 10)));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [`ec.verification_status = 'verified'`, `ec.is_available = true`];
    const values: unknown[] = [];
    let idx = 1;

    if (city && typeof city === "string" && city.trim()) {
        conditions.push(`ec.city ILIKE $${idx}`);
        values.push(`%${city.trim()}%`);
        idx++;
    }

    if (designation && typeof designation === "string" && designation.trim()) {
        conditions.push(`ec.designation ILIKE $${idx}`);
        values.push(`%${designation.trim()}%`);
        idx++;
    }

    if (skills && typeof skills === "string" && skills.trim()) {
        // Skills filter: expects comma-separated list → check JSONB array contains
        const skillList = skills.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        if (skillList.length > 0) {
            conditions.push(`ec.skills @> $${idx}::jsonb`);
            values.push(JSON.stringify(skillList));
            idx++;
        }
    }

    if (experience_min) {
        const min = parseFloat(String(experience_min));
        if (!isNaN(min)) {
            conditions.push(`ec.experience_years >= $${idx}`);
            values.push(min);
            idx++;
        }
    }

    if (experience_max) {
        const max = parseFloat(String(experience_max));
        if (!isNaN(max)) {
            conditions.push(`ec.experience_years <= $${idx}`);
            values.push(max);
            idx++;
        }
    }

    if (search && typeof search === "string" && search.trim()) {
        conditions.push(`(ec.full_name ILIKE $${idx} OR ec.designation ILIKE $${idx})`);
        values.push(`%${search.trim()}%`);
        idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM employee_candidates ec ${whereClause}`,
            values
        );
        const total = countResult.rows[0]?.total || 0;

        const dataResult = await pool.query(
            `SELECT ec.id, ec.full_name, ec.city, ec.state,
                ec.designation, ec.experience_years, ec.skills, ec.metadata,
                    ec.photo_url, ec.is_available, ec.created_at
             FROM employee_candidates ec
             ${whereClause}
             ORDER BY ec.created_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
            [...values, limitNum, offset]
        );

        return res.status(200).json({
            success: true,
            data: dataResult.rows,
            pagination: { page: pageNum, limit: limitNum, total },
        });
    } catch (error) {
        console.error("Error browsing candidates:", error);
        return res.status(500).json({ success: false, message: "Failed to load candidates." });
    }
};

// ────────────────────────────────────────────────────────────────────
// PUBLIC: Get single candidate profile + documents
// ────────────────────────────────────────────────────────────────────
// export const getCandidateDetailController = async (req: Request, res: Response): Promise<Response> => {
//     const { id } = req.params;
//     if (!id) return res.status(400).json({ success: false, message: "Candidate ID is required." });

//     try {
//         const candidateResult = await pool.query(
//             `SELECT ec.id, ec.full_name, ec.city, ec.state,
//                     ec.designation, ec.experience_years, ec.skills, ec.metadata,
//                     ec.photo_url, ec.verification_status, ec.is_available, ec.created_at
//              FROM employee_candidates ec
//              WHERE ec.id = $1 AND ec.verification_status = 'verified' AND ec.is_available = true`,
//             [id]
//         );

//         if (candidateResult.rows.length === 0) {
//             return res.status(404).json({ success: false, message: "Candidate not found." });
//         }

//         return res.status(200).json({
//             success: true,
//             data: {
//                 ...candidateResult.rows[0],
//             },
//         });
//     } catch (error) {
//         console.error("Error fetching candidate detail:", error);
//         return res.status(500).json({ success: false, message: "Failed to load candidate." });
//     }
// };

export const getCandidateDetailController = async (
    req: Request,
    res: Response
): Promise<Response> => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({
            success: false,
            message:
                "Candidate ID is required.",
        });
    }

    const authUser = getAuthUser(req);

    if (
        !authUser ||
        authUser.role !== "client"
    ) {
        return res.status(401).json({
            success: false,
            message:
                "Sign in as a client to view worker details.",
        });
    }

    try {
        const access =
            await pool.query(
                `
                SELECT id
                FROM payments
                WHERE user_id = $1
                  AND payment_type = 'hiring_access'
                  AND status = 'successful'
                LIMIT 1
                `,
                [authUser.userId]
            );

        if (!access.rows[0]) {
            return res.status(403).json({
                success: false,
                code:
                    "HIRING_ACCESS_REQUIRED",
                message:
                    "Unlock Hiring Access to view worker details.",
            });
        }

        const candidateResult =
            await pool.query(
                `
                SELECT
                    ec.id,
                    ec.full_name,
                    ec.city,
                    ec.state,
                    ec.designation,
                    ec.experience_years,
                    ec.skills,
                    ec.metadata,
                    ec.photo_url,
                    ec.verification_status,
                    ec.is_available,
                    ec.created_at
                FROM employee_candidates ec
                WHERE ec.id = $1
                  AND ec.verification_status = 'verified'
                  AND ec.is_available = true
                `,
                [id]
            );

        if (
            candidateResult.rows.length ===
            0
        ) {
            return res.status(404).json({
                success: false,
                message:
                    "Candidate not found.",
            });
        }

        return res.status(200).json({
            success: true,
            data:
                candidateResult.rows[0],
        });
    } catch (error) {
        console.error(
            "Error fetching candidate detail:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Failed to load candidate.",
        });
    }
};

// ────────────────────────────────────────────────────────────────────
// AUTH: Self-register as a candidate (client portal)
// ────────────────────────────────────────────────────────────────────
export const selfRegisterCandidateController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "worker") {
        return res.status(403).json({ success: false, message: "Only worker accounts can submit worker profiles." });
    }

    const {
        full_name, email, phone, city, state, pincode, address_line,
        designation, experience_years, skills, metadata, photo_url,
        documents,
    } = req.body;

    if (!full_name || !phone) {
        return res.status(400).json({ success: false, message: "Full name and phone are required." });
    }

    try {
        const result = await pool.query(
            `INSERT INTO employee_candidates
                (full_name, email, phone, city, state, pincode, address_line,
                 designation, experience_years, skills, metadata, photo_url,
                 verification_status, registered_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13)
             RETURNING *`,
            [
                full_name.trim(),
                email?.trim() || null,
                phone.trim(),
                city?.trim() || null,
                state?.trim() || null,
                pincode?.trim() || null,
                address_line?.trim() || null,
                designation?.trim() || null,
                experience_years ?? 0,
                JSON.stringify(Array.isArray(skills) ? skills : []),
                JSON.stringify(metadata || {}),
                photo_url || null,
                authUser.userId,
            ]
        );

        const createdCandidate = result.rows[0];

        // Insert attached documents if provided
        if (documents && Array.isArray(documents) && documents.length > 0) {
            for (const doc of documents) {
                const docType = doc.doc_type || doc.document_type || "aadhaar_card";
                const docUrl = doc.doc_url || doc.document_url;
                const docName = doc.doc_name || doc.document_name || null;
                const docNumber = doc.doc_number || null;

                if (docUrl) {
                    await pool.query(
                        `INSERT INTO employee_documents 
                            (candidate_id, doc_type, doc_number, doc_url, doc_name, uploaded_by_user_id)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [createdCandidate.id, docType, docNumber, docUrl, docName, authUser.userId]
                    );
                }
            }
        }

        return res.status(201).json({
            success: true,
            message: "Your profile has been submitted for verification.",
            data: createdCandidate,
        });
    } catch (error) {
        console.error("Error self-registering candidate:", error);
        return res.status(500).json({ success: false, message: "Failed to register. Please try again." });
    }
};

// ────────────────────────────────────────────────────────────────────
// AUTH: Upload document for self-registered candidate
// ────────────────────────────────────────────────────────────────────
export const selfUploadDocumentController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "client") {
        return res.status(403).json({ success: false, message: "Worker documents can only be managed through the client portal." });
    }

    const { candidate_id, doc_type, doc_number, doc_url, doc_name } = req.body;

    if (!candidate_id || !doc_type || !doc_url) {
        return res.status(400).json({ success: false, message: "candidate_id, doc_type, and doc_url are required." });
    }

    try {
        // Verify the candidate was registered by this user
        const ownerCheck = await pool.query(
            `SELECT id FROM employee_candidates WHERE id = $1 AND registered_by_user_id = $2`,
            [candidate_id, authUser.userId]
        );
        if (ownerCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: "You can only upload documents for your own profile." });
        }

        const result = await pool.query(
            `INSERT INTO employee_documents (candidate_id, doc_type, doc_number, doc_url, doc_name, uploaded_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [candidate_id, doc_type, doc_number || null, doc_url, doc_name || null, authUser.userId]
        );

        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error uploading candidate document:", error);
        return res.status(500).json({ success: false, message: "Failed to upload document." });
    }
};

// ────────────────────────────────────────────────────────────────────
// AUTH: Submit a hire request
// ────────────────────────────────────────────────────────────────────
export const createHireRequestController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "client") {
        return res.status(403).json({ success: false, message: "Only client accounts can submit worker hiring requests." });
    }

    const { candidate_id, request_details } = req.body;

    if (!candidate_id) {
        return res.status(400).json({ success: false, message: "candidate_id is required." });
    }

    try {
        // Verify candidate exists and is verified + available
        const candidateCheck = await pool.query(
            `SELECT id, full_name FROM employee_candidates
             WHERE id = $1 AND verification_status = 'verified' AND is_available = true`,
            [candidate_id]
        );
        if (candidateCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Candidate not found or not available." });
        }

        // Check for existing pending request by same user for same candidate
        const existingCheck = await pool.query(
            `SELECT id FROM hire_requests
             WHERE candidate_id = $1 AND requested_by_user_id = $2 AND status = 'pending'`,
            [candidate_id, authUser.userId]
        );
        if (existingCheck.rows.length > 0) {
            return res.status(409).json({ success: false, message: "You already have a pending hire request for this candidate." });
        }

        const result = await pool.query(
            `INSERT INTO hire_requests (candidate_id, requested_by_user_id, request_details)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [candidate_id, authUser.userId, JSON.stringify(request_details || {})]
        );

        return res.status(201).json({
            success: true,
            message: "Hire request submitted. Admin will review shortly.",
            data: result.rows[0],
        });
    } catch (error) {
        console.error("Error creating hire request:", error);
        return res.status(500).json({ success: false, message: "Failed to submit hire request." });
    }
};

// ────────────────────────────────────────────────────────────────────
// AUTH: Get my hire requests
// ────────────────────────────────────────────────────────────────────
export const getMyHireRequestsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "client") {
        return res.status(403).json({ success: false, message: "Only client accounts can view their hiring requests." });
    }

    try {
        const result = await pool.query(
                    `SELECT hr.id, hr.status, hr.request_details, hr.admin_notes,
                        hr.proposed_amount, hr.agreed_amount, hr.negotiation_status,
                        hr.contract_status, hr.client_completed_at, hr.worker_completed_at, hr.completed_at,
                    hr.created_at, hr.reviewed_at,
                    ec.id AS candidate_id, ec.full_name AS candidate_name,
                    ec.designation AS candidate_designation, ec.photo_url AS candidate_photo,
                    ec.city AS candidate_city
             FROM hire_requests hr
             JOIN employee_candidates ec ON ec.id = hr.candidate_id
             WHERE hr.requested_by_user_id = $1
             ORDER BY hr.created_at DESC`,
            [authUser.userId]
        );

        return res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching hire requests:", error);
        return res.status(500).json({ success: false, message: "Failed to load hire requests." });
    }
};

// AUTH: Get incoming hire requests for a worker
export const getWorkerHireRequestsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "worker") {
        return res.status(403).json({ success: false, message: "Only worker accounts can view incoming hire requests." });
    }

    try {
        const result = await pool.query(
                `SELECT hr.id, hr.status, hr.request_details, hr.admin_notes,
                    hr.contract_status, hr.client_completed_at, hr.worker_completed_at, hr.completed_at,
                    hr.created_at, hr.reviewed_at,
                    ec.id AS candidate_id, ec.full_name AS candidate_name,
                    ec.designation AS candidate_designation,
                    u.name AS hirer_name, u.email AS hirer_email
             FROM hire_requests hr
             JOIN employee_candidates ec ON ec.id = hr.candidate_id
             JOIN users u ON u.id = hr.requested_by_user_id
             WHERE ec.registered_by_user_id = $1
             ORDER BY hr.created_at DESC`,
            [authUser.userId]
        );

        return res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching worker hire requests:", error);
        return res.status(500).json({ success: false, message: "Failed to load incoming hire requests." });
    }
};

// AUTH: Accept or reject an incoming hire request
export const updateWorkerHireRequestController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "worker") {
        return res.status(403).json({ success: false, message: "Only worker accounts can update hire requests." });
    }

    const { id } = req.params;
    const status = req.body?.status;
    if (!id || !["accepted", "rejected"].includes(status)) {
        return res.status(400).json({ success: false, message: "A valid request ID and accepted/rejected status are required." });
    }

    try {
        if (status === "accepted") {
            const availability = await pool.query(
                `SELECT ec.is_available,
                        EXISTS (
                            SELECT 1 FROM hire_requests active_hr
                            WHERE active_hr.candidate_id = ec.id
                              AND active_hr.contract_status = 'active'
                        ) AS has_active_contract
                 FROM hire_requests hr
                 JOIN employee_candidates ec ON ec.id = hr.candidate_id
                 WHERE hr.id = $1 AND ec.registered_by_user_id = $2 AND hr.status = 'pending'`,
                [id, authUser.userId]
            );
            if (availability.rows.length === 0) {
                return res.status(404).json({ success: false, message: "Pending hire request not found." });
            }
            if (!availability.rows[0].is_available || availability.rows[0].has_active_contract) {
                return res.status(409).json({ success: false, message: "You already have an active paid contract. Complete it before accepting another request." });
            }
        }

        const result = await pool.query(
            `UPDATE hire_requests hr
             SET status = $1, reviewed_at = NOW()
             FROM employee_candidates ec
             WHERE hr.id = $2
               AND hr.candidate_id = ec.id
               AND ec.registered_by_user_id = $3
               AND hr.status = 'pending'
             RETURNING hr.id, hr.status, hr.reviewed_at`,
            [status, id, authUser.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Pending hire request not found." });
        }

        return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error updating worker hire request:", error);
        return res.status(500).json({ success: false, message: "Failed to update hire request." });
    }
};

async function getAuthorizedConversationRequest(requestId: string, authUser: AuthUser) {
    const result = await pool.query(
        `SELECT hr.id, hr.status, hr.request_details, hr.proposed_amount,
            hr.agreed_amount, hr.negotiation_status, hr.negotiation_proposed_by,
            hr.contract_status, hr.client_completed_at, hr.worker_completed_at, hr.completed_at,
                ec.full_name AS candidate_name,
                requester.name AS client_name, requester.email AS client_email
         FROM hire_requests hr
         JOIN employee_candidates ec ON ec.id = hr.candidate_id
         JOIN users requester ON requester.id = hr.requested_by_user_id
         WHERE hr.id = $1
           AND (
             ($2 = 'client' AND hr.requested_by_user_id = $3)
             OR ($2 = 'worker' AND ec.registered_by_user_id = $3)
           )`,
        [requestId, authUser.role, authUser.userId]
    );
    return result.rows[0] || null;
}

// AUTH: Get the client-worker conversation after a request is accepted
export const getHireConversationController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || !["client", "worker"].includes(authUser.role)) {
        return res.status(403).json({ success: false, message: "Only the client and worker can access this conversation." });
    }

    try {
        const requestId = String(req.params.id);
        const request = await getAuthorizedConversationRequest(requestId, authUser);
        if (!request) return res.status(404).json({ success: false, message: "Hiring request not found." });
        if (request.status !== "accepted") {
            return res.status(409).json({ success: false, message: "Conversation opens after the worker accepts the request." });
        }

        const messages = await pool.query(
            `SELECT id, sender_user_id, sender_role, message_type, body,
                    proposed_amount, created_at
             FROM hire_request_messages
             WHERE hire_request_id = $1
             ORDER BY created_at ASC`,
            [requestId]
        );

        return res.status(200).json({ success: true, data: { request, messages: messages.rows } });
    } catch (error) {
        console.error("Error fetching hire conversation:", error);
        return res.status(500).json({ success: false, message: "Failed to load conversation." });
    }
};

// AUTH: Send a message in the accepted client-worker conversation
export const sendHireMessageController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || !["client", "worker"].includes(authUser.role)) {
        return res.status(403).json({ success: false, message: "Only the client and worker can send messages." });
    }

    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ success: false, message: "Message body is required." });

    try {
        const requestId = String(req.params.id);
        const request = await getAuthorizedConversationRequest(requestId, authUser);
        if (!request) return res.status(404).json({ success: false, message: "Hiring request not found." });
        if (request.status !== "accepted") return res.status(409).json({ success: false, message: "Accept the request before chatting." });

        const result = await pool.query(
            `INSERT INTO hire_request_messages (hire_request_id, sender_user_id, sender_role, body)
             VALUES ($1, $2, $3, $4)
             RETURNING id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at`,
            [requestId, authUser.userId, authUser.role, body]
        );

        emitHireChatMessage(requestId, result.rows[0]);

        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error sending hire message:", error);
        return res.status(500).json({ success: false, message: "Failed to send message." });
    }
};

// AUTH: Propose a negotiated amount in the accepted conversation
export const proposeHireAmountController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || !["client", "worker"].includes(authUser.role)) {
        return res.status(403).json({ success: false, message: "Only the client and worker can negotiate." });
    }

    const amount = Number(req.body?.amount);
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: "A positive negotiation amount is required." });
    }

    try {
        const requestId = String(req.params.id);
        const request = await getAuthorizedConversationRequest(requestId, authUser);
        if (!request) return res.status(404).json({ success: false, message: "Hiring request not found." });
        if (request.status !== "accepted") return res.status(409).json({ success: false, message: "Accept the request before negotiating." });

        const result = await pool.query(
            `WITH updated_request AS (
                UPDATE hire_requests
                SET proposed_amount = $1, negotiation_status = 'proposed', negotiation_proposed_by = $3, updated_at = NOW()
                WHERE id = $2
                RETURNING id
             )
             INSERT INTO hire_request_messages
                (hire_request_id, sender_user_id, sender_role, message_type, body, proposed_amount)
             SELECT id, $3, $4, 'offer', $5, $1 FROM updated_request
             RETURNING id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at`,
            [amount, requestId, authUser.userId, authUser.role, note || `Proposed amount: ${amount}`]
        );

        emitHireChatMessage(requestId, result.rows[0]);

        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error proposing hire amount:", error);
        return res.status(500).json({ success: false, message: "Failed to submit negotiation." });
    }
};

// AUTH: Accept the other party's latest negotiation offer
export const acceptHireOfferController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || !["client", "worker"].includes(authUser.role)) {
        return res.status(403).json({ success: false, message: "Only the client and worker can accept offers." });
    }

    try {
        const requestId = String(req.params.id);
        const request = await getAuthorizedConversationRequest(requestId, authUser);
        if (!request) return res.status(404).json({ success: false, message: "Hiring request not found." });
        if (request.status !== "accepted") return res.status(409).json({ success: false, message: "Accept the hiring request before negotiating." });
        if (request.negotiation_status !== "proposed" || !request.proposed_amount) return res.status(409).json({ success: false, message: "There is no open offer to accept." });
        if (request.negotiation_proposed_by === authUser.userId) return res.status(403).json({ success: false, message: "You cannot accept your own offer." });

        const result = await pool.query(
            `WITH updated_request AS (
                UPDATE hire_requests
                SET agreed_amount = proposed_amount, negotiation_status = 'agreed', updated_at = NOW()
                WHERE id = $1
                RETURNING id, agreed_amount
             )
             INSERT INTO hire_request_messages (hire_request_id, sender_user_id, sender_role, message_type, body, proposed_amount)
             SELECT id, $2, $3, 'accept', 'Offer accepted. The client can now complete payment.', agreed_amount
             FROM updated_request
             RETURNING id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at`,
            [requestId, authUser.userId, authUser.role]
        );

           emitHireChatMessage(requestId, result.rows[0]);

        return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error accepting hire offer:", error);
        return res.status(500).json({ success: false, message: "Failed to accept offer." });
    }
};

// AUTH: Create a Razorpay order for an accepted hiring request
export const createHirePaymentOrderController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ success: false, message: "Only clients can pay for hiring requests." });
    }

    try {
        const requestId = String(req.params.id);
        const request = await getAuthorizedConversationRequest(requestId, authUser);
        const amount = Number(request?.agreed_amount || request?.proposed_amount || 0);
        if (!request || request.status !== "accepted") return res.status(404).json({ success: false, message: "Accepted hiring request not found." });
        if (!["agreed", "paid"].includes(request.negotiation_status || "")) return res.status(409).json({ success: false, message: "The offer must be accepted by both parties before payment." });
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: "Agree on a valid amount before payment." });
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return res.status(500).json({ success: false, message: "Razorpay is not configured." });

        const order = await razorpay.orders.create({ amount: Math.round(amount * 100), currency: "INR", receipt: `hire_${requestId.slice(0, 8)}_${Date.now()}`, notes: { hireRequestId: requestId, clientId: authUser.userId } });
        await pool.query(
            `INSERT INTO payments (user_id, amount, status, payment_method, razorpay_order_id, hire_request_id, payment_type)
             VALUES ($1, $2, 'pending', 'razorpay', $3, $4, 'worker_hiring')`,
            [authUser.userId, amount, order.id, requestId]
        );

        return res.status(200).json({ success: true, keyId: process.env.RAZORPAY_KEY_ID, amount: order.amount, currency: order.currency, razorpayOrderId: order.id });
    } catch (error) {
        console.error("Error creating hire payment order:", error);
        return res.status(500).json({ success: false, message: "Failed to create payment order." });
    }
};

// AUTH: Verify hiring payment and mark the negotiated request paid
export const verifyHirePaymentController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") return res.status(403).json({ success: false, message: "Only clients can verify hiring payments." });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ success: false, message: "Payment verification details are required." });

    try {
        const payment = await pool.query(`SELECT hire_request_id FROM payments WHERE razorpay_order_id = $1 AND user_id = $2 AND payment_type = 'worker_hiring'`, [razorpay_order_id, authUser.userId]);
        if (payment.rows.length === 0) return res.status(404).json({ success: false, message: "Hiring payment not found." });
        const signature = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "").update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
        if (signature !== razorpay_signature) return res.status(400).json({ success: false, message: "Invalid payment signature." });

        await pool.query("BEGIN");
        await pool.query(`UPDATE payments SET status = 'successful', razorpay_payment_id = $2, razorpay_signature = $3, updated_at = NOW() WHERE razorpay_order_id = $1`, [razorpay_order_id, razorpay_payment_id, razorpay_signature]);
        await pool.query(`UPDATE hire_requests SET negotiation_status = 'paid', contract_status = 'active', agreed_amount = COALESCE(agreed_amount, proposed_amount), updated_at = NOW() WHERE id = $1`, [payment.rows[0].hire_request_id]);
        await pool.query(
            `UPDATE employee_candidates
             SET is_available = false, updated_at = NOW()
             WHERE id = (SELECT candidate_id FROM hire_requests WHERE id = $1)`,
            [payment.rows[0].hire_request_id]
        );
        await pool.query("COMMIT");
        return res.status(200).json({ success: true, message: "Hiring payment verified." });
    } catch (error) {
        await pool.query("ROLLBACK");
        console.error("Error verifying hire payment:", error);
        return res.status(500).json({ success: false, message: "Failed to verify hiring payment." });
    }
};

// AUTH: Require both parties to confirm contract completion before reopening availability.
export const confirmHireContractCompletionController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || !["client", "worker"].includes(authUser.role)) {
        return res.status(403).json({ success: false, message: "Only the client and worker can confirm completion." });
    }

    const requestId = String(req.params.id);
    const db = await pool.connect();
    try {
        await db.query("BEGIN");
        const requestResult = await db.query(
            `SELECT hr.id, hr.candidate_id, hr.contract_status, hr.client_completed_at,
                    hr.worker_completed_at, hr.completed_at
             FROM hire_requests hr
             JOIN employee_candidates ec ON ec.id = hr.candidate_id
             WHERE hr.id = $1 AND hr.status = 'accepted' AND (
               ($2 = 'client' AND hr.requested_by_user_id = $3)
               OR ($2 = 'worker' AND ec.registered_by_user_id = $3)
             )
             FOR UPDATE OF hr`,
            [requestId, authUser.role, authUser.userId]
        );

        if (requestResult.rows.length === 0) {
            await db.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "Accepted hiring contract not found." });
        }

        const contract = requestResult.rows[0];
        if (contract.contract_status !== "active" && contract.contract_status !== "completed") {
            await db.query("ROLLBACK");
            return res.status(409).json({ success: false, message: "Only paid, active contracts can be completed." });
        }

        const completionColumn = authUser.role === "client" ? "client_completed_at" : "worker_completed_at";
        const wasAlreadyConfirmed = Boolean(contract[completionColumn]);
        const confirmation = await db.query(
            `UPDATE hire_requests SET ${completionColumn} = COALESCE(${completionColumn}, NOW()), updated_at = NOW()
             WHERE id = $1 RETURNING client_completed_at, worker_completed_at`,
            [requestId]
        );
        const clientCompletedAt = confirmation.rows[0].client_completed_at;
        const workerCompletedAt = confirmation.rows[0].worker_completed_at;
        const bothConfirmed = Boolean(clientCompletedAt && workerCompletedAt);

        const liveMessages = [];
        if (!wasAlreadyConfirmed) {
            const confirmationMessage = await db.query(
                `INSERT INTO hire_request_messages (hire_request_id, sender_user_id, sender_role, message_type, body)
                 VALUES ($1, $2, $3, 'completion_confirmation', $4)
                 RETURNING id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at`,
                [requestId, authUser.userId, authUser.role, `${authUser.role === "client" ? "Client" : "Worker"} confirmed contract completion.`]
            );
            liveMessages.push(confirmationMessage.rows[0]);
        }

        if (bothConfirmed && contract.contract_status !== "completed") {
            await db.query(`UPDATE hire_requests SET contract_status = 'completed', completed_at = NOW() WHERE id = $1`, [requestId]);
            const messageResult = await db.query(
                `INSERT INTO hire_request_messages (hire_request_id, sender_user_id, sender_role, message_type, body)
                 VALUES ($1, $2, $3, 'contract_completion', 'Both parties confirmed contract completion.')
                 RETURNING id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at`,
                [requestId, authUser.userId, authUser.role]
            );
            liveMessages.push(messageResult.rows[0]);
            await db.query(
                `UPDATE employee_candidates ec SET is_available = NOT EXISTS (
                    SELECT 1 FROM hire_requests active_hr
                    WHERE active_hr.candidate_id = ec.id
                      AND active_hr.contract_status = 'active'
                ), updated_at = NOW()
                 WHERE ec.id = $1`,
                [contract.candidate_id]
            );
        }

        const finalResult = await db.query(
            `SELECT contract_status, client_completed_at, worker_completed_at, completed_at
             FROM hire_requests WHERE id = $1`,
            [requestId]
        );
        await db.query("COMMIT");

        for (const message of liveMessages) emitHireChatMessage(requestId, { ...message, ...finalResult.rows[0] });
        return res.status(200).json({ success: true, data: finalResult.rows[0], bothConfirmed });
    } catch (error) {
        await db.query("ROLLBACK");
        console.error("Error confirming hiring contract completion:", error);
        return res.status(500).json({ success: false, message: "Failed to confirm contract completion." });
    } finally {
        db.release();
    }
};

export const getWorkerPaymentHistoryController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "worker") return res.status(403).json({ success: false, message: "Only workers can view worker payment history." });
    try {
        const result = await pool.query(
            `SELECT p.id, p.amount, p.currency, p.status, p.payment_method, p.razorpay_payment_id, p.created_at,
                    hr.id AS hire_request_id, u.name AS client_name
             FROM payments p JOIN hire_requests hr ON hr.id = p.hire_request_id
             JOIN employee_candidates ec ON ec.id = hr.candidate_id
             JOIN users u ON u.id = hr.requested_by_user_id
             WHERE ec.registered_by_user_id = $1 AND p.payment_type = 'worker_hiring'
             ORDER BY p.created_at DESC`, [authUser.userId]
        );
        return res.status(200).json({ success: true, data: result.rows });
    } catch (error) {
        console.error("Error fetching worker payment history:", error);
        return res.status(500).json({ success: false, message: "Failed to load payment history." });
    }
};

// ────────────────────────────────────────────────────────────────────
// AUTH: Get my candidate profile (self-registered)
// ────────────────────────────────────────────────────────────────────
export const getMyCandidateProfileController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "worker") {
        return res.status(403).json({ success: false, message: "Only worker accounts can access worker profiles." });
    }

    try {
        const result = await pool.query(
            `SELECT ec.*, 
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'id', ed.id, 'doc_type', ed.doc_type,
                                'doc_number', ed.doc_number, 'doc_url', ed.doc_url,
                                'doc_name', ed.doc_name, 'created_at', ed.created_at
                            )
                        ) FILTER (WHERE ed.id IS NOT NULL), '[]'
                    ) AS documents
             FROM employee_candidates ec
             LEFT JOIN employee_documents ed ON ed.candidate_id = ec.id
             WHERE ec.registered_by_user_id = $1
             GROUP BY ec.id
             ORDER BY ec.created_at DESC
             LIMIT 1`,
            [authUser.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "No candidate profile found." });
        }

        return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error fetching candidate profile:", error);
        return res.status(500).json({ success: false, message: "Failed to load profile." });
    }
};

// AUTH: Update the worker's own candidate profile
export const updateMyCandidateProfileController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });
    if (authUser.role !== "worker") {
        return res.status(403).json({ success: false, message: "Only worker accounts can update worker profiles." });
    }

    const {
        full_name, email, phone, city, state, pincode, address_line,
        designation, experience_years, skills, metadata, photo_url,
    } = req.body;

    if (!full_name || !phone || !designation) {
        return res.status(400).json({ success: false, message: "Full name, phone, and designation are required." });
    }

    try {
        const result = await pool.query(
            `UPDATE employee_candidates
             SET full_name = $1, email = $2, phone = $3, city = $4, state = $5,
                 pincode = $6, address_line = $7, designation = $8,
                 experience_years = $9, skills = $10::jsonb,
                 metadata = $11::jsonb, photo_url = $12, updated_at = NOW()
             WHERE registered_by_user_id = $13
             RETURNING id, full_name, email, phone, city, state, pincode,
                       address_line, designation, experience_years, skills,
                       metadata, photo_url, verification_status, is_available,
                       created_at, updated_at`,
            [
                full_name.trim(), email?.trim() || null, phone.trim(), city?.trim() || null,
                state?.trim() || null, pincode?.trim() || null, address_line?.trim() || null,
                designation.trim(), experience_years ?? 0,
                JSON.stringify(Array.isArray(skills) ? skills : []),
                JSON.stringify(metadata || {}), photo_url || null, authUser.userId,
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Worker profile not found." });
        }

        return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error("Error updating worker profile:", error);
        return res.status(500).json({ success: false, message: "Failed to update worker profile." });
    }
};

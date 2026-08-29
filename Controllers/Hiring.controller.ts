import type { Request, Response } from "express";
import pool from "../DbConnect";

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
            `SELECT ec.id, ec.full_name, ec.email, ec.phone, ec.city, ec.state, ec.pincode,
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
export const getCandidateDetailController = async (req: Request, res: Response): Promise<Response> => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: "Candidate ID is required." });

    try {
        const candidateResult = await pool.query(
            `SELECT ec.id, ec.full_name, ec.email, ec.phone, ec.city, ec.state, ec.pincode,
                    ec.address_line, ec.designation, ec.experience_years, ec.skills, ec.metadata,
                    ec.photo_url, ec.verification_status, ec.is_available, ec.created_at
             FROM employee_candidates ec
             WHERE ec.id = $1 AND ec.verification_status = 'verified'`,
            [id]
        );

        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Candidate not found." });
        }

        const docsResult = await pool.query(
            `SELECT id, doc_type, doc_name, doc_url, created_at
             FROM employee_documents
             WHERE candidate_id = $1
             ORDER BY created_at ASC`,
            [id]
        );

        return res.status(200).json({
            success: true,
            data: {
                ...candidateResult.rows[0],
                documents: docsResult.rows,
            },
        });
    } catch (error) {
        console.error("Error fetching candidate detail:", error);
        return res.status(500).json({ success: false, message: "Failed to load candidate." });
    }
};

// ────────────────────────────────────────────────────────────────────
// AUTH: Self-register as a candidate (client portal)
// ────────────────────────────────────────────────────────────────────
export const selfRegisterCandidateController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

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

    try {
        const result = await pool.query(
            `SELECT hr.id, hr.status, hr.request_details, hr.admin_notes,
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

// ────────────────────────────────────────────────────────────────────
// AUTH: Get my candidate profile (self-registered)
// ────────────────────────────────────────────────────────────────────
export const getMyCandidateProfileController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ success: false, message: "Authentication required." });

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

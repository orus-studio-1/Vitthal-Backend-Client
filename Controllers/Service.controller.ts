import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import crypto from "crypto";
import pool from "../DbConnect";
import { sendEmail } from "../helpers/mailer.helper";
import { uploadBufferToS3, getPresignedUrlOrOriginal, getPresignedUrl } from "../services/s3.service";
import { createNotification } from "./Notification.controller";
import { generateBaseServiceQuotationDocument, generateVendorServiceQuotationDocument } from "../services/serviceQuotationDocument.service";

type AuthUser = { userId: string; role: string; email?: string };

function getAuthUser(req: Request): AuthUser | null {
    const user = (req as any).user;
    if (!user?.userId) return null;
    return user as AuthUser;
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseRating(value: unknown): number | null {
    const r = Number(value);
    if (!Number.isInteger(r) || r < 1 || r > 5) return null;
    return r;
}

function parsePositiveInt(value: unknown): number | null {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
}

function parsePositiveDecimal(value: unknown): string | null {
    const n = parseFloat(String(value));
    if (isNaN(n) || n < 0) return null;
    return n.toFixed(2);
}

async function getVendorIdByUserId(userId: string): Promise<string | null> {
    const result = await pool.query(
        `SELECT id FROM vendors WHERE user_id = $1 AND approval_status = 'approved' LIMIT 1`,
        [userId]
    );
    return result.rows[0]?.id ?? null;
}

async function updateServiceAggregate(client: PoolClient, serviceId: string, rating: number) {
    return client.query(
        `UPDATE services
         SET rating = ROUND((((COALESCE(rating, 0.0) * COALESCE(review_count, 0)) + $1)::numeric / (COALESCE(review_count, 0) + 1)), 1),
             review_count = COALESCE(review_count, 0) + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [rating, serviceId]
    );
}

async function updateVendorAggregate(client: PoolClient, vendorId: string, rating: number) {
    return client.query(
        `UPDATE vendors
         SET rating = ROUND((((COALESCE(rating, 0.0) * COALESCE(review_count, 0)) + $1)::numeric / (COALESCE(review_count, 0) + 1)), 1),
             review_count = COALESCE(review_count, 0) + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [rating, vendorId]
    );
}

export const browseServicesController = async (req: Request, res: Response): Promise<Response> => {
    const { category, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(String(page || "1"), 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(String(limit || "20"), 10)));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [`s.status = 'approved'`];
    const values: unknown[] = [];
    let idx = 1;

    if (category && typeof category === "string") {
        conditions.push(`s.category_id = $${idx++}`);
        values.push(category);
    }

    if (search && typeof search === "string" && search.trim().length > 0) {
        conditions.push(`(s.name ILIKE $${idx} OR s.description ILIKE $${idx})`);
        values.push(`%${search.trim()}%`);
        idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
        const [dataResult, countResult] = await Promise.all([
            pool.query(
                `SELECT
                    s.id, s.name, s.description, s.rating, s.review_count, s.category_id,
                    pc.label AS category_label,
                    COUNT(DISTINCT vs.id) AS vendor_count,
                    MIN(vs.price) AS starting_price,
                    COALESCE(
                        (SELECT sm.media_url FROM services_media sm WHERE sm.service_id = s.id AND sm.is_primary = true LIMIT 1),
                        (SELECT sm.media_url FROM services_media sm WHERE sm.service_id = s.id LIMIT 1),
                        pc.image
                    ) AS image_url
                 FROM services s
                 LEFT JOIN product_category pc ON pc.id = s.category_id
                 LEFT JOIN vendor_services vs ON vs.service_id = s.id AND vs.is_active = true AND EXISTS (
                     SELECT 1 FROM vendors v
                     JOIN users u ON u.id = v.user_id
                     WHERE v.id = vs.vendor_id
                       AND v.approval_status = 'approved'
                       AND v.is_active = true
                       AND v.is_blocked = false
                       AND v.vendor_type IN ('service', 'both')
                       AND u.is_active = true
                 )
                 ${where}
                 GROUP BY s.id, pc.label, pc.image
                 ORDER BY s.rating DESC NULLS LAST, s.review_count DESC
                 LIMIT $${idx} OFFSET $${idx + 1}`,
                [...values, limitNum, offset]
            ),
            pool.query(
                `SELECT COUNT(*) FROM services s ${where}`,
                values
            ),
        ]);

        const rows = await Promise.all(
            dataResult.rows.map(async (row) => ({
                ...row,
                image_url: await getPresignedUrlOrOriginal(row.image_url),
            }))
        );

        return res.status(200).json({
            data: rows,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: parseInt(countResult.rows[0].count, 10),
            },
        });
    } catch (error) {
        console.error("Error browsing services:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

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

export const getServiceDetailController = async (req: Request, res: Response): Promise<Response> => {
    const { id } = req.params;
    const { userLat, userLng } = req.query;
    const parsedLat = userLat ? Number(userLat) : null;
    const parsedLng = userLng ? Number(userLng) : null;

    try {
        const serviceResult = await pool.query(
            `SELECT
                s.id, s.name, s.description, s.rating, s.review_count, s.status, s.category_id,
                s.specifications,
                pc.label AS category_label,
                pc.code AS category_code,
                pc.image AS category_image
             FROM services s
             LEFT JOIN product_category pc ON pc.id = s.category_id
             WHERE s.id = $1 AND s.status = 'approved'
             LIMIT 1`,
            [id]
        );

        if (serviceResult.rows.length === 0) {
            return res.status(404).json({ message: "Service not found" });
        }

        const [mediaResult, vendorOfferingsResult, reviewsResult] = await Promise.all([
            pool.query(
                `SELECT id, media_url, media_type, is_primary, display_order
                 FROM services_media
                 WHERE service_id = $1 AND approval_status = 'approved'
                 ORDER BY is_primary DESC, display_order ASC`,
                [id]
            ),
            pool.query(
                `SELECT
                    vs.id AS vendor_service_id, vs.pricing_type, vs.price, vs.moq, vs.is_active,
                    v.id AS vendor_id, v.company_name, v.rating AS vendor_rating, v.review_count AS vendor_review_count,
                    va.latitude, va.longitude, va.city, va.state
                  FROM vendor_services vs
                  JOIN vendors v ON v.id = vs.vendor_id 
                      AND v.approval_status = 'approved'
                      AND v.is_active = true
                      AND v.is_blocked = false
                      AND v.vendor_type IN ('service', 'both')
                  JOIN users u ON u.id = v.user_id AND u.is_active = true
                  LEFT JOIN addresses va ON v.user_id = va.user_id
                  WHERE vs.service_id = $1 AND vs.is_active = true`,
                [id]
            ),
            pool.query(
                `SELECT
                    sr.id, sr.rating, sr.review_title, sr.review_text, sr.images, sr.created_at,
                    u.name AS reviewer_name
                 FROM service_reviews sr
                 JOIN users u ON u.id = sr.user_id
                 WHERE sr.service_id = $1
                 ORDER BY sr.created_at DESC`,
                [id]
            ),
        ]);

        const mediaWithUrls = await Promise.all(
            mediaResult.rows.map(async (m) => ({
                ...m,
                media_url: await getPresignedUrlOrOriginal(m.media_url),
            }))
        );

        let vendorOfferings = vendorOfferingsResult.rows.map((row) => {
            const price = Number(row.price) || 0;
            const rating = Number(row.vendor_rating) || 0;
            const reviewCount = Number(row.vendor_review_count) || 0;
            const vendorLat = row.latitude !== null ? Number(row.latitude) : null;
            const vendorLng = row.longitude !== null ? Number(row.longitude) : null;

            let distance: number | null = null;
            if (parsedLat !== null && parsedLng !== null && !isNaN(parsedLat) && !isNaN(parsedLng) && vendorLat !== null && vendorLng !== null) {
                distance = haversineDistance(parsedLat, parsedLng, vendorLat, vendorLng);
            }

            return {
                ...row,
                price,
                vendor_rating: rating,
                vendor_review_count: reviewCount,
                latitude: vendorLat,
                longitude: vendorLng,
                distance,
            };
        });

        if (parsedLat !== null && parsedLng !== null && !isNaN(parsedLat) && !isNaN(parsedLng) && vendorOfferings.length > 0) {
            const prices = vendorOfferings.map((v) => v.price).filter((p) => p > 0);
            const distances = vendorOfferings.map((v) => v.distance).filter((d): d is number => d !== null);
            const ratings = vendorOfferings.map((v) => v.vendor_rating);

            const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
            const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
            const minDist = distances.length > 0 ? Math.min(...distances) : 0;
            const maxDist = distances.length > 0 ? Math.max(...distances) : 0;
            const maxRating = ratings.length > 0 ? Math.max(...ratings) : 5;

            const PRICE_WEIGHT = 0.4;
            const DISTANCE_WEIGHT = 0.4;
            const REVIEW_WEIGHT = 0.2;

            vendorOfferings = vendorOfferings.map((v) => {
                const priceScore = maxPrice > minPrice ? (maxPrice - v.price) / (maxPrice - minPrice) : 1;
                const distanceScore = v.distance !== null && maxDist > minDist
                    ? (maxDist - v.distance) / (maxDist - minDist)
                    : v.distance !== null ? 1 : 0.5;
                const reviewScore = maxRating > 0 ? v.vendor_rating / maxRating : 0;

                const totalScore = (PRICE_WEIGHT * priceScore) + (DISTANCE_WEIGHT * distanceScore) + (REVIEW_WEIGHT * reviewScore);

                return {
                    ...v,
                    price_score: Math.round(priceScore * 100) / 100,
                    distance_score: Math.round(distanceScore * 100) / 100,
                    review_score: Math.round(reviewScore * 100) / 100,
                    total_score: Math.round(totalScore * 100) / 100,
                };
            });

            vendorOfferings.sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
        } else {
            // Default sort by price ASC
            vendorOfferings.sort((a, b) => a.price - b.price);
        }

        return res.status(200).json({
            data: {
                ...serviceResult.rows[0],
                media: mediaWithUrls,
                vendor_offerings: vendorOfferings,
                reviews: reviewsResult.rows,
            },
        });
    } catch (error) {
        console.error("Error fetching service detail:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const createServiceBookingController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can create service bookings" });
    }

    const {
        vendorServiceId,
        scheduledStart,
        scheduledEnd,
        bookingNotes,
    } = req.body as Record<string, unknown>;

    if (!vendorServiceId || typeof vendorServiceId !== "string") {
        return res.status(400).json({ message: "vendorServiceId is required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const vsResult = await client.query(
            `SELECT vs.id, vs.service_id, vs.vendor_id, vs.price, vs.pricing_type, vs.moq, vs.is_active,
                    v.approval_status
             FROM vendor_services vs
             JOIN vendors v ON v.id = vs.vendor_id
             WHERE vs.id = $1 LIMIT 1`,
            [vendorServiceId]
        );

        if (vsResult.rows.length === 0 || !vsResult.rows[0].is_active) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Vendor service offering not found or inactive" });
        }

        const vs = vsResult.rows[0];

        if (vs.approval_status !== "approved") {
            await client.query("ROLLBACK");
            return res.status(403).json({ message: "This vendor is not approved to offer services" });
        }

        const bookingResult = await client.query(
            `INSERT INTO service_bookings (user_id, vendor_id, vendor_service_id, total_amount, scheduled_start, scheduled_end, booking_notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, status, payment_status, total_amount, scheduled_start, scheduled_end, created_at`,
            [
                authUser.userId,
                vs.vendor_id,
                vendorServiceId,
                vs.price,
                scheduledStart || null,
                scheduledEnd || null,
                normalizeText(bookingNotes),
            ]
        );

        await client.query("COMMIT");

        return res.status(201).json({
            message: "Service booking created successfully",
            data: bookingResult.rows[0],
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error creating service booking:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const getMyBookingsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ message: "Forbidden" });
    }

    try {
        const result = await pool.query(
            `SELECT
                sb.id, sb.status, sb.payment_status, sb.total_amount,
                sb.scheduled_start, sb.scheduled_end, sb.booking_notes, sb.created_at,
                s.name AS service_name, s.description AS service_description,
                v.company_name AS vendor_name,
                vs.pricing_type,
                EXISTS(SELECT 1 FROM service_reviews sr WHERE sr.booking_id = sb.id) AS has_review
             FROM service_bookings sb
             JOIN vendor_services vs ON vs.id = sb.vendor_service_id
             JOIN services s ON s.id = vs.service_id
             JOIN vendors v ON v.id = sb.vendor_id
             WHERE sb.user_id = $1
             ORDER BY sb.created_at DESC`,
            [authUser.userId]
        );

        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching client bookings:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const generateCompletionOtpController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ message: "Forbidden" });
    }

    const { id } = req.params;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const bookingResult = await client.query(
            `SELECT sb.id, sb.status, sb.completion_otp_failed_attempts, u.email, u.name
             FROM service_bookings sb
             JOIN users u ON u.id = sb.user_id
             WHERE sb.id = $1 AND sb.user_id = $2 LIMIT 1`,
            [id, authUser.userId]
        );

        if (bookingResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Booking not found" });
        }

        const booking = bookingResult.rows[0];

        if (booking.status !== "in_progress") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "OTP can only be generated for in-progress bookings" });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await client.query(
            `UPDATE service_bookings
             SET completion_otp_hash = $1,
                 completion_otp_expires_at = $2,
                 completion_otp_failed_attempts = 0,
                 updated_at = NOW()
             WHERE id = $3`,
            [otpHash, expiresAt, id]
        );

        await client.query("COMMIT");

        await sendEmail({
            to: booking.email,
            subject: "Your Service Completion OTP",
            htmlContent: `
                <p>Hi ${booking.name},</p>
                <p>Your service completion OTP is: <strong style="font-size:24px;letter-spacing:4px">${otp}</strong></p>
                <p>Share this OTP with your vendor to confirm the service has been completed satisfactorily.</p>
                <p>This OTP is valid for <strong>10 minutes</strong>. Do not share it with anyone other than your assigned vendor.</p>
            `,
        });

        return res.status(200).json({ message: "OTP sent to your registered email address" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error generating completion OTP:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const createServiceQuotationController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can request service quotations" });
    }

    const { vendorId, serviceId, scopeOfWork, requestedPrice } = req.body as Record<string, unknown>;

    if (!vendorId || typeof vendorId !== "string") {
        return res.status(400).json({ message: "vendorId is required" });
    }
    if (!serviceId || typeof serviceId !== "string") {
        return res.status(400).json({ message: "serviceId is required" });
    }
    const scopeText = normalizeText(scopeOfWork);
    if (!scopeText) {
        return res.status(400).json({ message: "scopeOfWork is required" });
    }

    const priceVal = requestedPrice != null ? parsePositiveDecimal(requestedPrice) : null;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const [serviceCheck, vendorCheck] = await Promise.all([
            client.query(`SELECT id, name FROM services WHERE id = $1 AND status = 'approved' LIMIT 1`, [serviceId]),
            client.query(`SELECT id, user_id FROM vendors WHERE id = $1 AND approval_status = 'approved' LIMIT 1`, [vendorId]),
        ]);

        if (serviceCheck.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Service not found" });
        }
        if (vendorCheck.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Vendor not found or not approved" });
        }

        const serviceName = serviceCheck.rows[0].name;
        const vendorUserId = vendorCheck.rows[0].user_id;

        const vendorServiceCheck = await client.query(
            `SELECT price, delivery_days, token_percentage FROM vendor_services WHERE vendor_id = $1 AND service_id = $2 LIMIT 1`,
            [vendorId, serviceId]
        );

        let defaultPrice: number | null = null;
        let defaultDeliveryDays: number | null = null;
        let defaultTokenPercentage: number | null = null;
        let defaultTokenAmount: number | null = null;

        if (vendorServiceCheck.rows.length > 0) {
            const row = vendorServiceCheck.rows[0];
            defaultPrice = row.price != null ? Number(row.price) : null;
            defaultDeliveryDays = row.delivery_days != null ? Number(row.delivery_days) : null;
            defaultTokenPercentage = row.token_percentage != null ? Number(row.token_percentage) : null;
            if (defaultPrice != null && defaultTokenPercentage != null) {
                defaultTokenAmount = Number(((defaultTokenPercentage / 100) * (defaultPrice * 1.18)).toFixed(2));
            }
        }

        const quotationResult = await client.query(
            `INSERT INTO service_quotations (
                user_id, vendor_id, service_id, scope_of_work, requested_price, status,
                current_offer_price, delivery_days, token_percentage, token_amount, current_offer_by
             )
             VALUES ($1, $2, $3, $4, $5, 'pending_vendor', $6, $7, $8, $9, 'vendor')
             RETURNING id, status, scope_of_work, requested_price, created_at`,
            [
                authUser.userId, 
                vendorId, 
                serviceId, 
                scopeText, 
                priceVal,
                defaultPrice,
                defaultDeliveryDays,
                defaultTokenPercentage,
                defaultTokenAmount
            ]
        );

        const quotation = quotationResult.rows[0];

        await client.query(
            `INSERT INTO service_quotation_messages (quotation_id, sender_user_id, sender_role, action, offer_price, note)
             VALUES ($1, $2, 'client', 'request', $3, $4)`,
            [quotation.id, authUser.userId, priceVal, scopeText]
        );

        await client.query("COMMIT");

        // Fetch client address details and generate base quotation PDF in background
        pool.query(
            `SELECT city, state, pincode, country FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [authUser.userId]
        ).then((addrResult) => {
            const address = addrResult.rows[0] || {};
            generateBaseServiceQuotationDocument({
                serviceQuotationId: quotation.id,
                userId: authUser.userId,
                serviceId,
                serviceName,
                scopeOfWork: scopeText,
                targetPrice: priceVal ? Number(priceVal) : undefined,
                clientCity: address.city || "",
                clientState: address.state || "",
                clientPincode: address.pincode || "",
                clientCountry: address.country || "India",
            }).catch((err) => {
                console.error(`[ServiceQuotationDocument] Failed to generate base document for service quotation ${quotation.id}:`, err);
            });
        }).catch((err) => {
            console.error(`[ServiceQuotationDocument] Failed to query address details for base service document ${quotation.id}:`, err);
        });

        // Trigger real-time notification to vendor
        if (vendorUserId) {
            await createNotification({
                userId: vendorUserId,
                type: "quotation_request_received",
                title: "New service quotation request",
                body: `You received a service quotation request for ${serviceName}`,
                referenceType: "quotation",
                referenceId: quotation.id,
            });
        }

        return res.status(201).json({
            message: "Service quotation request submitted",
            data: quotation,
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error creating service quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const getMyServiceQuotationsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ message: "Forbidden" });
    }

    try {
        const result = await pool.query(
            `SELECT
                sq.id, sq.status, sq.scope_of_work, sq.requested_price, sq.agreed_price, sq.created_at, sq.updated_at,
                sq.service_id, sq.vendor_id,
                s.name AS service_name,
                v.company_name AS vendor_name,
                COALESCE(
                    (SELECT sm.media_url FROM services_media sm WHERE sm.service_id = s.id AND sm.is_primary = true LIMIT 1),
                    (SELECT sm.media_url FROM services_media sm WHERE sm.service_id = s.id LIMIT 1),
                    (SELECT pc.image FROM product_category pc WHERE pc.id = s.category_id LIMIT 1)
                ) AS service_image
             FROM service_quotations sq
             JOIN services s ON s.id = sq.service_id
             JOIN vendors v ON v.id = sq.vendor_id
             WHERE sq.user_id = $1
             ORDER BY sq.updated_at DESC`,
            [authUser.userId]
        );

        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching client service quotations:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getServiceQuotationDetailController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const isClient = authUser.role === "client";
    const isVendor = authUser.role === "vendor";

    if (!isClient && !isVendor) {
        return res.status(403).json({ message: "Forbidden" });
    }

    try {
        let quotationResult;
        if (isClient) {
            quotationResult = await pool.query(
                `SELECT sq.*, s.name AS service_name, v.company_name AS vendor_name, 
                        sqd.document_url AS base_document_url, sqd.s3_key AS base_document_s3_key,
                        vs.pricing_type, vs.moq
                 FROM service_quotations sq
                 JOIN services s ON s.id = sq.service_id
                 JOIN vendors v ON v.id = sq.vendor_id
                 LEFT JOIN vendor_services vs ON vs.vendor_id = sq.vendor_id AND vs.service_id = sq.service_id
                 LEFT JOIN service_quotation_documents sqd ON sqd.service_quotation_id = sq.id
                 WHERE sq.id = $1 AND sq.user_id = $2 LIMIT 1`,
                [id, authUser.userId]
            );
        } else {
            const vendorId = await getVendorIdByUserId(authUser.userId);
            if (!vendorId) return res.status(403).json({ message: "Vendor profile not found" });
            quotationResult = await pool.query(
                `SELECT sq.*, s.name AS service_name, u.name AS client_name, u.email AS client_email, 
                        sqd.document_url AS base_document_url, sqd.s3_key AS base_document_s3_key,
                        vs.pricing_type, vs.moq
                 FROM service_quotations sq
                 JOIN services s ON s.id = sq.service_id
                 JOIN users u ON u.id = sq.user_id
                 LEFT JOIN vendor_services vs ON vs.vendor_id = sq.vendor_id AND vs.service_id = sq.service_id
                 LEFT JOIN service_quotation_documents sqd ON sqd.service_quotation_id = sq.id
                 WHERE sq.id = $1 AND sq.vendor_id = $2 LIMIT 1`,
                [id, vendorId]
            );
        }

        if (quotationResult.rows.length === 0) {
            return res.status(404).json({ message: "Quotation not found" });
        }

        const quotationRow = quotationResult.rows[0];

        // Presign S3 documents
        if (quotationRow.base_document_s3_key) {
            try {
                quotationRow.base_document_url = await getPresignedUrl(quotationRow.base_document_s3_key);
            } catch (s3Err) {
                console.error("Failed to generate presigned URL for service base doc:", s3Err);
            }
        }
        if (quotationRow.vendor_document_s3_key) {
            try {
                quotationRow.vendor_document_url = await getPresignedUrl(quotationRow.vendor_document_s3_key);
            } catch (s3Err) {
                console.error("Failed to generate presigned URL for service vendor doc:", s3Err);
            }
        }

        const messagesResult = await pool.query(
            `SELECT sqm.id, sqm.sender_role, sqm.action, sqm.offer_price, sqm.note, sqm.reason, sqm.created_at,
                    u.name AS sender_name
             FROM service_quotation_messages sqm
             JOIN users u ON u.id = sqm.sender_user_id
             WHERE sqm.quotation_id = $1
             ORDER BY sqm.created_at ASC`,
            [id]
        );

        return res.status(200).json({
            data: {
                quotation: quotationRow,
                messages: messagesResult.rows,
            },
        });
    } catch (error) {
        console.error("Error fetching service quotation detail:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const respondServiceQuotationController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const { action, offerPrice, note, reason, deliveryDays, tokenPercentage } = req.body as Record<string, unknown>;

    const VALID_CLIENT_ACTIONS = new Set(["counter", "accept", "reject"]);
    const VALID_VENDOR_ACTIONS = new Set(["offer", "counter", "accept", "reject"]);

    const isClient = authUser.role === "client";
    const isVendor = authUser.role === "vendor";

    if (!isClient && !isVendor) {
        return res.status(403).json({ message: "Forbidden" });
    }

    const validActions = isClient ? VALID_CLIENT_ACTIONS : VALID_VENDOR_ACTIONS;
    if (!action || typeof action !== "string" || !validActions.has(action)) {
        return res.status(400).json({ message: `Invalid action. Allowed: ${[...validActions].join(", ")}` });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        let quotationResult;
        let senderRole: string;
        let vendorUserId: string | null = null;
        let vendorId: string | null = null;

        if (isClient) {
            quotationResult = await client.query(
                `SELECT sq.id, sq.status, sq.vendor_id, sq.service_id, sq.scope_of_work, sq.user_id, v.user_id AS vendor_user_id 
                 FROM service_quotations sq 
                 LEFT JOIN vendors v ON v.id = sq.vendor_id 
                 WHERE sq.id = $1 AND sq.user_id = $2 LIMIT 1`,
                [id, authUser.userId]
            );
            senderRole = "client";
            if (quotationResult.rows.length > 0) {
                vendorUserId = quotationResult.rows[0].vendor_user_id;
            }
        } else {
            vendorId = await getVendorIdByUserId(authUser.userId);
            if (!vendorId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ message: "Vendor profile not found" });
            }
            quotationResult = await client.query(
                `SELECT sq.id, sq.status, sq.vendor_id, sq.service_id, sq.scope_of_work, sq.user_id 
                 FROM service_quotations sq 
                 WHERE sq.id = $1 AND sq.vendor_id = $2 LIMIT 1`,
                [id, vendorId]
            );
            senderRole = "vendor";
        }

        if (quotationResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Quotation not found" });
        }

        const quotation = quotationResult.rows[0];
        const terminalStatuses = new Set(["client_accepted", "client_rejected", "vendor_rejected", "cancelled"]);
        if (terminalStatuses.has(quotation.status)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "This quotation is already finalised" });
        }

        const statusMap: Record<string, string> = {
            offer: "vendor_offered",
            counter: isClient ? "client_countered" : "vendor_countered",
            accept: isClient ? "client_accepted" : "vendor_offered",
            reject: isClient ? "client_rejected" : "vendor_rejected",
        };

        const newStatus = statusMap[action]!;
        const priceVal = offerPrice != null ? parsePositiveDecimal(offerPrice) : null;

        // When client accepts, the agreed_price is the vendor's current offered price (already on the row as agreed_price)
        // When vendor offers/counters, the agreed_price is the price they send
        let agreedPrice: string | null = null;
        if (action === "offer" || action === "counter") {
            agreedPrice = priceVal;
        } else if (action === "accept" && isClient) {
            // Use the vendor's offered price from the DB row
            const currentPriceResult = await client.query(
                `SELECT agreed_price FROM service_quotations WHERE id = $1`,
                [id]
            );
            const rawPrice = currentPriceResult.rows[0]?.agreed_price;
            agreedPrice = rawPrice != null ? String(rawPrice) : null;
        }

        // On vendor first offer, delivery_days and token_percentage are required
        if (isVendor && action === "offer" && (deliveryDays == null || tokenPercentage == null)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Timeline days and token money percentage are required for the first offer" });
        }

        // Calculate token amount if provided
        let tokenAmt: number | null = null;
        if (priceVal != null && tokenPercentage != null) {
            const priceNum = Number(priceVal);
            const totalVal = priceNum;
            const gstAmount = totalVal * 0.18; // 18% GST
            const grandTotal = totalVal + gstAmount;
            tokenAmt = (Number(tokenPercentage) / 100) * grandTotal;
        }

        await client.query(
            `UPDATE service_quotations
             SET status = $1, 
                 agreed_price = COALESCE($2, agreed_price), 
                 delivery_days = COALESCE($4, delivery_days),
                 token_percentage = COALESCE($5, token_percentage),
                 token_amount = COALESCE($6, token_amount),
                 current_offer_price = COALESCE($7, current_offer_price),
                 current_offer_by = $8,
                 updated_at = NOW()
             WHERE id = $3`,
            [
                newStatus, 
                agreedPrice, 
                id, 
                deliveryDays != null ? Number(deliveryDays) : null,
                tokenPercentage != null ? Number(tokenPercentage) : null,
                tokenAmt,
                priceVal != null ? Number(priceVal) : null,
                senderRole
            ]
        );

        if (newStatus === "client_accepted") {
            const vsResult = await client.query(
                `SELECT id FROM vendor_services WHERE vendor_id = $1 AND service_id = $2 LIMIT 1`,
                [quotation.vendor_id, quotation.service_id]
            );
            if (vsResult.rows.length > 0) {
                const vendorServiceId = vsResult.rows[0].id;
                const bookingResult = await client.query(
                    `INSERT INTO service_bookings (user_id, vendor_id, vendor_service_id, total_amount, status, payment_status, booking_notes, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, 'confirmed', 'pending', $5, NOW(), NOW())
                     RETURNING id`,
                    [quotation.user_id, quotation.vendor_id, vendorServiceId, agreedPrice || priceVal || 0, quotation.scope_of_work]
                );
                const bookingId = bookingResult.rows[0].id;
                await client.query(
                    `UPDATE service_quotations SET booking_id = $1 WHERE id = $2`,
                    [bookingId, id]
                );
            }
        }

        await client.query(
            `INSERT INTO service_quotation_messages (quotation_id, sender_user_id, sender_role, action, offer_price, note, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, authUser.userId, senderRole, action, priceVal, normalizeText(note), normalizeText(reason)]
        );

        await client.query("COMMIT");

        // Generate vendor-specific document on offer or counter (non-blocking)
        const finalDeliveryDays = deliveryDays !== null && deliveryDays !== undefined ? Number(deliveryDays) : null;
        const finalTokenPercentage = tokenPercentage !== null && tokenPercentage !== undefined ? Number(tokenPercentage) : null;

        if ((action === "offer" || action === "counter") && isVendor && vendorId && finalDeliveryDays != null && finalTokenPercentage != null) {
            const vendorNameResult = await pool.query(
                `SELECT company_name FROM vendors WHERE id = $1`, [vendorId]
            );
            const vendorName = vendorNameResult.rows[0]?.company_name || "Vendor";

            generateVendorServiceQuotationDocument({
                serviceQuotationId: id as string,
                vendorId,
                vendorName,
                offerPrice: Number(priceVal),
                deliveryDays: finalDeliveryDays,
                tokenPercentage: finalTokenPercentage,
            }).then(async (result) => {
                await pool.query(
                    `UPDATE service_quotations SET vendor_document_url = $1, vendor_document_s3_key = $2 WHERE id = $3`,
                    [result.documentUrl, result.s3Key, id as string]
                );
            }).catch((err) => {
                console.error(`[ServiceQuotationDocument] Failed to generate vendor document for quotation ${id as string}:`, err);
            });
        } else if (action === "counter" && isClient) {
            const fullQuoteResult = await pool.query(
                `SELECT sq.vendor_id, sq.delivery_days, sq.token_percentage, v.company_name
                 FROM service_quotations sq
                 JOIN vendors v ON sq.vendor_id = v.id
                 WHERE sq.id = $1 LIMIT 1`,
                [id as string]
            );
            if (fullQuoteResult.rows.length > 0) {
                const row = fullQuoteResult.rows[0];
                if (row.delivery_days != null && row.token_percentage != null) {
                    generateVendorServiceQuotationDocument({
                        serviceQuotationId: id as string,
                        vendorId: row.vendor_id,
                        vendorName: row.company_name || "Vendor",
                        offerPrice: Number(priceVal),
                        deliveryDays: Number(row.delivery_days),
                        tokenPercentage: Number(row.token_percentage),
                    }).then(async (result) => {
                        await pool.query(
                            `UPDATE service_quotations SET vendor_document_url = $1, vendor_document_s3_key = $2 WHERE id = $3`,
                            [result.documentUrl, result.s3Key, id as string]
                        );
                    }).catch((err) => {
                        console.error(`[ServiceQuotationDocument] Failed to generate vendor document on client counter for quotation ${id as string}:`, err);
                    });
                }
            }
        }

        // Trigger real-time notifications for quotation updates
        if (isClient && vendorUserId) {
            await createNotification({
                userId: vendorUserId,
                type: action === "reject" ? "quotation_rejected" : action === "accept" ? "quotation_accepted" : "quotation_counter_received",
                title: "Quotation Update",
                body: action === "counter"
                    ? "Client counter-offered for your service request"
                    : action === "accept"
                    ? "Client accepted your service request"
                    : "Client rejected your service request",
                referenceType: "quotation",
                referenceId: id as string,
            });
        } else if (isVendor && quotation.user_id) {
            await createNotification({
                userId: quotation.user_id,
                type: action === "reject" ? "quotation_rejected" : action === "accept" ? "quotation_accepted" : "quotation_counter_received",
                title: "Quotation Update",
                body: action === "offer"
                    ? "Vendor submitted an offer for your service request"
                    : action === "counter"
                    ? "Vendor counter-offered for your service request"
                    : action === "accept"
                    ? "Vendor accepted your service request"
                    : "Vendor rejected your service request",
                referenceType: "quotation",
                referenceId: id as string,
            });
        }

        return res.status(200).json({ message: "Quotation updated", data: { status: newStatus } });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error responding to service quotation:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const submitServiceReviewController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "client") {
        return res.status(403).json({ message: "Only clients can submit service reviews" });
    }

    const { bookingId, rating, reviewTitle, reviewText, images } = req.body as Record<string, unknown>;

    if (!bookingId || typeof bookingId !== "string") {
        return res.status(400).json({ message: "bookingId is required" });
    }

    const parsedRating = parseRating(rating);
    if (parsedRating === null) {
        return res.status(400).json({ message: "rating must be an integer between 1 and 5" });
    }

    const imageList = Array.isArray(images)
        ? images.filter((img): img is string => typeof img === "string")
        : [];

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const bookingResult = await client.query(
            `SELECT sb.id, sb.status, sb.vendor_id, vs.service_id
             FROM service_bookings sb
             JOIN vendor_services vs ON vs.id = sb.vendor_service_id
             WHERE sb.id = $1 AND sb.user_id = $2 LIMIT 1`,
            [bookingId, authUser.userId]
        );

        if (bookingResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Booking not found" });
        }

        const booking = bookingResult.rows[0];

        if (booking.status !== "completed") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Reviews can only be submitted after the service is completed" });
        }

        await client.query(
            `INSERT INTO service_reviews (booking_id, user_id, service_id, vendor_id, rating, review_title, review_text, images)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                bookingId,
                authUser.userId,
                booking.service_id,
                booking.vendor_id,
                parsedRating,
                normalizeText(reviewTitle),
                normalizeText(reviewText),
                imageList,
            ]
        );

        await updateServiceAggregate(client, booking.service_id, parsedRating);
        await updateVendorAggregate(client, booking.vendor_id, parsedRating);

        await client.query("COMMIT");

        return res.status(201).json({ message: "Review submitted successfully" });
    } catch (error) {
        await client.query("ROLLBACK");
        const code = (error as { code?: string }).code;
        if (code === "23505") {
            return res.status(409).json({ message: "You have already reviewed this booking" });
        }
        console.error("Error submitting service review:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const getVendorServiceBookingsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Forbidden" });
    }

    const vendorId = await getVendorIdByUserId(authUser.userId);
    if (!vendorId) {
        return res.status(403).json({ message: "Vendor profile not found or not approved" });
    }

    try {
        const result = await pool.query(
            `SELECT
                sb.id, sb.status, sb.payment_status, sb.total_amount,
                sb.scheduled_start, sb.scheduled_end, sb.booking_notes, sb.created_at,
                sb.vendor_service_id,
                s.name AS service_name,
                u.name AS client_name, u.email AS client_email,
                vs.pricing_type,
                sq.id AS service_quotation_id
             FROM service_bookings sb
             JOIN vendor_services vs ON vs.id = sb.vendor_service_id
             JOIN services s ON s.id = vs.service_id
             JOIN users u ON u.id = sb.user_id
             LEFT JOIN service_quotations sq ON sq.booking_id = sb.id
             WHERE sb.vendor_id = $1
             ORDER BY sb.created_at DESC`,
            [vendorId]
        );

        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching vendor service bookings:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const getVendorServiceBookingByIdController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Forbidden" });
    }

    const { id } = req.params;
    const vendorId = await getVendorIdByUserId(authUser.userId);
    if (!vendorId) {
        return res.status(403).json({ message: "Vendor profile not found or not approved" });
    }

    try {
        const result = await pool.query(
            `SELECT
                sb.id, sb.status, sb.payment_status, sb.total_amount,
                sb.scheduled_start, sb.scheduled_end, sb.booking_notes, sb.created_at,
                sb.vendor_service_id,
                s.name AS service_name,
                s.description AS service_description,
                u.name AS client_name, u.email AS client_email,
                u.phone AS client_phone,
                vs.pricing_type,
                sq.id AS service_quotation_id,
                sq.scope_of_work
             FROM service_bookings sb
             JOIN vendor_services vs ON vs.id = sb.vendor_service_id
             JOIN services s ON s.id = vs.service_id
             JOIN users u ON u.id = sb.user_id
             LEFT JOIN service_quotations sq ON sq.booking_id = sb.id
             WHERE sb.id = $1 AND sb.vendor_id = $2
             LIMIT 1`,
            [id, vendorId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Booking not found" });
        }

        return res.status(200).json({ data: result.rows[0] });
    } catch (error) {
        console.error("Error fetching vendor service booking by ID:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

export const vendorCompleteBookingController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Forbidden" });
    }

    const { id } = req.params;
    const { otp } = req.body as { otp?: unknown };

    if (!otp || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({ message: "A valid 6-digit OTP is required" });
    }

    const vendorId = await getVendorIdByUserId(authUser.userId);
    if (!vendorId) {
        return res.status(403).json({ message: "Vendor profile not found or not approved" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const bookingResult = await client.query(
            `SELECT id, status, completion_otp_hash, completion_otp_expires_at, completion_otp_failed_attempts
             FROM service_bookings
             WHERE id = $1 AND vendor_id = $2 LIMIT 1`,
            [id, vendorId]
        );

        if (bookingResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Booking not found" });
        }

        const booking = bookingResult.rows[0];

        if (booking.status !== "in_progress") {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "Booking is not in progress" });
        }

        if (!booking.completion_otp_hash || !booking.completion_otp_expires_at) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "No OTP has been generated for this booking. Ask the client to generate one." });
        }

        if (new Date() > new Date(booking.completion_otp_expires_at)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ message: "OTP has expired. Ask the client to generate a new one." });
        }

        const MAX_ATTEMPTS = 5;
        if (booking.completion_otp_failed_attempts >= MAX_ATTEMPTS) {
            await client.query("ROLLBACK");
            return res.status(429).json({ message: "Too many failed OTP attempts. Ask the client to generate a new OTP." });
        }

        const inputHash = crypto.createHash("sha256").update(otp).digest("hex");

        if (inputHash !== booking.completion_otp_hash) {
            await client.query(
                `UPDATE service_bookings
                 SET completion_otp_failed_attempts = completion_otp_failed_attempts + 1, updated_at = NOW()
                 WHERE id = $1`,
                [id]
            );
            await client.query("COMMIT");
            const remaining = MAX_ATTEMPTS - (booking.completion_otp_failed_attempts + 1);
            return res.status(400).json({ message: `Incorrect OTP. ${remaining} attempt(s) remaining.` });
        }

        await client.query(
            `UPDATE service_bookings
             SET status = 'completed',
                 completion_otp_hash = NULL,
                 completion_otp_expires_at = NULL,
                 completion_otp_failed_attempts = 0,
                 updated_at = NOW()
             WHERE id = $1`,
            [id]
        );

        await client.query("COMMIT");

        return res.status(200).json({ message: "Service booking marked as completed" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error completing service booking:", error);
        return res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

export const getVendorServiceQuotationsController = async (req: Request, res: Response): Promise<Response> => {
    const authUser = getAuthUser(req);
    if (!authUser || authUser.role !== "vendor") {
        return res.status(403).json({ message: "Forbidden" });
    }

    const vendorId = await getVendorIdByUserId(authUser.userId);
    if (!vendorId) {
        return res.status(403).json({ message: "Vendor profile not found or not approved" });
    }

    try {
        const result = await pool.query(
            `SELECT
                sq.id, sq.status, sq.scope_of_work, sq.requested_price, sq.agreed_price, sq.created_at, sq.updated_at,
                s.name AS service_name,
                u.name AS client_name
             FROM service_quotations sq
             JOIN services s ON s.id = sq.service_id
             JOIN users u ON u.id = sq.user_id
             WHERE sq.vendor_id = $1
             ORDER BY sq.updated_at DESC`,
            [vendorId]
        );

        return res.status(200).json({ data: result.rows });
    } catch (error) {
        console.error("Error fetching vendor service quotations:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

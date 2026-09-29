import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import Razorpay from "razorpay";
import pool from "../DbConnect";
import { emitHireChatMessage, emitHireRequestUpdated } from "../socket";
import {
    HiringError, hiringAmountInPaise, assertHiringNegotiable, assertHiringOfferAcceptable,
    assertCapturedHiringPayment, validHiringPaymentSignature,
} from "../helpers/hiringLifecycle";

type AuthUser = { userId: string; role: string };
type HiringRecord = Record<string, any>;
type TransactionResult = { data?: any; messages?: HiringRecord[]; [key: string]: any };

const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID || "", key_secret: process.env.RAZORPAY_KEY_SECRET || "" });
const requestFields = `hr.*, ec.full_name AS candidate_name, ec.is_available,
    ec.registered_by_user_id AS worker_user_id, requester.name AS client_name,
    requester.email AS client_email`;

export const hiringPaymentSummarySql = `(SELECT json_build_object(
    'status', p.status, 'amount', p.amount, 'currency', p.currency,
    'razorpay_payment_id', p.razorpay_payment_id,
    'paid_at', CASE WHEN p.status = 'successful' THEN p.updated_at ELSE NULL END)
    FROM payments p WHERE p.hire_request_id = hr.id AND p.payment_type = 'worker_hiring'
    ORDER BY (p.status = 'successful') DESC, p.created_at DESC LIMIT 1) AS payment`;

function auth(req: Request, roles: string[] = ["client", "worker"]): AuthUser {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user?.userId) throw new HiringError(401, "Authentication required.");
    if (!roles.includes(user.role)) throw new HiringError(403, "This account cannot perform this hiring action.");
    return user;
}

function failure(res: Response, error: unknown): Response {
    if (error instanceof HiringError) return res.status(error.status).json({ success: false, message: error.message });
    console.error("Hiring operation failed:", error);
    return res.status(500).json({ success: false, message: "Could not update hiring. Please try again." });
}

function checkRequestId(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
        throw new HiringError(400, "A valid hiring request ID is required.");
    }
}

export async function getAuthorizedHiringRequest(requestId: string, user: AuthUser) {
    checkRequestId(requestId);
    const result = await pool.query(
        `SELECT ${requestFields}, ${hiringPaymentSummarySql}
         FROM hire_requests hr JOIN employee_candidates ec ON ec.id = hr.candidate_id
         JOIN users requester ON requester.id = hr.requested_by_user_id
         WHERE hr.id = $1 AND (($2 = 'client' AND hr.requested_by_user_id = $3)
            OR ($2 = 'worker' AND ec.registered_by_user_id = $3))`,
        [requestId, user.role, user.userId],
    );
    return result.rows[0] || null;
}

// Every lifecycle mutation locks the worker first, then the request. This also
// serializes two different clients trying to reserve/pay for the same worker.
async function transaction(requestId: string, user: AuthUser,
    work: (db: PoolClient, request: HiringRecord) => Promise<TransactionResult>): Promise<TransactionResult> {
    checkRequestId(requestId);
    const db = await pool.connect();
    try {
        await db.query("BEGIN");
        const owner = await db.query(
            `SELECT hr.candidate_id FROM hire_requests hr JOIN employee_candidates ec ON ec.id = hr.candidate_id
             WHERE hr.id = $1 AND (($2 = 'client' AND hr.requested_by_user_id = $3)
                OR ($2 = 'worker' AND ec.registered_by_user_id = $3))`, [requestId, user.role, user.userId]);
        if (!owner.rows[0]) throw new HiringError(404, "Hiring request not found.");
        await db.query(`SELECT id FROM employee_candidates WHERE id = $1 FOR UPDATE`, [owner.rows[0].candidate_id]);
        const result = await db.query(
            `SELECT ${requestFields} FROM hire_requests hr
             JOIN employee_candidates ec ON ec.id = hr.candidate_id
             JOIN users requester ON requester.id = hr.requested_by_user_id
             WHERE hr.id = $1 FOR UPDATE OF hr`, [requestId]);
        const request = result.rows[0];
        if (!request || (user.role === "worker" && request.worker_user_id !== user.userId) ||
            (user.role === "client" && request.requested_by_user_id !== user.userId)) {
            throw new HiringError(404, "Hiring request not found.");
        }
        const output = await work(db, request);
        await db.query("COMMIT");
        for (const message of output.messages || []) emitHireChatMessage(requestId, message);
        emitHireRequestUpdated(requestId, [request.requested_by_user_id, request.worker_user_id].filter(Boolean));
        return output;
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    } finally {
        db.release();
    }
}

async function addMessage(db: PoolClient, requestId: string, user: AuthUser, type: string, body: string, amount?: number) {
    const result = await db.query(
        `INSERT INTO hire_request_messages (hire_request_id, sender_user_id, sender_role, message_type, body, proposed_amount)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at`,
        [requestId, user.userId, user.role, type, body, amount ?? null]);
    return result.rows[0];
}

async function assertWorkerFree(db: PoolClient, request: HiringRecord) {
    const other = await db.query(
        `SELECT id FROM hire_requests WHERE candidate_id = $1 AND id <> $2
         AND contract_status IN ('active', 'payment_pending') LIMIT 1`, [request.candidate_id, request.id]);
    if (!request.is_available || other.rows.length) {
        throw new HiringError(409, "This worker already has an active contract or another payment in progress.");
    }
}

export const createHireRequestController = async (req: Request, res: Response) => {
    let db: PoolClient | undefined;
    try {
        const user = auth(req, ["client"]);
        const access = await pool.query(
            `
            SELECT id
            FROM payments
            WHERE user_id = $1
            AND payment_type = 'hiring_access'
            AND status = 'successful'
            LIMIT 1
            `,
            [user.userId]
        );

        if (!access.rows[0]) {
            throw new HiringError(
                403,
                "Unlock Hiring Access before sending hiring requests."
            );
        }
        const candidateId = String(req.body?.candidate_id || "");
        checkRequestId(candidateId);
        const details = req.body?.request_details ?? {};
        if (!details || typeof details !== "object" || Array.isArray(details)) throw new HiringError(400, "Request details must be an object.");
        db = await pool.connect();
        await db.query("BEGIN");
        const candidate = await db.query(`SELECT id FROM employee_candidates
            WHERE id = $1 AND verification_status = 'verified' AND is_available = true FOR UPDATE`, [candidateId]);
        if (!candidate.rows[0]) throw new HiringError(404, "Candidate not found or not available.");
        const existing = await db.query(`SELECT id FROM hire_requests WHERE candidate_id = $1 AND
            ((requested_by_user_id = $2 AND status IN ('pending', 'accepted', 'approved') AND contract_status <> 'completed')
             OR contract_status IN ('active', 'payment_pending')) LIMIT 1`, [candidateId, user.userId]);
        if (existing.rows[0]) throw new HiringError(409, "An ongoing hiring request or payment already exists for this worker.");
        const result = await db.query(`INSERT INTO hire_requests (candidate_id, requested_by_user_id, request_details)
            VALUES ($1, $2, $3::jsonb) RETURNING *`, [candidateId, user.userId, JSON.stringify(details)]);
        await db.query("COMMIT");
        return res.status(201).json({ success: true, message: "Hire request sent to the worker.", data: result.rows[0] });
    } catch (error) {
        if (db) await db.query("ROLLBACK");
        return failure(res, error);
    } finally { db?.release(); }
};

export const updateWorkerHireRequestController = async (req: Request, res: Response) => {
    try {
        const user = auth(req, ["worker"]);
        const status = req.body?.status;
        if (!["accepted", "rejected"].includes(status)) throw new HiringError(400, "Choose accepted or rejected.");
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            if (request.status !== "pending") throw new HiringError(409, "This hiring request has already been reviewed.");
            if (status === "accepted") await assertWorkerFree(db, request);
            const updated = await db.query(`UPDATE hire_requests SET status = $2, reviewed_at = NOW(), updated_at = NOW()
                WHERE id = $1 RETURNING *`, [request.id, status]);
            const message = await addMessage(db, request.id, user, "request_review", `Worker ${status} the hiring request.`);
            return { data: updated.rows[0], messages: [message] };
        });
        return res.json({ success: true, data: result.data });
    } catch (error) { return failure(res, error); }
};

export const getHireConversationController = async (req: Request, res: Response) => {
    try {
        const requestId = String(req.params.id);
        const request = await getAuthorizedHiringRequest(requestId, auth(req));
        if (!request) throw new HiringError(404, "Hiring request not found.");
        if (!["accepted", "completed"].includes(request.status)) throw new HiringError(409, "Conversation opens after the worker accepts the request.");
        const messages = await pool.query(`SELECT id, sender_user_id, sender_role, message_type, body, proposed_amount, created_at
            FROM hire_request_messages WHERE hire_request_id = $1 ORDER BY created_at ASC, id ASC`, [requestId]);
        return res.json({ success: true, data: { request, messages: messages.rows } });
    } catch (error) { return failure(res, error); }
};

export const sendHireMessageController = async (req: Request, res: Response) => {
    try {
        const user = auth(req);
        const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
        if (!body || body.length > 5000) throw new HiringError(400, "Messages must contain between 1 and 5,000 characters.");
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            if (request.status !== "accepted" || request.contract_status === "completed") throw new HiringError(409, "This conversation is not open for messages.");
            const message = await addMessage(db, request.id, user, "message", body);
            return { data: message, messages: [message] };
        });
        return res.status(201).json({ success: true, data: result.data });
    } catch (error) { return failure(res, error); }
};

export const proposeHireAmountController = async (req: Request, res: Response) => {
    try {
        const user = auth(req);
        const amount = hiringAmountInPaise(req.body?.amount) / 100;
        const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
        if (note.length > 5000) throw new HiringError(400, "The offer note is too long.");
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            assertHiringNegotiable(request as Parameters<typeof assertHiringNegotiable>[0]);
            const message = await addMessage(db, request.id, user, "offer", note || `Proposed amount: INR ${amount.toFixed(2)}`, amount);
            await db.query(`UPDATE hire_requests SET proposed_amount = $2, negotiation_status = 'proposed',
                negotiation_proposed_by = $3, latest_offer_id = $4, updated_at = NOW() WHERE id = $1`,
                [request.id, amount, user.userId, message.id]);
            return { data: message, messages: [message] };
        });
        return res.status(201).json({ success: true, data: result.data });
    } catch (error) { return failure(res, error); }
};

export const acceptHireOfferController = async (req: Request, res: Response) => {
    try {
        const user = auth(req);
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            assertHiringOfferAcceptable(request as Parameters<typeof assertHiringOfferAcceptable>[0], user.userId, req.body?.offer_id);
            await db.query(`UPDATE hire_requests SET agreed_amount = proposed_amount, negotiation_status = 'agreed',
                agreed_at = NOW(), updated_at = NOW() WHERE id = $1`, [request.id]);
            const message = await addMessage(db, request.id, user, "accept", "Amount agreed and locked. The client can now complete payment.", Number(request.proposed_amount));
            return { data: message, messages: [message] };
        });
        return res.status(201).json({ success: true, data: result.data });
    } catch (error) { return failure(res, error); }
};

function requireGateway() {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new HiringError(503, "Hiring payments are not configured yet.");
}

export const createHirePaymentOrderController = async (req: Request, res: Response) => {
    try {
        const user = auth(req, ["client"]);
        requireGateway();
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            if (request.negotiation_status === "paid" || ["active", "completed"].includes(request.contract_status)) {
                throw new HiringError(409, "This hiring contract is already paid. Refresh its status.");
            }
            if (request.status !== "accepted" || request.negotiation_status !== "agreed" ||
                !["pending_payment", "payment_pending"].includes(request.contract_status)) {
                throw new HiringError(409, "Agree and lock the amount before paying.");
            }
            await assertWorkerFree(db, request);
            const amount = hiringAmountInPaise(request.agreed_amount);
            const existing = await db.query(`SELECT * FROM payments WHERE hire_request_id = $1 AND payment_type = 'worker_hiring'
                AND status IN ('pending', 'successful') ORDER BY (status = 'successful') DESC, created_at DESC LIMIT 1 FOR UPDATE`, [request.id]);
            if (existing.rows[0]?.status === "successful") throw new HiringError(409, "Payment already received. Check payment status.");
            let orderId = existing.rows[0]?.razorpay_order_id;
            if (orderId && (hiringAmountInPaise(existing.rows[0].amount) !== amount || existing.rows[0].currency !== "INR")) {
                throw new HiringError(409, "An earlier payment order has a different amount. Contact support before paying.");
            }
            const messages: HiringRecord[] = [];
            if (!orderId) {
                const order = await razorpay.orders.create({ amount, currency: "INR", receipt: `hire_${request.id.slice(0, 8)}_${Date.now()}`,
                    notes: { hireRequestId: request.id, clientId: user.userId } });
                orderId = order.id;
                await db.query(`INSERT INTO payments (user_id, amount, currency, status, payment_method, razorpay_order_id, hire_request_id, payment_type)
                    VALUES ($1, $2, 'INR', 'pending', 'razorpay', $3, $4, 'worker_hiring')`, [user.userId, amount / 100, orderId, request.id]);
                messages.push(await addMessage(db, request.id, user, "payment_order", "Payment started. This worker is reserved while payment is pending.", amount / 100));
            }
            await db.query(`UPDATE hire_requests SET contract_status = 'payment_pending', updated_at = NOW() WHERE id = $1`, [request.id]);
            return { keyId: process.env.RAZORPAY_KEY_ID, amount, currency: "INR", razorpayOrderId: orderId, messages };
        });
        const { messages: _messages, ...order } = result;
        return res.json({ success: true, ...order });
    } catch (error) { return failure(res, error); }
};

async function finalizePayment(db: PoolClient, request: HiringRecord, payment: HiringRecord,
    gateway: Awaited<ReturnType<typeof razorpay.payments.fetch>>, user: AuthUser, signature?: string): Promise<TransactionResult> {
    assertCapturedHiringPayment(payment as Parameters<typeof assertCapturedHiringPayment>[0], gateway, request.agreed_amount);
    if (payment.status === "successful") {
        if (payment.razorpay_payment_id !== gateway.id) throw new HiringError(409, "This order was already verified with a different payment.");
        // A repeated callback must never reactivate a completed contract.
        return { status: "paid", data: request };
    }
    if (request.status !== "accepted" || request.negotiation_status !== "agreed" ||
        !["pending_payment", "payment_pending"].includes(request.contract_status)) {
        throw new HiringError(409, "The hiring contract is no longer awaiting payment. Contact support.");
    }
    await assertWorkerFree(db, request);
    const duplicate = await db.query(`SELECT id FROM payments WHERE razorpay_payment_id = $1 AND id <> $2 LIMIT 1`, [gateway.id, payment.id]);
    if (duplicate.rows.length) throw new HiringError(409, "This payment has already been used.");
    await db.query(`UPDATE payments SET status = 'successful', razorpay_payment_id = $2,
        razorpay_signature = COALESCE($3, razorpay_signature), updated_at = NOW() WHERE id = $1`, [payment.id, gateway.id, signature ?? null]);
    const updated = await db.query(`UPDATE hire_requests SET negotiation_status = 'paid', contract_status = 'active',
        paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = $1 RETURNING *`, [request.id]);
    await db.query(`UPDATE employee_candidates SET is_available = false, updated_at = NOW() WHERE id = $1`, [request.candidate_id]);
    const message = await addMessage(db, request.id, user, "payment", "Payment verified. The hiring contract is active and the worker is booked.", Number(payment.amount));
    return { status: "paid", data: updated.rows[0], messages: [message] };
}

export const verifyHirePaymentController = async (req: Request, res: Response) => {
    try {
        const user = auth(req, ["client"]);
        requireGateway();
        const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
        if (![orderId, paymentId, signature].every(value => typeof value === "string" && value.length > 0)) throw new HiringError(400, "Payment verification details are required.");
        if (!validHiringPaymentSignature(orderId, paymentId, signature, process.env.RAZORPAY_KEY_SECRET || "")) throw new HiringError(400, "Invalid payment signature.");
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            const payment = await db.query(`SELECT * FROM payments WHERE razorpay_order_id = $1 AND hire_request_id = $2
                AND user_id = $3 AND payment_type = 'worker_hiring' FOR UPDATE`, [orderId, request.id, user.userId]);
            if (!payment.rows[0]) throw new HiringError(404, "Payment was not found for this hiring request.");
            const gateway = await razorpay.payments.fetch(paymentId);
            return finalizePayment(db, request, payment.rows[0], gateway, user, signature);
        });
        return res.json({ success: true, status: result.status, data: result.data, message: "Hiring payment verified." });
    } catch (error) { return failure(res, error); }
};

// Recover captured payments even when the browser closed before its callback.
// Ownership is checked locally; payment proof is fetched directly from Razorpay.
export const reconcileHirePaymentController = async (req: Request, res: Response) => {
    try {
        const user = auth(req, ["client"]);
        requireGateway();
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            const payment = await db.query(`SELECT * FROM payments WHERE hire_request_id = $1 AND user_id = $2
                AND payment_type = 'worker_hiring' ORDER BY (status = 'successful') DESC, created_at DESC LIMIT 1 FOR UPDATE`, [request.id, user.userId]);
            const saved = payment.rows[0];
            if (!saved) return { status: "pending", data: request };
            if (saved.status === "successful") return { status: "paid", data: request };
            const payments = await razorpay.orders.fetchPayments(saved.razorpay_order_id);
            const captured = payments.items.find(payment => payment.status === "captured");
            if (!captured) return { status: "pending", data: request };
            return finalizePayment(db, request, saved, captured, user);
        });
        return res.json({ success: true, status: result.status, data: result.data });
    } catch (error) { return failure(res, error); }
};

export const confirmHireContractCompletionController = async (req: Request, res: Response) => {
    try {
        const user = auth(req);
        const result = await transaction(String(req.params.id), user, async (db, request) => {
            if (request.negotiation_status !== "paid" || !["active", "completed"].includes(request.contract_status)) {
                throw new HiringError(409, "Only a paid, active contract can be completed.");
            }
            const column = user.role === "client" ? "client_completed_at" : "worker_completed_at";
            const messages: HiringRecord[] = [];
            if (!request[column]) {
                await db.query(`UPDATE hire_requests SET ${column} = NOW(), updated_at = NOW() WHERE id = $1`, [request.id]);
                request[column] = new Date();
                messages.push(await addMessage(db, request.id, user, "completion_confirmation", `${user.role === "client" ? "Client" : "Worker"} confirmed contract completion.`));
            }
            const bothConfirmed = Boolean(request.client_completed_at && request.worker_completed_at);
            if (bothConfirmed && request.contract_status !== "completed") {
                await db.query(`UPDATE hire_requests SET contract_status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`, [request.id]);
                await db.query(`UPDATE employee_candidates ec SET is_available = NOT EXISTS (
                    SELECT 1 FROM hire_requests hr WHERE hr.candidate_id = ec.id AND hr.contract_status IN ('active', 'payment_pending')
                ), updated_at = NOW() WHERE ec.id = $1`, [request.candidate_id]);
                messages.push(await addMessage(db, request.id, user, "contract_completion", "Both parties confirmed completion. The hiring contract is complete."));
            }
            const updated = await db.query(`SELECT contract_status, client_completed_at, worker_completed_at, completed_at FROM hire_requests WHERE id = $1`, [request.id]);
            return { data: updated.rows[0], bothConfirmed, messages };
        });
        return res.json({ success: true, data: result.data, bothConfirmed: result.bothConfirmed });
    } catch (error) { return failure(res, error); }
};

export const cancelHireRequestController = async (
  req: Request,
  res: Response
) => {
  try {
    const user = auth(req, ["client"]);

    const result = await transaction(
      String(req.params.id),
      user,
      async (db, request) => {
        if (request.status !== "pending") {
          throw new HiringError(
            409,
            "Only pending hiring requests can be cancelled."
          );
        }

        const updated = await db.query(
          `
          UPDATE hire_requests
          SET
            status = 'cancelled',
            updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [request.id]
        );

        return {
          data: updated.rows[0],
        };
      }
    );

    return res.json({
      success: true,
      message: "Hiring request cancelled.",
      data: result.data,
    });
  } catch (error) {
    return failure(res, error);
  }
};

const HIRING_ACCESS_AMOUNT = 100;

async function hasHiringAccess(userId: string) {
    const result = await pool.query(
        `
        SELECT id
        FROM payments
        WHERE user_id = $1
          AND payment_type = 'hiring_access'
          AND status = 'successful'
        LIMIT 1
        `,
        [userId]
    );

    return result.rows.length > 0;
}

export const getHiringAccessStatusController = async (
    req: Request,
    res: Response
) => {
    try {
        const user = auth(req, ["client"]);

        const hasAccess = await hasHiringAccess(
            user.userId
        );

        return res.json({
            success: true,
            hasAccess,
            amount: HIRING_ACCESS_AMOUNT,
            currency: "INR",
        });
    } catch (error) {
        return failure(res, error);
    }
};

export const createHiringAccessPaymentOrderController = async (
    req: Request,
    res: Response
) => {
    try {
        const user = auth(req, ["client"]);

        requireGateway();

        if (await hasHiringAccess(user.userId)) {
            return res.json({
                success: true,
                alreadyUnlocked: true,
            });
        }

        const existing = await pool.query(
            `
            SELECT *
            FROM payments
            WHERE user_id = $1
              AND payment_type = 'hiring_access'
              AND status IN ('pending', 'successful')
            ORDER BY
              (status = 'successful') DESC,
              created_at DESC
            LIMIT 1
            `,
            [user.userId]
        );

        const saved = existing.rows[0];

        if (saved?.status === "successful") {
            return res.json({
                success: true,
                alreadyUnlocked: true,
            });
        }

        let orderId =
            saved?.razorpay_order_id || null;

        if (!orderId) {
            const order =
                await razorpay.orders.create({
                    amount:
                        HIRING_ACCESS_AMOUNT *
                        100,
                    currency: "INR",
                    receipt: `hire_access_${user.userId.slice(
                        0,
                        8
                    )}_${Date.now()}`,
                    notes: {
                        userId: user.userId,
                        paymentType:
                            "hiring_access",
                    },
                });

            orderId = order.id;

            await pool.query(
                `
                INSERT INTO payments (
                    user_id,
                    amount,
                    currency,
                    status,
                    payment_method,
                    razorpay_order_id,
                    payment_type
                )
                VALUES (
                    $1,
                    $2,
                    'INR',
                    'pending',
                    'razorpay',
                    $3,
                    'hiring_access'
                )
                `,
                [
                    user.userId,
                    HIRING_ACCESS_AMOUNT,
                    orderId,
                ]
            );
        }

        return res.json({
            success: true,
            alreadyUnlocked: false,
            keyId:
                process.env.RAZORPAY_KEY_ID,
            amount:
                HIRING_ACCESS_AMOUNT * 100,
            currency: "INR",
            razorpayOrderId: orderId,
        });
    } catch (error) {
        return failure(res, error);
    }
};

export const verifyHiringAccessPaymentController = async (
    req: Request,
    res: Response
) => {
    try {
        const user = auth(req, ["client"]);

        requireGateway();

        const {
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signature,
        } = req.body || {};

        if (
            ![orderId, paymentId, signature].every(
                (value) =>
                    typeof value === "string" &&
                    value.length > 0
            )
        ) {
            throw new HiringError(
                400,
                "Payment verification details are required."
            );
        }

        if (
            !validHiringPaymentSignature(
                orderId,
                paymentId,
                signature,
                process.env
                    .RAZORPAY_KEY_SECRET || ""
            )
        ) {
            throw new HiringError(
                400,
                "Invalid payment signature."
            );
        }

        const paymentResult =
            await pool.query(
                `
                SELECT *
                FROM payments
                WHERE razorpay_order_id = $1
                  AND user_id = $2
                  AND payment_type = 'hiring_access'
                LIMIT 1
                `,
                [orderId, user.userId]
            );

        const payment =
            paymentResult.rows[0];

        if (!payment) {
            throw new HiringError(
                404,
                "Hiring access payment was not found."
            );
        }

        if (
            payment.status === "successful"
        ) {
            return res.json({
                success: true,
                hasAccess: true,
            });
        }

        const gatewayPayment =
            await razorpay.payments.fetch(
                paymentId
            );

        if (
            gatewayPayment.order_id !==
            orderId
        ) {
            throw new HiringError(
                400,
                "Payment order mismatch."
            );
        }

        if (
            gatewayPayment.status !==
            "captured"
        ) {
            throw new HiringError(
                409,
                "Payment has not been captured yet."
            );
        }

        if (
            Number(gatewayPayment.amount) !==
            HIRING_ACCESS_AMOUNT * 100
        ) {
            throw new HiringError(
                409,
                "Payment amount mismatch."
            );
        }

        const duplicate =
            await pool.query(
                `
                SELECT id
                FROM payments
                WHERE razorpay_payment_id = $1
                  AND id <> $2
                LIMIT 1
                `,
                [
                    gatewayPayment.id,
                    payment.id,
                ]
            );

        if (duplicate.rows.length) {
            throw new HiringError(
                409,
                "This payment has already been used."
            );
        }

        await pool.query(
            `
            UPDATE payments
            SET
                status = 'successful',
                razorpay_payment_id = $2,
                razorpay_signature = $3,
                updated_at = NOW()
            WHERE id = $1
            `,
            [
                payment.id,
                gatewayPayment.id,
                signature,
            ]
        );

        return res.json({
            success: true,
            hasAccess: true,
            message:
                "Hiring access unlocked successfully.",
        });
    } catch (error) {
        return failure(res, error);
    }
};
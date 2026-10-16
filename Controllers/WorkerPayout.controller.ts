import type { Request, Response } from "express";
import pool from "../DbConnect";
import { BUCKET_NAME, uploadBufferToS3 } from "../services/s3.service";
import { encryptPayoutAccountNumber } from "../services/payoutBankEncryption.service";

const money = (value: unknown) => Number(value || 0);

function worker(req: Request, res: Response) {
  const user = (req as any).user;
  if (!user?.userId) { res.status(401).json({ success: false, message: "Authentication required." }); return null; }
  if (user.role !== "worker") { res.status(403).json({ success: false, message: "Only workers can manage worker payouts." }); return null; }
  return user as { userId: string; role: string };
}

export const getWorkerPayoutBankDetailsController = async (req: Request, res: Response): Promise<Response> => {
  const user = worker(req, res);
  if (!user) return res as Response;
  try {
    const result = await pool.query(
      `SELECT bank_name, account_holder_name, account_number_last4 AS account_last_four,
              ifsc_code, (cancelled_cheque_link IS NOT NULL) AS cheque_uploaded
       FROM worker_payout_bank_details WHERE worker_user_id = $1`, [user.userId]);
    return res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    console.error("Error retrieving worker payout bank details:", error);
    return res.status(500).json({ success: false, message: "Unable to load payout bank details." });
  }
};

export const updateWorkerPayoutBankDetailsController = async (req: Request, res: Response): Promise<Response> => {
  const user = worker(req, res);
  if (!user) return res as Response;
  const bankName = String(req.body?.bankName || "").trim();
  const accountHolderName = String(req.body?.accountHolderName || "").trim();
  const accountNumber = String(req.body?.accountNumber || "").trim();
  const ifscCode = String(req.body?.ifscCode || "").trim().toUpperCase();
  const cheque = req.file;
  if (!bankName || !accountHolderName || !/^\d{9,18}$/.test(accountNumber)
    || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode) || !cheque) {
    return res.status(400).json({ success: false, message: "Valid bank details and cancelled-cheque image/PDF are required." });
  }
  if (!["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"].includes(cheque.mimetype)) {
    return res.status(400).json({ success: false, message: "Cancelled cheque must be a PDF or image." });
  }
  if (!BUCKET_NAME) return res.status(503).json({ success: false, message: "Document storage is not configured." });

  let encryptedAccount: string;
  try { encryptedAccount = encryptPayoutAccountNumber(accountNumber); }
  catch { return res.status(503).json({ success: false, message: "Payout account encryption is not configured." }); }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const candidate = await db.query(`SELECT id FROM employee_candidates WHERE registered_by_user_id = $1 LIMIT 1 FOR UPDATE`, [user.userId]);
    if (!candidate.rows.length) { await db.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Worker profile not found." }); }
    const pending = await db.query(`SELECT 1 FROM worker_payout_requests WHERE worker_user_id = $1 AND status IN ('requested', 'partially_paid') LIMIT 1`, [user.userId]);
    if (pending.rows.length) { await db.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Bank details cannot change while a payout request is pending." }); }

    const extension = cheque.originalname.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    const key = `worker-payout-cheques/${user.userId}_${Date.now()}.${extension}`;
    await uploadBufferToS3(cheque.buffer, key, cheque.mimetype);
    await db.query(
      `INSERT INTO worker_payout_bank_details (worker_user_id, bank_name, account_holder_name, account_number, account_number_last4, ifsc_code, cancelled_cheque_link, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (worker_user_id) DO UPDATE SET bank_name = EXCLUDED.bank_name, account_holder_name = EXCLUDED.account_holder_name,
       account_number = EXCLUDED.account_number, account_number_last4 = EXCLUDED.account_number_last4,
       ifsc_code = EXCLUDED.ifsc_code, cancelled_cheque_link = EXCLUDED.cancelled_cheque_link, updated_at = NOW()`,
      [user.userId, bankName, accountHolderName, encryptedAccount, accountNumber.slice(-4), ifscCode, key]);
    await db.query("COMMIT");
    return res.json({ success: true, message: "Payout bank details saved." });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Error updating worker payout bank details:", error);
    return res.status(500).json({ success: false, message: "Unable to save payout bank details." });
  } finally { db.release(); }
};

export const getWorkerPayoutEligibilityController = async (req: Request, res: Response): Promise<Response> => {
  const user = worker(req, res);
  if (!user) return res as Response;
  try {
    const result = await pool.query(
      `SELECT hr.id AS hire_request_id, hr.request_details, hr.agreed_amount,
              ec.full_name AS worker_name, ec.designation,
              CASE WHEN latest.status IS NOT NULL AND latest.status <> 'rejected' THEN latest.commission_percentage ELSE settings.worker_rate END AS commission_percentage,
              client.name AS client_name, hr.completed_at, hr.client_completed_at, hr.worker_completed_at,
              CASE WHEN latest.status IS NOT NULL AND latest.status <> 'rejected' THEN latest.eligible_amount
                   ELSE ROUND(hr.agreed_amount * (100 - settings.worker_rate) / 100, 2) END AS eligible_amount,
              latest.status AS request_status, latest.id AS payout_request_id, latest.paid_amount,
              latest.rejection_reason, latest.requested_at, latest.processed_at,
              COALESCE(transfers.total_paid, 0) AS transferred_amount,
              (bank.worker_user_id IS NOT NULL AND bank.cancelled_cheque_link IS NOT NULL) AS bank_details_complete
       FROM hire_requests hr
       JOIN employee_candidates ec ON ec.id = hr.candidate_id
       JOIN users client ON client.id = hr.requested_by_user_id
       JOIN LATERAL (SELECT p.status FROM payments p WHERE p.hire_request_id = hr.id AND p.payment_type = 'worker_hiring'
                    ORDER BY (p.status = 'successful') DESC, p.created_at DESC LIMIT 1) payment ON payment.status = 'successful'
       LEFT JOIN LATERAL (SELECT r.* FROM worker_payout_requests r WHERE r.hire_request_id = hr.id ORDER BY r.requested_at DESC LIMIT 1) latest ON TRUE
       CROSS JOIN LATERAL (SELECT COALESCE((SELECT worker_commission_percentage FROM payout_commission_settings WHERE id = 1), 0)::numeric AS worker_rate) settings
       LEFT JOIN LATERAL (SELECT SUM(t.amount) AS total_paid FROM worker_payout_transfers t WHERE t.request_id = latest.id) transfers ON TRUE
       LEFT JOIN worker_payout_bank_details bank ON bank.worker_user_id = ec.registered_by_user_id
       WHERE ec.registered_by_user_id = $1 AND hr.contract_status = 'completed'
         AND hr.client_completed_at IS NOT NULL AND hr.worker_completed_at IS NOT NULL
       ORDER BY hr.completed_at DESC NULLS LAST, hr.updated_at DESC`, [user.userId]);
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Error retrieving worker payout eligibility:", error);
    return res.status(500).json({ success: false, message: "Unable to load completed-contract payouts." });
  }
};

export const requestWorkerPayoutController = async (req: Request, res: Response): Promise<Response> => {
  const user = worker(req, res);
  if (!user) return res as Response;
  const hireRequestId = String(req.params.hireRequestId || "");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(hireRequestId)) {
    return res.status(400).json({ success: false, message: "A valid hiring contract ID is required." });
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await db.query(
      `SELECT hr.id, hr.contract_status, hr.negotiation_status, hr.agreed_amount, hr.client_completed_at, hr.worker_completed_at,
              ec.registered_by_user_id AS worker_user_id
       FROM hire_requests hr JOIN employee_candidates ec ON ec.id = hr.candidate_id
       WHERE hr.id = $1 AND ec.registered_by_user_id = $2 FOR UPDATE OF hr, ec`, [hireRequestId, user.userId]);
    const contract = result.rows[0];
    if (!contract) { await db.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Completed hiring contract not found." }); }
    if (contract.contract_status !== "completed" || contract.negotiation_status !== "paid" || !contract.client_completed_at || !contract.worker_completed_at) {
      await db.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Both client and worker must confirm a paid contract as complete before payout." });
    }
    const payment = await db.query(`SELECT 1 FROM payments WHERE hire_request_id = $1 AND payment_type = 'worker_hiring' AND status = 'successful' LIMIT 1`, [hireRequestId]);
    if (!payment.rows.length) { await db.query("ROLLBACK"); return res.status(409).json({ success: false, message: "The hiring payment is not confirmed yet." }); }
    const bank = await db.query(`SELECT 1 FROM worker_payout_bank_details WHERE worker_user_id = $1 AND cancelled_cheque_link IS NOT NULL`, [user.userId]);
    if (!bank.rows.length) { await db.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Add payout bank details and a cancelled cheque before requesting payout." }); }
    const commissionResult = await db.query(`SELECT worker_commission_percentage FROM payout_commission_settings WHERE id = 1 FOR SHARE`);
    const commission = money(commissionResult.rows[0]?.worker_commission_percentage);
    const gross = money(contract.agreed_amount);
    const eligibleAmount = Math.round((gross * (100 - commission) / 100) * 100 + Number.EPSILON) / 100;
    if (!Number.isFinite(gross) || gross <= 0 || !Number.isFinite(commission) || commission < 0 || commission > 100 || eligibleAmount <= 0) {
      await db.query("ROLLBACK"); return res.status(409).json({ success: false, message: "This contract has no positive eligible payout amount." });
    }
    const inserted = await db.query(
      `INSERT INTO worker_payout_requests (worker_user_id, hire_request_id, gross_amount, commission_percentage, eligible_amount, status)
       VALUES ($1, $2, $3, $4, $5, 'requested')
       RETURNING id AS request_id, status AS request_status, eligible_amount, requested_at`,
      [user.userId, hireRequestId, gross, commission, eligibleAmount]);
    await db.query("COMMIT");
    return res.status(201).json({ success: true, message: "Worker payout request sent to admin.", data: inserted.rows[0] });
  } catch (error: any) {
    await db.query("ROLLBACK");
    if (error?.code === "23505") return res.status(409).json({ success: false, message: "An active payout request already exists for this contract." });
    console.error("Error requesting worker payout:", error);
    return res.status(500).json({ success: false, message: "Unable to request worker payout." });
  } finally { db.release(); }
};

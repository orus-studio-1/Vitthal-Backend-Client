import crypto from "crypto";

export class HiringError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

// Store rupees with two decimal places and compare gateway values in paise.
export function hiringAmountInPaise(value: unknown): number {
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
        throw new HiringError(400, "Enter a valid amount in rupees.");
    }
    const amount = Number(value);
    const paise = Math.round(amount * 100);
    if (!Number.isFinite(amount) || paise <= 0 || paise > 999999999999 || Math.abs(amount * 100 - paise) > 0.0001) {
        throw new HiringError(400, "The amount must be positive with at most two decimal places.");
    }
    return paise;
}

export function assertHiringNegotiable(request: { status: string; negotiation_status: string; contract_status: string }) {
    if (request.status !== "accepted") throw new HiringError(409, "The worker must accept the request before negotiating.");
    if (!["open", "proposed"].includes(request.negotiation_status) || request.contract_status !== "pending_payment") {
        throw new HiringError(409, "The agreed amount is locked and cannot be changed.");
    }
}

export function assertHiringOfferAcceptable(
    request: { status: string; negotiation_status: string; contract_status: string; proposed_amount: unknown; negotiation_proposed_by: string; latest_offer_id: string },
    userId: string,
    expectedOfferId?: unknown,
) {
    assertHiringNegotiable(request);
    if (request.negotiation_status !== "proposed" || !request.proposed_amount) throw new HiringError(409, "There is no open offer to accept.");
    if (request.negotiation_proposed_by === userId) throw new HiringError(403, "You cannot accept your own offer.");
    if (expectedOfferId !== undefined && expectedOfferId !== request.latest_offer_id) {
        throw new HiringError(409, "The offer has changed. Review the latest amount before accepting.");
    }
    hiringAmountInPaise(request.proposed_amount);
}

export function validHiringPaymentSignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
    if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function assertCapturedHiringPayment(
    payment: { razorpay_order_id: string; amount: unknown; currency: string },
    gateway: { id: string; order_id: string; amount: number | string; currency: string; status: string; captured?: boolean },
    agreedAmount: unknown,
) {
    if (gateway.order_id !== payment.razorpay_order_id || gateway.currency !== payment.currency ||
        Number(gateway.amount) !== hiringAmountInPaise(payment.amount) ||
        hiringAmountInPaise(payment.amount) !== hiringAmountInPaise(agreedAmount)) {
        throw new HiringError(409, "The payment does not match the locked hiring amount and order.");
    }
    if (gateway.status !== "captured" || gateway.captured === false) {
        throw new HiringError(409, "Payment is awaiting capture. Check payment status again shortly.");
    }
}

type QuotationUpdatePayload = {
    recipientName: string;
    quotationId: string;
    status: string;
    note?: string;
    reason?: string;
};

export function buildQuotationUpdateEmailHtml(payload: QuotationUpdatePayload): string {
    return `
        <div style="font-family: Arial, sans-serif; color: #0f172a;">
            <h2>Quotation update</h2>
            <p>Hello ${payload.recipientName},</p>
            <p>Your quotation request has been updated.</p>
            <p><strong>Quotation ID:</strong> ${payload.quotationId}</p>
            <p><strong>Status:</strong> ${payload.status.replace(/_/g, " ")}</p>
            ${payload.note ? `<p><strong>Note:</strong> ${payload.note}</p>` : ""}
            ${payload.reason ? `<p><strong>Reason:</strong> ${payload.reason}</p>` : ""}
            <p>Please log in to review the latest details.</p>
        </div>
    `;
}

export function buildQuotationUpdateEmailText(payload: QuotationUpdatePayload): string {
    return `Quotation update\n\n` +
        `Quotation ID: ${payload.quotationId}\n` +
        `Status: ${payload.status.replace(/_/g, " ")}\n` +
        `${payload.note ? `Note: ${payload.note}\n` : ""}` +
        `${payload.reason ? `Reason: ${payload.reason}\n` : ""}` +
        `\nPlease log in to review the latest details.`;
}
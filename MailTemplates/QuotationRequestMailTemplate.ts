type QuotationRequestPayload = {
    vendorName: string;
    buyerId: string;
    buyerCity?: string | null;
    productName: string;
    quantity: number;
    requestedPrice?: number | null;
    note?: string;
};

export function buildQuotationRequestEmailHtml(payload: QuotationRequestPayload): string {
    const cityLine = payload.buyerCity ? `<p><strong>Buyer city:</strong> ${payload.buyerCity}</p>` : "";
    const requestedPrice = payload.requestedPrice != null ? `₹${Number(payload.requestedPrice).toLocaleString()}` : "Not specified";

    return `
        <div style="font-family: Arial, sans-serif; color: #0f172a;">
            <h2>New quotation request received</h2>
            <p>Hello ${payload.vendorName},</p>
            <p>You have received a new quotation request on MTWO Group.</p>
            <p><strong>Buyer ID:</strong> ${payload.buyerId}</p>
            ${cityLine}
            <p><strong>Product:</strong> ${payload.productName}</p>
            <p><strong>Quantity:</strong> ${payload.quantity}</p>
            <p><strong>Requested price:</strong> ${requestedPrice}</p>
            ${payload.note ? `<p><strong>Buyer note:</strong> ${payload.note}</p>` : ""}
            <p>Please log in to your vendor dashboard to respond.</p>
        </div>
    `;
}

export function buildQuotationRequestEmailText(payload: QuotationRequestPayload): string {
    const requestedPrice = payload.requestedPrice != null ? `₹${Number(payload.requestedPrice).toLocaleString()}` : "Not specified";
    return `New quotation request received\n\n` +
        `Vendor: ${payload.vendorName}\n` +
        `Buyer ID: ${payload.buyerId}\n` +
        `${payload.buyerCity ? `Buyer city: ${payload.buyerCity}\n` : ""}` +
        `Product: ${payload.productName}\n` +
        `Quantity: ${payload.quantity}\n` +
        `Requested price: ${requestedPrice}\n` +
        `${payload.note ? `Buyer note: ${payload.note}\n` : ""}` +
        `\nPlease log in to your vendor dashboard to respond.`;
}
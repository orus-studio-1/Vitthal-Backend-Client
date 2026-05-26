// puppeteer is imported dynamically below (ESM module)
import pool from "../DbConnect";
import { uploadBufferToS3 } from "./s3.service";

// ─── Company Constants ───────────────────────────────────────────────
const COMPANY_NAME = "MTWO Groups";
const COMPANY_LOGO_URL = "https://res.cloudinary.com/deudvpcgx/image/upload/v1779186769/favicon_somltc.jpg";
const COMPANY_ADDRESS_LINE1 = "Plot No. 42, Bopodi Industrial Estate";
const COMPANY_ADDRESS_LINE2 = "Bopodi, Pune, Maharashtra 411003";
const COMPANY_PHONE = "+91 20 2588 0042";
const COMPANY_EMAIL = "info@mtwogroups.com";
const COMPANY_WEBSITE = "www.mtwogroups.com";
const COMPANY_GST = "27AADCM1234F1Z5";
const GST_RATE = 18; // percent
const VALIDITY_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────
export type QuotationDocumentData = {
    quotationNumber: string;
    date: string;
    validUntil: string;
    clientId: string;
    clientCity: string;
    clientState: string;
    clientPincode: string;
    clientCountry: string;
    product: {
        name: string;
        description?: string;
        category?: string;
        specifications?: Record<string, string>;
        quantity: number;
        unitPrice: number;
    };
    // Vendor-filled fields (only for vendor-specific documents)
    vendorName?: string;
    vendorOfferPrice?: number;
    vendorOfferQuantity?: number;
    deliveryDays?: number;
    tokenPercentage?: number;
};

// ─── Generate Quotation Number ───────────────────────────────────────
export async function generateQuotationNumber(): Promise<string> {
    const result = await pool.query(`SELECT nextval('quotation_number_seq') AS seq`);
    const seq = String(result.rows[0].seq).padStart(5, "0");
    const year = new Date().getFullYear();
    return `QTN-${year}-${seq}`;
}

// ─── Format Currency ─────────────────────────────────────────────────
function formatINR(amount: number): string {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
    }).format(amount);
}

// ─── Build the HTML Template ─────────────────────────────────────────
function buildQuotationHTML(data: QuotationDocumentData): string {
    const subtotal = data.vendorOfferPrice
        ? data.vendorOfferPrice * (data.vendorOfferQuantity || data.product.quantity)
        : data.product.unitPrice * data.product.quantity;
    const gstAmount = (subtotal * GST_RATE) / 100;
    const total = subtotal + gstAmount;
    const tokenAmount = data.tokenPercentage ? (data.tokenPercentage / 100) * total : null;

    const qty = data.vendorOfferQuantity || data.product.quantity;
    const price = data.vendorOfferPrice || data.product.unitPrice;

    // Build specifications rows
    const specRows = data.product.specifications
        ? Object.entries(data.product.specifications)
              .map(
                  ([key, value]) => `
            <tr>
                <td style="padding:4px 12px;color:#6b7280;font-size:11px;border-bottom:1px solid #f3f4f6;">${key.replace(/_/g, " ").toUpperCase()}</td>
                <td style="padding:4px 12px;color:#374151;font-size:11px;border-bottom:1px solid #f3f4f6;" colspan="3">${value}</td>
            </tr>`
              )
              .join("")
        : "";

    const isVendorVersion = Boolean(data.vendorName);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        color: #1f2937;
        background: #fff;
        font-size: 13px;
        line-height: 1.5;
    }
    
    .page {
        max-width: 800px;
        margin: 0 auto;
        padding: 40px 48px;
    }
    
    .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding-bottom: 24px;
        border-bottom: 3px solid #166534;
    }
    
    .company-block {
        display: flex;
        align-items: center;
        gap: 14px;
    }
    
    .company-logo {
        width: 56px;
        height: 56px;
        border-radius: 10px;
        object-fit: contain;
    }
    
    .company-name {
        font-size: 22px;
        font-weight: 800;
        color: #166534;
        letter-spacing: -0.5px;
    }
    
    .company-tagline {
        font-size: 10px;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin-top: 2px;
    }
    
    .company-contact {
        text-align: right;
        font-size: 11px;
        color: #4b5563;
        line-height: 1.7;
    }
    
    .company-contact strong {
        color: #1f2937;
    }
    
    .title-bar {
        text-align: center;
        margin: 28px 0 24px;
    }
    
    .title-bar h1 {
        font-size: 28px;
        font-weight: 800;
        color: #166534;
        letter-spacing: 4px;
        text-transform: uppercase;
    }
    
    .title-bar .subtitle {
        font-size: 11px;
        color: #9ca3af;
        margin-top: 4px;
        letter-spacing: 1px;
    }
    
    .info-grid {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 28px;
        padding: 20px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
    }
    
    .info-col {
        flex: 1;
    }
    
    .info-col h3 {
        font-size: 10px;
        font-weight: 700;
        color: #166534;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 10px;
        padding-bottom: 6px;
        border-bottom: 2px solid #bbf7d0;
    }
    
    .info-row {
        display: flex;
        justify-content: space-between;
        padding: 3px 0;
        font-size: 12px;
    }
    
    .info-label {
        font-weight: 600;
        color: #6b7280;
    }
    
    .info-value {
        font-weight: 500;
        color: #1f2937;
    }
    
    .product-table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 24px;
    }
    
    .product-table thead th {
        background: #166534;
        color: #fff;
        padding: 10px 12px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        text-align: left;
    }
    
    .product-table thead th:first-child {
        border-radius: 6px 0 0 0;
    }
    
    .product-table thead th:last-child {
        border-radius: 0 6px 0 0;
        text-align: right;
    }
    
    .product-table thead th:nth-child(2),
    .product-table thead th:nth-child(3) {
        text-align: center;
    }
    
    .product-table tbody td {
        padding: 12px;
        border-bottom: 1px solid #e5e7eb;
        font-size: 12px;
    }
    
    .product-table tbody td:nth-child(2),
    .product-table tbody td:nth-child(3) {
        text-align: center;
    }
    
    .product-table tbody td:last-child {
        text-align: right;
        font-weight: 600;
    }
    
    .product-desc {
        font-size: 11px;
        color: #6b7280;
        margin-top: 4px;
    }
    
    .totals-section {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 28px;
    }
    
    .totals-table {
        width: 280px;
    }
    
    .totals-row {
        display: flex;
        justify-content: space-between;
        padding: 6px 0;
        font-size: 12px;
        border-bottom: 1px solid #f3f4f6;
    }
    
    .totals-row.grand-total {
        border-top: 2px solid #166534;
        border-bottom: 2px solid #166534;
        padding: 10px 0;
        margin-top: 4px;
        font-size: 14px;
        font-weight: 700;
        color: #166534;
    }
    
    .totals-label {
        color: #6b7280;
    }
    
    .totals-value {
        font-weight: 600;
        color: #1f2937;
    }
    
    .terms-section {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 20px 24px;
        margin-bottom: 28px;
    }
    
    .terms-section h3 {
        font-size: 13px;
        font-weight: 700;
        color: #166534;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 2px solid #bbf7d0;
    }
    
    .terms-section ol {
        padding-left: 20px;
    }
    
    .terms-section li {
        font-size: 11px;
        color: #4b5563;
        padding: 4px 0;
        line-height: 1.6;
    }
    
    .terms-section li strong {
        color: #1f2937;
    }
    
    .vendor-terms {
        background: #eff6ff;
        border: 1px solid #bfdbfe;
        border-radius: 8px;
        padding: 20px 24px;
        margin-bottom: 28px;
    }
    
    .vendor-terms h3 {
        font-size: 13px;
        font-weight: 700;
        color: #1e40af;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 2px solid #93c5fd;
    }
    
    .vendor-terms-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
    }
    
    .vendor-term-card {
        background: #fff;
        border: 1px solid #dbeafe;
        border-radius: 6px;
        padding: 12px;
    }
    
    .vendor-term-label {
        font-size: 10px;
        font-weight: 600;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    
    .vendor-term-value {
        font-size: 16px;
        font-weight: 700;
        color: #1e40af;
        margin-top: 2px;
    }
    
    .acceptance-section {
        text-align: center;
        padding: 24px 0;
        border-top: 1px solid #e5e7eb;
    }
    
    .acceptance-title {
        font-size: 11px;
        font-weight: 700;
        color: #166534;
        text-transform: uppercase;
        letter-spacing: 2px;
        margin-bottom: 24px;
    }
    
    .signature-block {
        display: flex;
        justify-content: center;
        gap: 80px;
        margin-top: 16px;
    }
    
    .signature-item {
        text-align: center;
    }
    
    .signature-line {
        width: 160px;
        border-bottom: 1px solid #9ca3af;
        margin-bottom: 6px;
        height: 40px;
    }
    
    .signature-label {
        font-size: 10px;
        color: #6b7280;
    }
    
    .watermark {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-30deg);
        font-size: 80px;
        font-weight: 800;
        color: rgba(22, 101, 52, 0.04);
        text-transform: uppercase;
        letter-spacing: 10px;
        pointer-events: none;
        z-index: 0;
    }
    
    .footer {
        text-align: center;
        padding-top: 16px;
        border-top: 3px solid #166534;
        font-size: 10px;
        color: #9ca3af;
    }
    
    .badge {
        display: inline-block;
        background: #dcfce7;
        color: #166534;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 4px;
        margin-left: 4px;
    }
    
    .badge-blue {
        background: #dbeafe;
        color: #1e40af;
    }
</style>
</head>
<body>
<div class="watermark">${COMPANY_NAME}</div>
<div class="page">
    <!-- Header -->
    <div class="header">
        <div class="company-block">
            <img src="${COMPANY_LOGO_URL}" alt="Logo" class="company-logo" />
            <div>
                <div class="company-name">${COMPANY_NAME}</div>
                <div class="company-tagline">B2B Industrial Marketplace</div>
            </div>
        </div>
        <div class="company-contact">
            <strong>${COMPANY_ADDRESS_LINE1}</strong><br/>
            ${COMPANY_ADDRESS_LINE2}<br/>
            ${COMPANY_PHONE}<br/>
            ${COMPANY_EMAIL}<br/>
            <strong>${COMPANY_WEBSITE}</strong>
        </div>
    </div>

    <!-- Title -->
    <div class="title-bar">
        <h1>Quotation</h1>
        <div class="subtitle">${isVendorVersion ? `Vendor Offer — ${data.vendorName}` : "Request for Quotation"}</div>
    </div>

    <!-- Info Grid -->
    <div class="info-grid">
        <div class="info-col">
            <h3>Quotation Information</h3>
            <div class="info-row">
                <span class="info-label">Quotation No.</span>
                <span class="info-value">${data.quotationNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${data.date}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Valid Until</span>
                <span class="info-value">${data.validUntil}</span>
            </div>
        </div>
        <div class="info-col">
            <h3>Client Details</h3>
            <div class="info-row">
                <span class="info-label">Client ID</span>
                <span class="info-value">${data.clientId}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Location</span>
                <span class="info-value">${data.clientCity}, ${data.clientState}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Pincode</span>
                <span class="info-value">${data.clientPincode}</span>
            </div>
        </div>
    </div>

    <!-- Product Table -->
    <table class="product-table">
        <thead>
            <tr>
                <th>Description</th>
                <th>Quantity</th>
                <th>Unit Price</th>
                <th>Total</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td>
                    <strong>${data.product.name}</strong>
                    ${data.product.category ? `<span class="badge">${data.product.category}</span>` : ""}
                    ${data.product.description ? `<div class="product-desc">${data.product.description.substring(0, 120)}${data.product.description.length > 120 ? "..." : ""}</div>` : ""}
                </td>
                <td>${qty.toLocaleString("en-IN")}</td>
                <td>${formatINR(price)}</td>
                <td>${formatINR(price * qty)}</td>
            </tr>
            ${specRows}
        </tbody>
    </table>

    <!-- Totals -->
    <div class="totals-section">
        <div class="totals-table">
            <div class="totals-row">
                <span class="totals-label">Subtotal</span>
                <span class="totals-value">${formatINR(subtotal)}</span>
            </div>
            <div class="totals-row">
                <span class="totals-label">GST (${GST_RATE}%)</span>
                <span class="totals-value">${formatINR(gstAmount)}</span>
            </div>
            <div class="totals-row grand-total">
                <span>Total</span>
                <span>${formatINR(total)}</span>
            </div>
            ${tokenAmount !== null ? `
            <div class="totals-row" style="margin-top:8px;">
                <span class="totals-label">Token Amount (${data.tokenPercentage}%)</span>
                <span class="totals-value" style="color:#dc2626;font-weight:700;">${formatINR(tokenAmount)}</span>
            </div>
            ` : ""}
        </div>
    </div>

    ${isVendorVersion ? `
    <!-- Vendor Terms -->
    <div class="vendor-terms">
        <h3>Vendor Offer Terms</h3>
        <div class="vendor-terms-grid">
            <div class="vendor-term-card">
                <div class="vendor-term-label">Offered by</div>
                <div class="vendor-term-value">${data.vendorName}</div>
            </div>
            <div class="vendor-term-card">
                <div class="vendor-term-label">Delivery Timeline</div>
                <div class="vendor-term-value">${data.deliveryDays} Days</div>
            </div>
            <div class="vendor-term-card">
                <div class="vendor-term-label">Token Money</div>
                <div class="vendor-term-value">${data.tokenPercentage}%</div>
            </div>
            <div class="vendor-term-card">
                <div class="vendor-term-label">Token Amount</div>
                <div class="vendor-term-value">${formatINR(tokenAmount || 0)}</div>
            </div>
        </div>
    </div>
    ` : ""}

    <!-- Terms and Conditions -->
    <div class="terms-section">
        <h3>Terms & Conditions</h3>
        <ol>
            <li><strong>Token Money:</strong> ${data.tokenPercentage ? `${data.tokenPercentage}% of the total amount (${formatINR(tokenAmount || 0)})` : "A percentage of the total amount"} shall be paid at the time of accepting this quotation as advance token money.</li>
            <li><strong>Delivery:</strong> ${data.deliveryDays ? `Delivery will be completed within <strong>${data.deliveryDays} business days</strong>` : "Delivery timeline will be confirmed by the vendor"} from the date of order confirmation at the buyer's specified address.</li>
            <li><strong>Validity:</strong> This quotation is valid until <strong>${data.validUntil}</strong>. After this date, prices and availability may change.</li>
            <li><strong>Pricing:</strong> All prices are subject to vendor confirmation. The final agreed price will be binding upon acceptance by both parties.</li>
            <li><strong>Payment:</strong> Full payment (minus token money) is due upon delivery or as per mutually agreed payment terms.</li>
            <li><strong>Platform:</strong> All dealings are facilitated through ${COMPANY_NAME}. Both parties agree to abide by the platform's terms of service.</li>
            <li><strong>Disputes:</strong> Any disputes arising from this quotation shall be resolved under the jurisdiction of Pune, Maharashtra.</li>
        </ol>
    </div>

    <!-- Acceptance -->
    <div class="acceptance-section">
        <div class="acceptance-title">Please confirm your acceptance of this quote</div>
        <div class="signature-block">
            <div class="signature-item">
                <div class="signature-line"></div>
                <div class="signature-label">Authorized Signature</div>
            </div>
            <div class="signature-item">
                <div class="signature-line"></div>
                <div class="signature-label">Date</div>
            </div>
        </div>
    </div>

    <!-- Footer -->
    <div class="footer">
        ${COMPANY_NAME} — ${COMPANY_ADDRESS_LINE1}, ${COMPANY_ADDRESS_LINE2} | GSTIN: ${COMPANY_GST}<br/>
        This is a computer-generated document. No signature is required for the digital version.
    </div>
</div>
</body>
</html>`;
}

// ─── Generate PDF from HTML ─────────────────────────────────────────
async function generatePDFBuffer(html: string): Promise<Buffer> {
    const puppeteer = await import("puppeteer");
    const browser = await puppeteer.default.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "load" });

        const pdfBuffer = await page.pdf({
            format: "A4",
            printBackground: true,
            margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
        });

        return Buffer.from(pdfBuffer);
    } finally {
        await browser.close();
    }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Generate the BASE quotation document (no vendor-specific data).
 * Called once when the client submits a quotation.
 */
export async function generateBaseQuotationDocument(params: {
    quotationGroupId: string;
    userId: string;
    productId: string;
    productName: string;
    productDescription?: string;
    productCategory?: string;
    productSpecifications?: Record<string, string>;
    requestedQuantity: number;
    requestedPrice: number;
    clientCity: string;
    clientState: string;
    clientPincode: string;
    clientCountry: string;
}): Promise<{ quotationNumber: string; documentUrl: string; s3Key: string; validUntil: string }> {
    const quotationNumber = await generateQuotationNumber();

    const now = new Date();
    const validUntilDate = new Date(now);
    validUntilDate.setDate(validUntilDate.getDate() + VALIDITY_DAYS);

    const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const validUntilStr = validUntilDate.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });

    const clientIdShort = params.userId.split("-")[0].toUpperCase();

    const docData: QuotationDocumentData = {
        quotationNumber,
        date: dateStr,
        validUntil: validUntilStr,
        clientId: `CUST-${clientIdShort}`,
        clientCity: params.clientCity || "—",
        clientState: params.clientState || "—",
        clientPincode: params.clientPincode || "—",
        clientCountry: params.clientCountry || "India",
        product: {
            name: params.productName,
            description: params.productDescription,
            category: params.productCategory,
            specifications: params.productSpecifications,
            quantity: params.requestedQuantity,
            unitPrice: params.requestedPrice || 0,
        },
    };

    const html = buildQuotationHTML(docData);
    const pdfBuffer = await generatePDFBuffer(html);

    const s3Key = `quotation-documents/${quotationNumber}.pdf`;
    const { url } = await uploadBufferToS3(pdfBuffer, s3Key, "application/pdf");

    // Save to DB
    await pool.query(
        `INSERT INTO quotation_documents (quotation_group_id, quotation_number, document_url, s3_key, valid_until, product_id, user_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            params.quotationGroupId,
            quotationNumber,
            url,
            s3Key,
            validUntilDate.toISOString().split("T")[0],
            params.productId,
            params.userId,
            JSON.stringify({
                productName: params.productName,
                requestedQuantity: params.requestedQuantity,
                requestedPrice: params.requestedPrice,
                clientCity: params.clientCity,
                clientState: params.clientState,
            }),
        ]
    );

    return { quotationNumber, documentUrl: url, s3Key, validUntil: validUntilDate.toISOString().split("T")[0] };
}

/**
 * Generate a VENDOR-SPECIFIC quotation document with their offer terms.
 * Called when a vendor makes their first offer.
 */
export async function generateVendorQuotationDocument(params: {
    quotationGroupId: string;
    vendorId: string;
    vendorName: string;
    offerPrice: number;
    offerQuantity: number;
    deliveryDays: number;
    tokenPercentage: number;
}): Promise<{ documentUrl: string; s3Key: string }> {
    // Get base document data
    const docResult = await pool.query(
        `SELECT qd.*, p.name AS product_name, p.description AS product_description,
                pc.label AS product_category,
                u.id AS user_id
         FROM quotation_documents qd
         JOIN products p ON qd.product_id = p.id
         LEFT JOIN product_category pc ON (p.category::text = pc.id::text OR p.category::text = pc.code)
         JOIN users u ON qd.user_id = u.id
         WHERE qd.quotation_group_id = $1
         LIMIT 1`,
        [params.quotationGroupId]
    );

    if (docResult.rows.length === 0) {
        throw new Error("Base quotation document not found for this group");
    }

    const baseDoc = docResult.rows[0];
    const metadata = baseDoc.metadata || {};

    const docData: QuotationDocumentData = {
        quotationNumber: baseDoc.quotation_number,
        date: new Date(baseDoc.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }),
        validUntil: new Date(baseDoc.valid_until).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }),
        clientId: `CUST-${baseDoc.user_id.split("-")[0].toUpperCase()}`,
        clientCity: metadata.clientCity || "—",
        clientState: metadata.clientState || "—",
        clientPincode: "—",
        clientCountry: "India",
        product: {
            name: baseDoc.product_name,
            description: baseDoc.product_description,
            category: baseDoc.product_category,
            quantity: metadata.requestedQuantity || params.offerQuantity,
            unitPrice: metadata.requestedPrice || 0,
        },
        vendorName: params.vendorName,
        vendorOfferPrice: params.offerPrice,
        vendorOfferQuantity: params.offerQuantity,
        deliveryDays: params.deliveryDays,
        tokenPercentage: params.tokenPercentage,
    };

    const html = buildQuotationHTML(docData);
    const pdfBuffer = await generatePDFBuffer(html);

    const vendorIdShort = params.vendorId.split("-")[0];
    const s3Key = `quotation-documents/${baseDoc.quotation_number}_vendor_${vendorIdShort}.pdf`;
    const { url } = await uploadBufferToS3(pdfBuffer, s3Key, "application/pdf");

    return { documentUrl: url, s3Key };
}

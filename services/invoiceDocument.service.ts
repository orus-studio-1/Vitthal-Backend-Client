import { readFile } from "node:fs/promises";
import path from "node:path";
import pool from "../DbConnect";

export type InvoiceDocumentType = "challan" | "tax-invoice";

export interface InvoiceDocumentData {
    id: string;
    order_reference: string | null;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    payment_status: string | null;
    address_line: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    pincode: string | null;
    total_amount: number | string;
    pickup_qr_token: string | null;
    created_at: string | Date;
    vendor_name: string | null;
    vendor_phone: string | null;
    vendor_gst_number: string | null;
    vendor_address: string | null;
    vendor_city: string | null;
    vendor_state: string | null;
    vendor_pincode: string | null;
}

export interface InvoiceDocumentItem {
    quantity: number | string;
    price: number | string;
    gst_percentage: number | string | null;
    product_name: string;
    variant_name?: string | null;
    item_code: string | null;
    unit: string | null;
}

function xml(value: unknown): string {
    return String(value ?? "-").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    })[character] || character);
}

function money(value: number): string {
    return `INR ${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

const ones = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function underThousand(value: number): string {
    const parts: string[] = [];
    if (value >= 100) { parts.push(`${ones[Math.floor(value / 100)]} Hundred`); value %= 100; }
    if (value >= 20) { parts.push(tens[Math.floor(value / 10)]); value %= 10; }
    if (value > 0) parts.push(ones[value]);
    return parts.join(" ");
}
function amountInWords(value: number): string {
    let whole = Math.floor(value);
    const groups: Array<[number, string]> = [[10000000, "Crore"], [100000, "Lakh"], [1000, "Thousand"]];
    const parts: string[] = [];
    for (const [size, label] of groups) {
        if (whole >= size) { const count = Math.floor(whole / size); parts.push(`${underThousand(count)} ${label}`); whole %= size; }
    }
    if (whole > 0 || !parts.length) parts.push(underThousand(whole));
    const paise = Math.round((value - Math.floor(value)) * 100);
    return `${parts.join(" ")} Rupees${paise ? ` and ${underThousand(paise)} Paise` : ""} Only`;
}

function wrap(value: unknown, maxChars: number): string[] {
    const words = String(value ?? "-").trim().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length > maxChars && line) { lines.push(line); line = word; }
        else line = next;
    }
    if (line) lines.push(line);
    return lines.length ? lines : ["-"];
}

function text(x: number, y: number, value: unknown, size = 11, color = "#1f2937", weight = 400, anchor = "start"): string {
    return `<text x="${x}" y="${y}" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${xml(value)}</text>`;
}

function paragraph(x: number, y: number, value: unknown, maxChars: number, size = 10, lineGap = 15, color = "#334155"): string {
    return wrap(value, maxChars).map((part, index) => text(x, y + index * lineGap, part, size, color)).join("");
}

function box(x: number, y: number, width: number, height: number, fill = "#ffffff", stroke = "#9aa8b8"): string {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
}

function dateLabel(value: string | Date): string {
    return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function address(...parts: Array<string | null | undefined>): string {
    return parts.filter(Boolean).join(", ") || "-";
}

export function buildInvoicePageSvg(
    order: InvoiceDocumentData,
    items: InvoiceDocumentItem[],
    type: InvoiceDocumentType,
    logoDataUri: string,
    copyLabel: string,
    pageNumber: number,
    pageCount: number,
    isCopyFinalPage = true,
): string {
    const w = 794;
    const h = 1123;
    const left = 42;
    const right = 752;
    const contentWidth = right - left;
    const reference = order.order_reference || order.id.slice(0, 8).toUpperCase();
    const docNo = `${type === "challan" ? "DC" : "INV"}-${reference}`;
    const isTax = type === "tax-invoice";
    const vendorAddress = address(order.vendor_address, order.vendor_city, order.vendor_state, order.vendor_pincode);
    const buyerAddress = address(order.address_line, order.city, order.state, order.pincode, order.country);
    const chunks: string[] = [];
    const add = (...parts: string[]) => chunks.push(...parts);

    add(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
    add(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
    add(box(left, 26, contentWidth, 102, "#f7f9fc", "#9ba8b8"));
    if (logoDataUri) add(`<image href="${logoDataUri}" x="54" y="40" width="72" height="72" preserveAspectRatio="xMidYMid meet"/>`);
    add(text(140, 70, "MTWO GROUPS", 22, "#173c7a", 700));
    add(text(140, 95, "B2B PROCUREMENT", 9, "#617187", 600));
    add(text(right - 16, 61, isTax ? "TAX INVOICE" : "DELIVERY CHALLAN", 21, "#173c7a", 700, "end"));
    add(text(right - 16, 86, `Document No.: ${docNo}`, 10, "#334155", 600, "end"));
    add(text(right - 16, 105, `Date: ${dateLabel(order.created_at)}`, 9, "#475569", 400, "end"));
    add(`<line x1="${left}" y1="143" x2="${right}" y2="143" stroke="#173c7a" stroke-width="2"/>`);
    if (!isTax) add(text(right - 4, 162, copyLabel, 9, "#173c7a", 700, "end"));

    const partyTop = 178;
    const gap = 14;
    const panelWidth = (contentWidth - gap) / 2;
    const panelHeight = 181;
    const section = (x: number, y: number, width: number, label: string) => {
        add(`<rect x="${x}" y="${y}" width="${width}" height="28" fill="#e9eef5" stroke="#9ba8b8" stroke-width="1"/>`);
        add(text(x + 12, y + 19, label, 10, "#25364b", 700));
    };
    section(left, partyTop, panelWidth, "SUPPLIER / SHIPPED FROM");
    section(left + panelWidth + gap, partyTop, panelWidth, isTax ? "BUYER / BILL TO" : "DELIVER TO");
    add(box(left, partyTop + 28, panelWidth, panelHeight - 28));
    add(box(left + panelWidth + gap, partyTop + 28, panelWidth, panelHeight - 28));
    const supplierX = left + 12;
    const buyerX = left + panelWidth + gap + 12;
    add(text(supplierX, partyTop + 52, order.vendor_name || "Vendor", 12, "#111827", 700));
    add(paragraph(supplierX, partyTop + 72, vendorAddress, 58, 9, 13));
    add(text(supplierX, partyTop + 126, `Phone: ${order.vendor_phone || "-"}`, 9));
    add(text(supplierX, partyTop + 145, `GSTIN: ${order.vendor_gst_number || "-"}`, 9));
    add(text(buyerX, partyTop + 52, order.customer_name || "Customer", 12, "#111827", 700));
    add(paragraph(buyerX, partyTop + 72, buyerAddress, 58, 9, 13));
    add(text(buyerX, partyTop + 126, `Phone: ${order.customer_phone || "-"}`, 9));
    add(text(buyerX, partyTop + 145, `Email: ${order.customer_email || "-"}`, 9));

    const infoTop = 380;
    const infoLabels = isTax
        ? [["ORDER REFERENCE", reference], ["PAYMENT STATUS", order.payment_status || "-"], ["BUYER STATE", order.state || "-"], ["SUPPLIER STATE", order.vendor_state || "-"]]
        : [["ORDER REFERENCE", reference], ["ORDER DATE", dateLabel(order.created_at)], ["PAYMENT STATUS", order.payment_status || "-"], ["DOCUMENT TYPE", "Delivery copy"]];
    const infoWidth = contentWidth / infoLabels.length;
    infoLabels.forEach(([label, value], index) => {
        const x = left + index * infoWidth;
        add(box(x, infoTop, infoWidth, 54, index % 2 ? "#ffffff" : "#f7f9fc"));
        add(text(x + 9, infoTop + 19, label, 7.5, "#64748b", 700));
        add(text(x + 9, infoTop + 39, value, 9, "#1f2937", 600));
    });
    add(text(left, 461, isTax ? "ITEMS / TAX DETAILS" : "MATERIALS SUPPLIED", 10, "#25364b", 700));
    if (!isTax) add(text(left, 481, "Please mention the order reference on delivery documents and correspondence.", 8.5, "#475569"));

    const tableTop = isTax ? 478 : 493;
    const columns = isTax
        ? [26, 62, 153, 48, 40, 38, 67, 73, 44, 75, 84]
        : [31, 80, 214, 58, 48, 48, 103, 128];
    const headers = isTax
        ? ["#", "ITEM CODE", "DESCRIPTION", "HSN/SAC", "QTY", "UOM", "RATE", "TAXABLE", "GST %", "GST AMOUNT", "TOTAL"]
        : ["#", "ITEM CODE", "DESCRIPTION", "HSN/SAC", "QTY", "UOM", "RATE (INR)", "AMOUNT (INR)"];
    const colX = [left];
    columns.forEach((width) => colX.push(colX[colX.length - 1] + width));
    const tableWidth = columns.reduce((sum, width) => sum + width, 0);
    add(`<rect x="${left}" y="${tableTop}" width="${tableWidth}" height="43" fill="#e9eef5" stroke="#7f8da0" stroke-width="1.2"/>`);
    headers.forEach((label, index) => {
        const anchor = index > 3 ? "middle" : "start";
        const x = anchor === "middle" ? colX[index] + columns[index] / 2 : colX[index] + 5;
        add(text(x, tableTop + 26, label, isTax ? 6.4 : 7.2, "#26364a", 700, anchor));
    });
    for (let index = 1; index < colX.length - 1; index++) add(`<line x1="${colX[index]}" y1="${tableTop}" x2="${colX[index]}" y2="${tableTop + 43}" stroke="#b8c2ce" stroke-width="1"/>`);

    const rowsTop = tableTop + 43;
    const rowHeight = 52;
    const visibleItems = items.length ? items : [];
    visibleItems.forEach((item, index) => {
        const y = rowsTop + index * rowHeight;
        add(`<rect x="${left}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${index % 2 ? "#ffffff" : "#fbfcfe"}" stroke="#c7d0da" stroke-width="1"/>`);
        for (let column = 1; column < colX.length - 1; column++) add(`<line x1="${colX[column]}" y1="${y}" x2="${colX[column]}" y2="${y + rowHeight}" stroke="#d3dae3" stroke-width="0.8"/>`);
        const qty = Number(item.quantity || 0);
        const rate = Number(item.price || 0);
        const taxable = qty * rate;
        const gstRate = item.gst_percentage === null ? null : Number(item.gst_percentage);
        const tax = gstRate === null ? null : Math.round(taxable * gstRate) / 100;
        const values = isTax
            ? [String(index + 1), item.item_code || "-", `${item.product_name}${item.variant_name ? ` (${item.variant_name})` : ""}`, "-", String(qty), item.unit || "nos", money(rate), money(taxable), gstRate === null ? "-" : `${gstRate}%`, tax === null ? "-" : money(tax), money(tax === null ? taxable : taxable + tax)]
            : [String(index + 1), item.item_code || "-", `${item.product_name}${item.variant_name ? ` (${item.variant_name})` : ""}`, "-", String(qty), item.unit || "nos", money(rate), money(taxable)];
        values.forEach((value, column) => {
            const isLongText = column === (isTax ? 2 : 2) || column === 1;
            const maxChars = Math.max(6, Math.floor((columns[column] - 10) / (isLongText ? 5.2 : 4.4)));
            const parts = wrap(value, maxChars).slice(0, 2);
            const anchor = column >= (isTax ? 4 : 4) ? "middle" : "start";
            const x = anchor === "middle" ? colX[column] + columns[column] / 2 : colX[column] + 5;
            parts.forEach((part, line) => add(text(x, y + 20 + line * 13, part, isTax ? 6.4 : 7.4, "#26364a", column === 2 ? 600 : 400, anchor)));
        });
    });

    const subtotal = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
    const taxKnown = items.length > 0 && items.every((item) => item.gst_percentage !== null);
    const taxTotal = taxKnown ? items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0) * Number(item.gst_percentage || 0) / 100, 0) : null;
    const invoiceTotal = taxTotal === null ? subtotal : subtotal + taxTotal;
    const summaryTop = rowsTop + Math.max(1, visibleItems.length) * rowHeight + 18;
    const summaryX = 420;
    if (!isCopyFinalPage) {
        add(text(left, summaryTop, "Continued on the next page", 8, "#64748b"));
    } else if (isTax) {
        add(text(summaryX, summaryTop, "Taxable amount", 9));
        add(text(right, summaryTop, money(subtotal), 9, "#1f2937", 400, "end"));
        if (taxKnown) {
            const buyerState = String(order.state || "").trim().toLowerCase();
            const sellerState = String(order.vendor_state || "").trim().toLowerCase();
            const sameState = Boolean(buyerState && sellerState && buyerState === sellerState);
            if (sameState) {
                add(text(summaryX, summaryTop + 20, "CGST", 8.5));
                add(text(right, summaryTop + 20, money(Number(taxTotal) / 2), 8.5, "#1f2937", 400, "end"));
                add(text(summaryX, summaryTop + 38, "SGST", 8.5));
                add(text(right, summaryTop + 38, money(Number(taxTotal) / 2), 8.5, "#1f2937", 400, "end"));
            } else if (buyerState && sellerState) {
                add(text(summaryX, summaryTop + 20, "IGST", 8.5));
                add(text(right, summaryTop + 20, money(Number(taxTotal)), 8.5, "#1f2937", 400, "end"));
            } else {
                add(text(summaryX, summaryTop + 20, "GST", 8.5));
                add(text(right, summaryTop + 20, money(Number(taxTotal)), 8.5, "#1f2937", 400, "end"));
            }
        } else add(text(summaryX, summaryTop + 20, "Tax breakdown unavailable for this order", 8, "#9a3412"));
        const hasSameState = Boolean(order.state && order.vendor_state && String(order.state).trim().toLowerCase() === String(order.vendor_state).trim().toLowerCase());
        const totalY = summaryTop + (taxKnown && hasSameState ? 62 : 44);
        add(`<rect x="${summaryX - 8}" y="${totalY - 14}" width="${right - summaryX + 8}" height="31" fill="#e9eef5" stroke="#9ba8b8"/>`);
        add(text(summaryX, totalY + 6, "INVOICE TOTAL", 10, "#173c7a", 700));
        add(text(right - 6, totalY + 6, money(invoiceTotal), 11, "#173c7a", 700, "end"));
        add(paragraph(left, totalY + 43, `Amount in words: ${amountInWords(invoiceTotal)}`, 104, 8.5, 13));
        add(paragraph(left, totalY + 75, "Declaration: This invoice reflects the order details and tax rates recorded for this order.", 104, 8, 12, "#475569"));
        add(text(right, 1021, `For ${order.vendor_name || "Vendor"}`, 8.5, "#1f2937", 600, "end"));
        add(text(right, 1040, "Authorised Signatory", 8, "#64748b", 400, "end"));
    } else {
        add(text(summaryX, summaryTop, "Goods value", 9, "#1f2937", 600));
        add(text(right, summaryTop, money(subtotal), 10, "#1f2937", 700, "end"));
        add(text(left, summaryTop + 38, "Goods received in good condition", 8.5, "#475569"));
        add(text(right, summaryTop + 38, "Receiver's name / signature", 8.5, "#475569", 400, "end"));
    }
    add(`<line x1="${left}" y1="1065" x2="${right}" y2="1065" stroke="#cbd5e1" stroke-width="1"/>`);
    add(text(left, 1083, "MTWO GROUPS  |  Computer-generated document", 7.5, "#64748b"));
    add(text(right, 1083, `Page ${pageNumber} of ${pageCount}`, 7.5, "#64748b", 400, "end"));
    add("</svg>");
    return chunks.join("");
}

export async function buildInvoicePDFBufferFromData(
    order: InvoiceDocumentData,
    items: InvoiceDocumentItem[],
    documentType: InvoiceDocumentType,
    logoDataUri: string,
): Promise<Buffer> {
    const PdfPrinter = (await import("pdfmake/js/Printer.js" as any)).default;
    const virtualFs = (await import("pdfmake/js/virtual-fs.js" as any)).default;
    const URLResolver = (await import("pdfmake/js/URLResolver.js" as any)).default;
    const printer = new PdfPrinter({ Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-Bold" } }, virtualFs, new URLResolver(virtualFs));
    const chunks: InvoiceDocumentItem[][] = [];
    const pageSize = 6;
    for (let index = 0; index < items.length; index += pageSize) chunks.push(items.slice(index, index + pageSize));
    if (!chunks.length) chunks.push([]);
    const copies = documentType === "challan"
        ? ["ORIGINAL FOR RECIPIENT", "DUPLICATE FOR TRANSPORTER"]
        : ["TAX INVOICE"];
    const totalPages = chunks.length * copies.length;
    const content: any[] = [];
    let pageNumber = 1;
    for (const copy of copies) {
        for (const pageItems of chunks) {
            const svg = buildInvoicePageSvg(order, pageItems, documentType, logoDataUri, copy, pageNumber, totalPages, pageItems === chunks[chunks.length - 1]);
            content.push({ svg, width: 527, height: 745, alignment: "center", margin: [0, 0, 0, 0], ...(pageNumber > 1 ? { pageBreak: "before" } : {}) });
            pageNumber += 1;
        }
    }
    const pdfDoc = await printer.createPdfKitDocument({ pageSize: "A4", pageMargins: [34, 24, 34, 24], content, defaultStyle: { font: "Helvetica" } });
    return new Promise<Buffer>((resolve, reject) => {
        const output: Buffer[] = [];
        pdfDoc.on("data", (chunk: Buffer) => output.push(chunk));
        pdfDoc.on("end", () => resolve(Buffer.concat(output)));
        pdfDoc.on("error", reject);
        pdfDoc.end();
    });
}

export async function generateInvoicePDFBuffer(orderId: string, documentType: InvoiceDocumentType = "tax-invoice"): Promise<Buffer> {
    const orderQ = await pool.query(
        `SELECT o.id, o.order_reference, o.customer_name, o.customer_email, o.customer_phone, o.payment_status,
                o.address_line, o.city, o.state, o.country, o.pincode, o.total_amount,
                o.pickup_qr_token, o.created_at, v.company_name AS vendor_name,
                v.phone AS vendor_phone, v.gst_number AS vendor_gst_number,
                va.address AS vendor_address, va.city AS vendor_city,
                va.state AS vendor_state, va.pincode AS vendor_pincode
         FROM orders o
         JOIN vendors v ON o.vendor_id = v.id
         LEFT JOIN LATERAL (
           SELECT address, city, state, pincode FROM addresses
           WHERE user_id = v.user_id ORDER BY created_at DESC LIMIT 1
         ) va ON TRUE
         WHERE o.id = $1`, [orderId],
    );
    if (!orderQ.rows.length) throw new Error("Order not found");
    const itemsQ = await pool.query(
        `SELECT oi.quantity, oi.price, oi.gst_percentage, p.name AS product_name, pv.name AS variant_name, p.item_code, p.unit
         FROM order_items oi JOIN products p ON oi.product_id = p.id
         LEFT JOIN product_variants pv ON oi.product_variant_id = pv.id
         WHERE oi.order_id = $1 ORDER BY oi.created_at`, [orderId],
    );
    let logoDataUri = "";
    try {
        const logoPath = path.join(process.cwd(), "assets", "mtwo-logo.jpeg");
        const logo = await readFile(logoPath);
        logoDataUri = `data:image/jpeg;base64,${logo.toString("base64")}`;
    } catch (error) {
        console.warn("MTWO invoice logo could not be loaded:", error);
    }
    return buildInvoicePDFBufferFromData(
        orderQ.rows[0] as InvoiceDocumentData,
        itemsQ.rows as InvoiceDocumentItem[],
        documentType,
        logoDataUri,
    );
}

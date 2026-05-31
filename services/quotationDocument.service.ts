// pdfmake is used for PDF generation
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
    const formatted = new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
    return `Rs. ${formatted}`;
}

// Cache for Logo Base64
let logoBase64 = "";
async function getLogoBase64(): Promise<string> {
    if (logoBase64) return logoBase64;
    try {
        const response = await fetch(COMPANY_LOGO_URL);
        const arrayBuffer = await response.arrayBuffer();
        logoBase64 = `data:image/jpeg;base64,${Buffer.from(arrayBuffer).toString("base64")}`;
        return logoBase64;
    } catch (err) {
        console.error("Failed to fetch company logo:", err);
        return "";
    }
}

// ─── Generate PDF using pdfmake ───────────────────────────────────────
export async function generatePDFBuffer(data: QuotationDocumentData): Promise<Buffer> {
    const PdfPrinter = (await import("pdfmake/js/Printer" as any)).default;
    const virtualFs = (await import("pdfmake/js/virtual-fs" as any)).default;
    const URLResolver = (await import("pdfmake/js/URLResolver" as any)).default;
    const urlResolver = new URLResolver(virtualFs);
    const fonts = {
        Helvetica: {
            normal: "Helvetica",
            bold: "Helvetica-Bold",
            italics: "Helvetica-Oblique",
            bolditalics: "Helvetica-BoldOblique",
        },
    };
    const printer = new PdfPrinter(fonts, virtualFs, urlResolver);

    const isVendorVersion = Boolean(data.vendorName);
    const subtotal = data.vendorOfferPrice
        ? data.vendorOfferPrice * (data.vendorOfferQuantity || data.product.quantity)
        : data.product.unitPrice * data.product.quantity;
    const gstAmount = (subtotal * GST_RATE) / 100;
    const total = subtotal + gstAmount;
    const tokenAmount = data.tokenPercentage ? (data.tokenPercentage / 100) * total : null;

    const qty = data.vendorOfferQuantity || data.product.quantity;
    const price = data.vendorOfferPrice || data.product.unitPrice;

    const logo = await getLogoBase64();

    const tableBody: any[] = [];
    if (isVendorVersion) {
        tableBody.push([
            { text: "Description", style: "tableHeader" },
            { text: "Quantity", style: "tableHeader", alignment: "center" },
            { text: "Unit Price", style: "tableHeader", alignment: "right" },
            { text: "Total", style: "tableHeader", alignment: "right" }
        ]);
    } else {
        tableBody.push([
            { text: "Description", style: "tableHeader" },
            { text: "Quantity", style: "tableHeader", alignment: "center" }
        ]);
    }

    const descStack: any[] = [
        { text: data.product.name, bold: true, fontSize: 10, color: "#1f2937" }
    ];
    if (data.product.category) {
        descStack.push({
            margin: [0, 4, 0, 2],
            table: {
                widths: ["auto"],
                body: [
                    [
                        {
                            text: data.product.category.toUpperCase(),
                            fontSize: 7.5,
                            bold: true,
                            color: "#166534",
                            margin: [6, 2, 6, 2]
                        }
                    ]
                ]
            },
            layout: {
                hLineWidth: function () { return 0; },
                vLineWidth: function () { return 0; },
                hLineColor: function () { return "transparent"; },
                vLineColor: function () { return "transparent"; },
                paddingLeft: function() { return 0; },
                paddingRight: function() { return 0; },
                paddingTop: function() { return 0; },
                paddingBottom: function() { return 0; },
                fillColor: function () { return "#dcfce7"; }
            }
        });
    }
    if (data.product.description) {
        descStack.push({ text: data.product.description.substring(0, 120), fontSize: 8, color: "#6b7280", margin: [0, 4, 0, 0] });
    }

    if (isVendorVersion) {
        tableBody.push([
            { stack: descStack, style: "tableCell" },
            { text: qty.toLocaleString("en-IN"), style: "tableCell", alignment: "center" },
            { text: formatINR(price), style: "tableCell", alignment: "right" },
            { text: formatINR(price * qty), style: "tableCell", alignment: "right", bold: true }
        ]);
    } else {
        tableBody.push([
            { stack: descStack, style: "tableCell" },
            { text: qty.toLocaleString("en-IN"), style: "tableCell", alignment: "center" }
        ]);
    }

    if (data.product.specifications) {
        Object.entries(data.product.specifications).forEach(([key, value]) => {
            const specKey = key.replace(/_/g, " ").toUpperCase();
            if (isVendorVersion) {
                tableBody.push([
                    { text: specKey, fontSize: 9, color: "#6b7280", style: "tableCell" },
                    { text: value, colSpan: 3, fontSize: 9, color: "#374151", style: "tableCell" },
                    {},
                    {}
                ]);
            } else {
                tableBody.push([
                    { text: specKey, fontSize: 9, color: "#6b7280", style: "tableCell" },
                    { text: value, fontSize: 9, color: "#374151", style: "tableCell" }
                ]);
            }
        });
    }

    const docDefinition: any = {
        defaultStyle: {
            font: "Helvetica",
            fontSize: 10,
            lineHeight: 1.45,
            color: "#1f2937"
        },
        pageMargins: [50, 50, 50, 50],
        watermark: { text: COMPANY_NAME, color: "#166534", opacity: 0.04, bold: true, angle: -30 },
        content: [
            {
                columns: [
                    {
                        width: "50%",
                        stack: [
                            logo ? { image: logo, width: 45, margin: [0, 0, 0, 5] } : {},
                            { text: COMPANY_NAME, fontSize: 18, bold: true, color: "#166534" },
                            { text: "B2B Industrial Marketplace", fontSize: 8, color: "#6b7280", characterSpacing: 1, margin: [0, 2, 0, 0] }
                        ]
                    },
                    {
                        width: "50%",
                        alignment: "right",
                        stack: [
                            { text: COMPANY_ADDRESS_LINE1, fontSize: 9, bold: true, color: "#1f2937" },
                            { text: COMPANY_ADDRESS_LINE2, fontSize: 9, color: "#4b5563" },
                            { text: `Phone: ${COMPANY_PHONE}`, fontSize: 9, color: "#4b5563" },
                            { text: `Email: ${COMPANY_EMAIL}`, fontSize: 9, color: "#4b5563" },
                            { text: COMPANY_WEBSITE, fontSize: 9, bold: true, color: "#1f2937" }
                        ]
                    }
                ],
                margin: [0, 0, 0, 5]
            },
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 3, lineColor: "#166534" }], margin: [0, 0, 0, 15] },

            { text: "QUOTATION", fontSize: 24, bold: true, color: "#166534", alignment: "center", characterSpacing: 2 },
            { 
                text: isVendorVersion ? `Vendor Offer — ${data.vendorName}` : "Request for Quotation", 
                fontSize: 10, 
                color: "#9ca3af", 
                alignment: "center", 
                margin: [0, 4, 0, 20] 
            },

            {
                table: {
                    widths: ["50%", "50%"],
                    body: [
                        [
                            {
                                stack: [
                                    { text: "QUOTATION INFORMATION", fontSize: 9, bold: true, color: "#166534", margin: [0, 0, 0, 8] },
                                    {
                                        columns: [
                                            { text: "Quotation No.", fontSize: 9, color: "#6b7280", bold: true, width: "40%" },
                                            { text: data.quotationNumber, fontSize: 9, bold: true, width: "60%" }
                                        ],
                                        margin: [0, 2]
                                    },
                                    {
                                        columns: [
                                            { text: "Date", fontSize: 9, color: "#6b7280", width: "40%" },
                                            { text: data.date, fontSize: 9, width: "60%" }
                                        ],
                                        margin: [0, 2]
                                    },
                                    {
                                        columns: [
                                            { text: "Valid Until", fontSize: 9, color: "#6b7280", width: "40%" },
                                            { text: data.validUntil, fontSize: 9, width: "60%" }
                                        ],
                                        margin: [0, 2]
                                    }
                                ],
                                fillColor: "#f9fafb",
                                margin: [10, 10, 10, 10]
                            },
                            {
                                stack: [
                                    { text: "CLIENT DETAILS", fontSize: 9, bold: true, color: "#166534", margin: [0, 0, 0, 8] },
                                    {
                                        columns: [
                                            { text: "Client ID", fontSize: 9, color: "#6b7280", bold: true, width: "40%" },
                                            { text: data.clientId, fontSize: 9, bold: true, width: "60%" }
                                        ],
                                        margin: [0, 2]
                                    },
                                    {
                                        columns: [
                                            { text: "Location", fontSize: 9, color: "#6b7280", width: "40%" },
                                            { text: `${data.clientCity}, ${data.clientState}`, fontSize: 9, width: "60%" }
                                        ],
                                        margin: [0, 2]
                                    },
                                    {
                                        columns: [
                                            { text: "Pincode", fontSize: 9, color: "#6b7280", width: "40%" },
                                            { text: data.clientPincode, fontSize: 9, width: "60%" }
                                        ],
                                        margin: [0, 2]
                                    }
                                ],
                                fillColor: "#f9fafb",
                                margin: [10, 10, 10, 10]
                            }
                        ]
                    ]
                },
                layout: {
                    hLineWidth: function () { return 1; },
                    vLineWidth: function () { return 1; },
                    hLineColor: function () { return "#e5e7eb"; },
                    vLineColor: function () { return "#e5e7eb"; }
                },
                margin: [0, 0, 0, 20]
            },

            {
                table: {
                    headerRows: 1,
                    widths: isVendorVersion ? ["*", "auto", "auto", "auto"] : ["*", "auto"],
                    body: tableBody
                },
                layout: {
                    hLineWidth: function () { return 1; },
                    vLineWidth: function () { return 1; },
                    hLineColor: function () { return "#e5e7eb"; },
                    vLineColor: function () { return "#e5e7eb"; },
                    paddingLeft: function() { return 12; },
                    paddingRight: function() { return 12; },
                    paddingTop: function() { return 8; },
                    paddingBottom: function() { return 8; }
                },
                margin: [0, 0, 0, 20]
            },

            isVendorVersion ? {
                columns: [
                    { text: "", width: "*" },
                    {
                        width: 250,
                        table: {
                            widths: ["*", "auto"],
                            body: [
                                [
                                    { text: "Subtotal", color: "#6b7280", fontSize: 9 },
                                    { text: formatINR(subtotal), alignment: "right", bold: true, fontSize: 9 }
                                ],
                                [
                                    { text: `GST (${GST_RATE}%)`, color: "#6b7280", fontSize: 9 },
                                    { text: formatINR(gstAmount), alignment: "right", bold: true, fontSize: 9 }
                                ],
                                [
                                    { text: "Total", color: "#166534", bold: true, fontSize: 11 },
                                    { text: formatINR(total), alignment: "right", bold: true, color: "#166534", fontSize: 11 }
                                ],
                                ...(tokenAmount !== null ? [[
                                    { text: `Token Amount (${data.tokenPercentage}%)`, color: "#dc2626", bold: true, fontSize: 9 },
                                    { text: formatINR(tokenAmount), alignment: "right", bold: true, color: "#dc2626", fontSize: 9 }
                                ]] : [])
                            ]
                        },
                        layout: {
                            hLineWidth: function (i: number, node: any) { return (i === 2 || i === 3) ? 1 : 0; },
                            vLineWidth: function () { return 0; },
                            hLineColor: function () { return "#166534"; }
                        },
                        margin: [0, 0, 0, 20]
                    }
                ]
            } : null,

            isVendorVersion ? {
                table: {
                    widths: ["50%", "50%"],
                    body: [
                        [
                            {
                                text: "VENDOR OFFER TERMS",
                                fontSize: 10,
                                bold: true,
                                color: "#1e40af",
                                margin: [12, 8, 12, 8],
                                colSpan: 2,
                                fillColor: "#eff6ff"
                            },
                            {}
                        ],
                        [
                            {
                                stack: [
                                    { text: "OFFERED BY", fontSize: 8, color: "#6b7280", bold: true },
                                    { text: data.vendorName || "", fontSize: 12, bold: true, color: "#1e40af", margin: [0, 3, 0, 0] }
                                ],
                                fillColor: "#ffffff",
                                margin: [12, 10, 12, 10]
                            },
                            {
                                stack: [
                                    { text: "DELIVERY TIMELINE", fontSize: 8, color: "#6b7280", bold: true },
                                    { text: `${data.deliveryDays} Days`, fontSize: 12, bold: true, color: "#1e40af", margin: [0, 3, 0, 0] }
                                ],
                                fillColor: "#ffffff",
                                margin: [12, 10, 12, 10]
                            }
                        ],
                        [
                            {
                                stack: [
                                    { text: "TOKEN MONEY", fontSize: 8, color: "#6b7280", bold: true },
                                    { text: `${data.tokenPercentage}%`, fontSize: 12, bold: true, color: "#1e40af", margin: [0, 3, 0, 0] }
                                ],
                                fillColor: "#ffffff",
                                margin: [12, 10, 12, 10]
                            },
                            {
                                stack: [
                                    { text: "TOKEN AMOUNT", fontSize: 8, color: "#6b7280", bold: true },
                                    { text: formatINR(tokenAmount || 0), fontSize: 12, bold: true, color: "#1e40af", margin: [0, 3, 0, 0] }
                                ],
                                fillColor: "#ffffff",
                                margin: [12, 10, 12, 10]
                            }
                        ]
                    ]
                },
                layout: {
                    hLineWidth: function () { return 1; },
                    vLineWidth: function () { return 1; },
                    hLineColor: function () { return "#bfdbfe"; },
                    vLineColor: function () { return "#bfdbfe"; }
                },
                margin: [0, 0, 0, 20]
            } : null,

            { text: "TERMS & CONDITIONS", fontSize: 11, bold: true, color: "#166534", margin: [0, 0, 0, 4] },
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#166534" }], margin: [0, 0, 0, 10] },
            {
                table: {
                    widths: ["*"],
                    body: [
                        [
                            {
                                ol: [
                                    { text: `Token Money: ${data.tokenPercentage ? `${data.tokenPercentage}% of the total amount (${formatINR(tokenAmount || 0)})` : "A percentage of the total amount"} shall be paid at the time of accepting this quotation as advance token money.`, fontSize: 9, margin: [0, 3] },
                                    { text: `Delivery: ${data.deliveryDays ? `Delivery will be completed within ${data.deliveryDays} business days` : "Delivery timeline will be confirmed by the vendor"} from the date of order confirmation at the buyer's specified address.`, fontSize: 9, margin: [0, 3] },
                                    { text: `Validity: This quotation is valid until ${data.validUntil}. After this date, prices and availability may change.`, fontSize: 9, margin: [0, 3] },
                                    { text: "Pricing: All prices are subject to vendor confirmation. The final agreed price will be binding upon acceptance by both parties.", fontSize: 9, margin: [0, 3] },
                                    { text: "Payment: Full payment (minus token money) is due upon delivery or as per mutually agreed payment terms.", fontSize: 9, margin: [0, 3] },
                                    { text: `Platform: All dealings are facilitated through ${COMPANY_NAME}. Both parties agree to abide by the platform's terms of service.`, fontSize: 9, margin: [0, 3] },
                                    { text: "Disputes: Any disputes arising from this quotation shall be resolved under the jurisdiction of Pune, Maharashtra.", fontSize: 9, margin: [0, 3] }
                                ],
                                fillColor: "#f9fafb",
                                margin: [12, 12, 12, 12]
                            }
                        ]
                    ]
                },
                layout: {
                    hLineWidth: function () { return 1; },
                    vLineWidth: function () { return 1; },
                    hLineColor: function () { return "#e5e7eb"; },
                    vLineColor: function () { return "#e5e7eb"; }
                },
                margin: [0, 0, 0, 20]
            },

            {
                stack: [
                    { text: "PLEASE CONFIRM YOUR ACCEPTANCE OF THIS QUOTE", fontSize: 10, bold: true, color: "#166534", alignment: "center", margin: [0, 15, 0, 15], characterSpacing: 1.5 },
                    {
                        columns: [
                            {
                                width: "45%",
                                alignment: "center",
                                stack: [
                                    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: "#9ca3af" }], margin: [0, 40, 0, 5] },
                                    { text: "Authorized Signature", fontSize: 9, color: "#6b7280" }
                                ]
                            },
                            { text: "", width: "10%" },
                            {
                                width: "45%",
                                alignment: "center",
                                stack: [
                                    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: "#9ca3af" }], margin: [0, 40, 0, 5] },
                                    { text: "Date", fontSize: 9, color: "#6b7280" }
                                ]
                            }
                        ]
                    }
                ],
                margin: [0, 0, 0, 30]
            },

            {
                stack: [
                    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: "#166534" }], margin: [0, 5] },
                    { text: `${COMPANY_NAME} — ${COMPANY_ADDRESS_LINE1}, ${COMPANY_ADDRESS_LINE2} | GSTIN: ${COMPANY_GST}`, fontSize: 8, color: "#9ca3af", alignment: "center" },
                    { text: "This is a computer-generated document. No signature is required for the digital version.", fontSize: 8, color: "#9ca3af", alignment: "center", margin: [0, 2] }
                ]
            }
        ],
        styles: {
            tableHeader: { bold: true, color: "white", fillColor: "#166534", fontSize: 9, margin: [0, 2] },
            tableCell: { fontSize: 9, margin: [0, 2] }
        }
    };

    const pdfDoc = await printer.createPdfKitDocument(docDefinition);
    
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on("data", (chunk: any) => chunks.push(chunk));
        pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
        pdfDoc.on("error", (err: any) => reject(err));
        pdfDoc.end();
    });
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

    const pdfBuffer = await generatePDFBuffer(docData);

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

    const pdfBuffer = await generatePDFBuffer(docData);

    const vendorIdShort = params.vendorId.split("-")[0];
    const s3Key = `quotation-documents/${baseDoc.quotation_number}_vendor_${vendorIdShort}.pdf`;
    const { url } = await uploadBufferToS3(pdfBuffer, s3Key, "application/pdf");

    return { documentUrl: url, s3Key };
}

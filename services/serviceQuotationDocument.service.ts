// pdfmake is used for PDF generation
import pool from "../DbConnect";
import { uploadBufferToS3 } from "./s3.service";

// ─── Company Constants ───────────────────────────────────────────────
const COMPANY_NAME = "MTWO Groups";
const COMPANY_LOGO_URL = "https://res.cloudinary.com/deudvpcgx/image/upload/v1779186769/favicon_somltc.jpg";
const COMPANY_ADDRESS_LINE1 = "Plot No. 42, Bopodi Industrial Estate";
const COMPANY_ADDRESS_LINE2 = "Bopodi, Pune, Maharashtra 411003";
const COMPANY_PHONE = "+91 20 2588 0042";
const COMPANY_EMAIL = "info@mtwo.in";
const COMPANY_WEBSITE = "https://mtwo.in";
const COMPANY_GST = "27AADCM1234F1Z5";
const GST_RATE = 18; // percent
const VALIDITY_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────
export type ServiceQuotationDocumentData = {
    quotationNumber: string;
    date: string;
    validUntil: string;
    clientId: string;
    clientCity: string;
    clientState: string;
    clientPincode: string;
    clientCountry: string;
    service: {
        name: string;
        scopeOfWork: string;
        targetPrice?: number;
    };
    // Vendor-filled fields (only for vendor-specific documents)
    vendorName?: string;
    vendorOfferPrice?: number;
    deliveryDays?: number;
    tokenPercentage?: number;
};

// ─── Generate Quotation Number ───────────────────────────────────────
export async function generateServiceQuotationNumber(): Promise<string> {
    const year = new Date().getFullYear();
    try {
        const result = await pool.query(`SELECT nextval('quotation_number_seq') AS seq`);
        const seq = String(result.rows[0].seq).padStart(5, "0");
        return `SQTN-${year}-${seq}`;
    } catch {
        const seq = String(Math.floor(10000 + Math.random() * 90000));
        return `SQTN-${year}-${seq}`;
    }
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
export async function generateServicePDFBuffer(data: ServiceQuotationDocumentData): Promise<Buffer> {
    const PdfPrinter = (await import("pdfmake/js/Printer.js" as any)).default;
    const virtualFs = (await import("pdfmake/js/virtual-fs.js" as any)).default;
    const URLResolver = (await import("pdfmake/js/URLResolver.js" as any)).default;
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
    const subtotal = data.vendorOfferPrice || data.service.targetPrice || 0;
    const gstAmount = (subtotal * GST_RATE) / 100;
    const total = subtotal + gstAmount;
    const tokenAmount = data.tokenPercentage ? (data.tokenPercentage / 100) * total : null;

    const logo = await getLogoBase64();

    const tableBody: any[] = [];
    if (isVendorVersion) {
        tableBody.push([
            { text: "Service Description / Scope of Work", style: "tableHeader" },
            { text: "Price", style: "tableHeader", alignment: "right" },
            { text: "Total (excl. GST)", style: "tableHeader", alignment: "right" }
        ]);
    } else {
        tableBody.push([
            { text: "Service Description / Scope of Work", style: "tableHeader" }
        ]);
    }

    const descStack: any[] = [
        { text: data.service.name, bold: true, fontSize: 10, color: "#1f2937" },
        { text: data.service.scopeOfWork, fontSize: 8, color: "#6b7280", margin: [0, 4, 0, 0] }
    ];

    if (isVendorVersion) {
        tableBody.push([
            { stack: descStack, style: "tableCell" },
            { text: formatINR(subtotal), style: "tableCell", alignment: "right" },
            { text: formatINR(subtotal), style: "tableCell", alignment: "right", bold: true }
        ]);
    } else {
        tableBody.push([
            { stack: descStack, style: "tableCell" }
        ]);
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

            { text: "SERVICE QUOTATION", fontSize: 24, bold: true, color: "#166534", alignment: "center", characterSpacing: 2 },
            {
                text: isVendorVersion ? `Vendor Service Proposal — ${data.vendorName}` : "Request for Service Quotation",
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
                    widths: isVendorVersion ? ["*", "auto", "auto"] : ["*"],
                    body: tableBody
                },
                layout: {
                    hLineWidth: function () { return 1; },
                    vLineWidth: function () { return 1; },
                    hLineColor: function () { return "#e5e7eb"; },
                    vLineColor: function () { return "#e5e7eb"; },
                    paddingLeft: function () { return 12; },
                    paddingRight: function () { return 12; },
                    paddingTop: function () { return 8; },
                    paddingBottom: function () { return 8; }
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
                                text: "PROPOSED SERVICE TERMS",
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
                                    { text: "PROPOSED BY", fontSize: 8, color: "#6b7280", bold: true },
                                    { text: data.vendorName || "", fontSize: 12, bold: true, color: "#1e40af", margin: [0, 3, 0, 0] }
                                ],
                                fillColor: "#ffffff",
                                margin: [12, 10, 12, 10]
                            },
                            {
                                stack: [
                                    { text: "COMPLETION TIMELINE", fontSize: 8, color: "#6b7280", bold: true },
                                    { text: `${data.deliveryDays} Days`, fontSize: 12, bold: true, color: "#1e40af", margin: [0, 3, 0, 0] }
                                ],
                                fillColor: "#ffffff",
                                margin: [12, 10, 12, 10]
                            }
                        ],
                        [
                            {
                                stack: [
                                    { text: "TOKEN PERCENTAGE", fontSize: 8, color: "#6b7280", bold: true },
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
                                    { text: `Advance Token: ${data.tokenPercentage ? `${data.tokenPercentage}% of the total amount (${formatINR(tokenAmount || 0)})` : "A percentage of the total amount"} shall be paid upon acceptance of this quotation.`, fontSize: 9, margin: [0, 3] },
                                    { text: `Completion: ${data.deliveryDays ? `Work will be completed within ${data.deliveryDays} business days` : "Service execution timeline will be confirmed by the service provider"} from confirmation date.`, fontSize: 9, margin: [0, 3] },
                                    { text: `Validity: This quotation is valid until ${data.validUntil}.`, fontSize: 9, margin: [0, 3] },
                                    { text: "Scope Modification: Any deviations from the defined Scope of Work may result in updated terms and pricing.", fontSize: 9, margin: [0, 3] },
                                    { text: "Payment Terms: Outstanding balance (excl. token money) is payable upon completion of services.", fontSize: 9, margin: [0, 3] },
                                    { text: `Platform Fee & Conduct: All transactions are processed via ${COMPANY_NAME} platform.`, fontSize: 9, margin: [0, 3] },
                                    { text: "Jurisdiction: Legal disputes will be resolved under the jurisdiction of Pune, Maharashtra.", fontSize: 9, margin: [0, 3] }
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
                    { text: "PLEASE CONFIRM YOUR ACCEPTANCE OF THIS PROPOSAL", fontSize: 10, bold: true, color: "#166534", alignment: "center", margin: [0, 15, 0, 15], characterSpacing: 1.5 },
                    {
                        columns: [
                            {
                                width: "45%",
                                alignment: "center",
                                stack: [
                                    { canvas: [{ type: "line", x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: "#9ca3af" }], margin: [0, 40, 0, 5] },
                                    { text: "Service Provider Signature", fontSize: 9, color: "#6b7280" }
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
                    { text: "This is a computer-generated proposal. No signature is required for the digital version.", fontSize: 8, color: "#9ca3af", alignment: "center", margin: [0, 2] }
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
 * Generate the BASE service quotation document.
 */
export async function generateBaseServiceQuotationDocument(params: {
    serviceQuotationId: string;
    userId: string;
    serviceId: string;
    serviceName: string;
    scopeOfWork: string;
    targetPrice?: number;
    clientCity?: string;
    clientState?: string;
    clientPincode?: string;
    clientCountry?: string;
}): Promise<{ quotationNumber: string; documentUrl: string; s3Key: string; validUntil: string }> {
    const quotationNumber = await generateServiceQuotationNumber();

    const now = new Date();
    const validUntilDate = new Date(now);
    validUntilDate.setDate(validUntilDate.getDate() + VALIDITY_DAYS);

    const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const validUntilStr = validUntilDate.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });

    const clientIdShort = params.userId.split("-")[0].toUpperCase();

    const docData: ServiceQuotationDocumentData = {
        quotationNumber,
        date: dateStr,
        validUntil: validUntilStr,
        clientId: `CUST-${clientIdShort}`,
        clientCity: params.clientCity || "—",
        clientState: params.clientState || "—",
        clientPincode: params.clientPincode || "—",
        clientCountry: params.clientCountry || "India",
        service: {
            name: params.serviceName,
            scopeOfWork: params.scopeOfWork,
            targetPrice: params.targetPrice,
        },
    };

    const pdfBuffer = await generateServicePDFBuffer(docData);

    const s3Key = `service-quotation-documents/${quotationNumber}.pdf`;
    const { url } = await uploadBufferToS3(pdfBuffer, s3Key, "application/pdf");

    // Save to DB
    await pool.query(
        `INSERT INTO service_quotation_documents (service_quotation_id, quotation_number, document_url, s3_key, valid_until)
         VALUES ($1, $2, $3, $4, $5)`,
        [
            params.serviceQuotationId,
            quotationNumber,
            url,
            s3Key,
            validUntilDate.toISOString().split("T")[0],
        ]
    );

    return { quotationNumber, documentUrl: url, s3Key, validUntil: validUntilDate.toISOString().split("T")[0] };
}

/**
 * Generate a VENDOR-SPECIFIC service quotation document.
 */
export async function generateVendorServiceQuotationDocument(params: {
    serviceQuotationId: string;
    vendorId: string;
    vendorName: string;
    offerPrice: number;
    deliveryDays: number;
    tokenPercentage: number;
}): Promise<{ documentUrl: string; s3Key: string }> {
    // Get base document and service data
    const docResult = await pool.query(
        `SELECT sqd.*, sq.scope_of_work, s.name AS service_name, sq.user_id, sq.requested_price,
                a.city AS client_city, a.state AS client_state, a.pincode AS client_pincode, a.country AS client_country
         FROM service_quotation_documents sqd
         JOIN service_quotations sq ON sqd.service_quotation_id = sq.id
         JOIN services s ON sq.service_id = s.id
         LEFT JOIN addresses a ON sq.user_id = a.user_id
         WHERE sqd.service_quotation_id = $1
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [params.serviceQuotationId]
    );

    if (docResult.rows.length === 0) {
        // If no base document exists yet, fallback and throw
        throw new Error("Base service quotation document not found for this request");
    }

    const baseDoc = docResult.rows[0];

    const docData: ServiceQuotationDocumentData = {
        quotationNumber: baseDoc.quotation_number,
        date: new Date(baseDoc.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }),
        validUntil: new Date(baseDoc.valid_until).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }),
        clientId: `CUST-${baseDoc.user_id.split("-")[0].toUpperCase()}`,
        clientCity: baseDoc.client_city || "—",
        clientState: baseDoc.client_state || "—",
        clientPincode: baseDoc.client_pincode || "—",
        clientCountry: baseDoc.client_country || "India",
        service: {
            name: baseDoc.service_name,
            scopeOfWork: baseDoc.scope_of_work,
            targetPrice: baseDoc.requested_price ? Number(baseDoc.requested_price) : undefined,
        },
        vendorName: params.vendorName,
        vendorOfferPrice: params.offerPrice,
        deliveryDays: params.deliveryDays,
        tokenPercentage: params.tokenPercentage,
    };

    const pdfBuffer = await generateServicePDFBuffer(docData);

    const vendorIdShort = params.vendorId.split("-")[0];
    const s3Key = `service-quotation-documents/${baseDoc.quotation_number}_vendor_${vendorIdShort}.pdf`;
    const { url } = await uploadBufferToS3(pdfBuffer, s3Key, "application/pdf");

    return { documentUrl: url, s3Key };
}

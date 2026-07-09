import pool from "../DbConnect";

const COMPANY_NAME = "MTWO Groups";
const COMPANY_PHONE = "+91 20 2588 0042";
const COMPANY_EMAIL = "info@mtwo.in";
const COMPANY_WEBSITE = "https://mtwo.in";
const GST_RATE = 18;

function formatINR(amount: number): string {
    const formatted = new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
    return `Rs. ${formatted}`;
}

export async function generateInvoicePDFBuffer(orderId: string): Promise<Buffer> {
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

    // Fetch order details
    const orderQ = await pool.query(
        `SELECT o.id, o.order_reference, o.customer_name, o.customer_phone,
                o.address_line, o.city, o.state, o.pincode, o.total_amount,
                o.pickup_qr_token, o.pickup_otp, o.created_at,
                v.company_name as vendor_name, v.phone as vendor_phone,
                va.address as vendor_address, va.city as vendor_city, 
                va.state as vendor_state, va.pincode as vendor_pincode
         FROM orders o
         JOIN vendors v ON o.vendor_id = v.id
         LEFT JOIN addresses va ON va.user_id = v.user_id
         WHERE o.id = $1`,
        [orderId]
    );

    if (orderQ.rows.length === 0) {
        throw new Error("Order not found");
    }
    const order = orderQ.rows[0];

    // Fetch order items
    const itemsQ = await pool.query(
        `SELECT oi.quantity, oi.price, p.name as product_name
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1`,
        [orderId]
    );
    const items = itemsQ.rows;

    const invoiceDate = new Date(order.created_at).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });

    // Compute pricing details
    const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);
    const gstAmount = (subtotal * GST_RATE) / 100;
    const total = subtotal + gstAmount;

    // Define table body rows
    const tableBody: any[] = [
        [
            { text: "Item Details", style: "tableHeader" },
            { text: "Qty", style: "tableHeader", alignment: "center" },
            { text: "Unit Price", style: "tableHeader", alignment: "right" },
            { text: "Total", style: "tableHeader", alignment: "right" }
        ]
    ];

    for (const item of items) {
        tableBody.push([
            { text: item.product_name, fontSize: 9 },
            { text: item.quantity.toString(), fontSize: 9, alignment: "center" },
            { text: formatINR(parseFloat(item.price)), fontSize: 9, alignment: "right" },
            { text: formatINR(parseFloat(item.price) * item.quantity), fontSize: 9, alignment: "right" }
        ]);
    }

    const docDefinition = {
        content: [
            // Title & logo columns
            {
                columns: [
                    {
                        text: "DELIVERY CHALLAN & INVOICE",
                        fontSize: 16,
                        bold: true,
                        color: "#d97706"
                    },
                    {
                        text: COMPANY_NAME,
                        fontSize: 12,
                        bold: true,
                        alignment: "right"
                    }
                ]
            },
            {
                columns: [
                    {
                        text: `Order Ref: ${order.order_reference}\nDate: ${invoiceDate}`,
                        fontSize: 9,
                        margin: [0, 5, 0, 15]
                    },
                    {
                        text: `${COMPANY_WEBSITE}\nSupport: ${COMPANY_EMAIL}`,
                        fontSize: 9,
                        alignment: "right",
                        margin: [0, 5, 0, 15]
                    }
                ]
            },
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, strokeColor: "#e2e8f0" }] },

            // Sender and Receiver Columns
            {
                margin: [0, 15, 0, 15],
                columns: [
                    {
                        width: "50%",
                        stack: [
                            { text: "SHIPPED FROM (VENDOR)", style: "sectionHeading" },
                            { text: order.vendor_name, bold: true, fontSize: 10, margin: [0, 2, 0, 2] },
                            { text: `${order.vendor_address || ""}\n${order.vendor_city || ""}, ${order.vendor_state || ""} - ${order.vendor_pincode || ""}`, fontSize: 9 },
                            { text: `Phone: ${order.vendor_phone || "N/A"}`, fontSize: 9, margin: [0, 4, 0, 0] }
                        ]
                    },
                    {
                        width: "50%",
                        stack: [
                            { text: "DELIVER TO (CUSTOMER)", style: "sectionHeading" },
                            { text: order.customer_name, bold: true, fontSize: 10, margin: [0, 2, 0, 2] },
                            { text: `${order.address_line || ""}\n${order.city || ""}, ${order.state || ""} - ${order.pincode || ""}`, fontSize: 9 },
                            { text: `Phone: ${order.customer_phone || "N/A"}`, fontSize: 9, margin: [0, 4, 0, 0] }
                        ]
                    }
                ]
            },

            // Items Table
            { text: "ORDERED ITEMS", style: "sectionHeading", margin: [0, 5, 0, 5] },
            {
                table: {
                    headerRows: 1,
                    widths: ["*", "10%", "20%", "20%"],
                    body: tableBody
                },
                layout: "lightHorizontalLines",
                margin: [0, 0, 0, 15]
            },

            // Totals
            {
                columns: [
                    { width: "*", text: "" },
                    {
                        width: "50%",
                        table: {
                            widths: ["50%", "50%"],
                            body: [
                                [
                                    { text: "Subtotal", fontSize: 9, border: [false, false, false, false] },
                                    { text: formatINR(subtotal), fontSize: 9, alignment: "right", border: [false, false, false, false] }
                                ],
                                [
                                    { text: `GST (${GST_RATE}%)`, fontSize: 9, border: [false, false, false, false] },
                                    { text: formatINR(gstAmount), fontSize: 9, alignment: "right", border: [false, false, false, false] }
                                ],
                                [
                                    { text: "Total Amount", bold: true, fontSize: 10, border: [false, true, false, false] },
                                    { text: formatINR(total), bold: true, fontSize: 10, alignment: "right", color: "#d97706", border: [false, true, false, false] }
                                ]
                            ]
                        },
                        margin: [0, 0, 0, 20]
                    }
                ]
            },

            // Verification Section with QR code
            { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, strokeColor: "#e2e8f0" }] },
            {
                margin: [0, 20, 0, 0],
                columns: [
                    {
                        width: "60%",
                        stack: [
                            { text: "LOGISTICS ROUTING INSTRUCTIONS", style: "sectionHeading" },
                            {
                                ul: [
                                    "Attach this document securely to the physical package before handing it over to the rider.",
                                    "Rider must scan the QR code to confirm package collection.",
                                    "If scanning fails, request the secure OTP from the vendor portal for manual verification.",
                                    "Delivery partner will route this package to the designated Fulfillment Center."
                                ],
                                fontSize: 8,
                                color: "#475569",
                                margin: [0, 4, 0, 0]
                            }
                        ]
                    },
                    {
                        width: "40%",
                        alignment: "center",
                        stack: [
                            { text: "SCAN TO VERIFY PICKUP", style: "sectionHeading", alignment: "center", margin: [0, 0, 0, 6] },
                            order.pickup_qr_token
                                ? { qr: order.pickup_qr_token, fit: 80, alignment: "center" }
                                : { text: "No Token Available", fontSize: 9, alignment: "center" }
                        ]
                    }
                ]
            }
        ],
        styles: {
            sectionHeading: {
                fontSize: 9,
                bold: true,
                color: "#475569",
                letterSpacing: 1.1,
                margin: [0, 0, 0, 4]
            },
            tableHeader: {
                bold: true,
                fontSize: 9,
                color: "#1e293b",
                fillColor: "#f8fafc"
            }
        },
        defaultStyle: {
            font: "Helvetica"
        }
    };

    const pdfDoc = await printer.createPdfKitDocument(docDefinition);

    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on("data", (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
        pdfDoc.on("error", (err: any) => reject(err));
        pdfDoc.end();
    });
}

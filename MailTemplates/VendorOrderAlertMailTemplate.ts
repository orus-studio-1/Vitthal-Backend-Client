type VendorOrderItem = {
    productName: string;
    productId: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
};

type VendorOrderAlertPayload = {
    vendorName: string;
    vendorEmail: string;
    orderId: string;
    orderDate: string;
    customerName: string;
    customerEmail: string;
    items: VendorOrderItem[];
    subtotal: number;
    totalAmount: number;
    deliveryAddress?: string;
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatCurrency(value: number): string {
    return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function buildVendorOrderAlertEmailHtml(payload: VendorOrderAlertPayload): string {
    const itemRows = payload.items.map((item) => `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">
                ${escapeHtml(item.productName)}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0; text-align: right;">
                ${item.quantity}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0; text-align: right;">
                ${formatCurrency(item.unitPrice)}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0; text-align: right; font-weight: 600;">
                ${formatCurrency(item.totalPrice)}
            </td>
        </tr>
    `).join('');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>New Order - MTWO Group Vendor</title>
            <style>
                body { margin:0; padding:0; background:#f2f4f8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; color:#0f172a; }
                .preheader { display:none; font-size:1px; color:#f2f4f8; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
                .container { width:100%; background:#f2f4f8; padding:32px 0; }
                .card { width:660px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 18px 44px rgba(15, 23, 42, 0.08); }
                .header { background:#0f172a; padding:28px 32px; color:#ffffff; }
                .brand { display:flex; align-items:center; gap:12px; font-weight:700; font-size:20px; }
                .subtitle { margin:8px 0 0; color:#cbd5f5; font-size:14px; }
                .content { padding:32px; }
                .title { font-size:22px; font-weight:700; margin:0 0 8px 0; }
                .lead { margin:0 0 18px 0; font-size:15px; color:#475569; line-height:1.7; }
                .order-card { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin:16px 0; }
                .table { width:100%; border-collapse:collapse; font-size:14px; }
                .table th { text-align:left; padding:10px 0; border-bottom:1px solid #e2e8f0; color:#475569; font-weight:600; }
                .table td { padding:12px 0; border-bottom:1px solid #eef2f7; }
                .text-right { text-align:right; }
                .summary-row { display:flex; justify-content:space-between; padding:8px 0; color:#334155; }
                .summary-total { font-weight:700; color:#0f172a; font-size:16px; }
                .panel { background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:16px; margin-top:16px; color:#1e3a8a; }
                .cta { display:inline-block; background:#1d4ed8; color:#ffffff; padding:12px 28px; border-radius:10px; text-decoration:none; font-weight:600; }
                .footer { border-top:1px solid #e2e8f0; padding:20px 32px 28px; font-size:12px; color:#64748b; }
                .link { color:#2563eb; text-decoration:none; }
            </style>
        </head>
        <body>
            <div class="preheader">New MTWO Group order ${escapeHtml(payload.orderId)} received.</div>
            <div class="container">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                        <td align="center">
                            <table role="presentation" class="card" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td class="header">
                                        <div class="brand">
                                            <img src="https://res.cloudinary.com/deudvpcgx/image/upload/v1779186769/favicon_somltc.jpg" alt="MTWO Group Logo" style="height:44px; width:44px; border-radius:10px;" />
                                            MTWO Group
                                        </div>
                                        <div class="subtitle">New order received</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="content">
                                        <h2 class="title">Hi ${escapeHtml(payload.vendorName)},</h2>
                                        <p class="lead">You have a new order to process. Review the details below and confirm it in your vendor dashboard.</p>

                                        <div class="order-card">
                                            <div style="font-size:13px; text-transform:uppercase; letter-spacing:0.12em; color:#64748b;">Order number</div>
                                            <div style="font-size:20px; font-weight:700; margin-top:6px;">${escapeHtml(payload.orderId)}</div>
                                            <div style="font-size:13px; color:#64748b;">Placed on ${new Date(payload.orderDate).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                                        </div>

                                        <table class="table">
                                            <thead>
                                                <tr>
                                                    <th>Product</th>
                                                    <th class="text-right">Qty</th>
                                                    <th class="text-right">Unit Price</th>
                                                    <th class="text-right">Total</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${itemRows}
                                            </tbody>
                                        </table>

                                        <div class="summary-row"><span>Subtotal</span><span>${formatCurrency(payload.subtotal)}</span></div>
                                        <div class="summary-row summary-total"><span>Order total</span><span>${formatCurrency(payload.totalAmount)}</span></div>

                                        <div class="panel" style="background:#f8fafc; border-color:#e2e8f0; color:#334155;">
                                            <strong>Customer</strong><br />
                                            ${escapeHtml(payload.customerName)} · ${escapeHtml(payload.customerEmail)}
                                        </div>

                                        ${payload.deliveryAddress ? `
                                            <div class="panel">
                                                <strong>Delivery address</strong><br />
                                                ${escapeHtml(payload.deliveryAddress)}
                                            </div>
                                        ` : ''}

                                        <div class="panel" style="background:#fff7ed; border-color:#fed7aa; color:#9a3412;">
                                            <strong>Action needed</strong><br />
                                            Confirm the order, verify stock, and update shipment tracking once dispatched.
                                        </div>

                                        <div style="text-align:center; margin-top:22px;">
                                            <a href="https://vendor.mtwo.in/dashboard/orders" class="cta">Open vendor orders</a>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="footer">
                                        Vendor support: <a class="link" href="mailto:support@mtwo.in">support@mtwo.in</a><br />
                                        © ${new Date().getFullYear()} MTWO Group. All rights reserved.<br />
                                        <a class="link" href="https://vendor.mtwo.in/dashboard">Dashboard</a> · <a class="link" href="https://vendor.mtwo.in/dashboard/orders">Orders</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </div>
        </body>
        </html>
    `;
}

export function buildVendorOrderAlertEmailText(payload: VendorOrderAlertPayload): string {
    let text = `
MTWO Group Vendor Portal - New Order Received!

Hi ${payload.vendorName},

You have received a new order on MTWO Group! Please review the order details and process it as soon as possible.

ORDER NUMBER: ${payload.orderId}
Date: ${new Date(payload.orderDate).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}

📦 ORDER ITEMS
=====================================
`;

    payload.items.forEach((item) => {
        text += `
${escapeHtml(item.productName)}
  Quantity: ${item.quantity}
  Unit Price: ${formatCurrency(item.unitPrice)}
  Total: ${formatCurrency(item.totalPrice)}
`;
    });

    text += `
ORDER TOTAL: ${formatCurrency(payload.totalAmount)}

👤 CUSTOMER INFORMATION
Name: ${escapeHtml(payload.customerName)}
Email: ${escapeHtml(payload.customerEmail)}
`;

    if (payload.deliveryAddress) {
        text += `
🚚 DELIVERY ADDRESS
${payload.deliveryAddress}
`;
    }

    text += `
⚡ WHAT YOU NEED TO DO
1. Review the order details carefully
2. Verify item availability and stock
3. Confirm the order in your vendor dashboard
4. Prepare items for shipment
5. Upload tracking information when dispatched

VIEW IN VENDOR DASHBOARD:
https://vendor.mtwo.in/dashboard/orders

💡 Tip:
Confirming orders promptly and maintaining excellent delivery timelines helps improve your seller rating and attract more customers!

Need Help?
If you have any questions about this order or need technical support, please contact our vendor support team at support@mtwo.in

© ${new Date().getFullYear()} MTWO Group. All rights reserved.
    `;

    return text;
}

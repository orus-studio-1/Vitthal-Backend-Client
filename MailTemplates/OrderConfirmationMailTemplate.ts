type OrderItem = {
    productName: string;
    productId: string;
    vendorName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
};

type OrderConfirmationPayload = {
    userName: string;
    userEmail: string;
    orderId: string;
    orderDate: string;
    items: OrderItem[];
    subtotal: number;
    taxAmount?: number;
    shippingCost?: number;
    totalAmount: number;
    deliveryAddress?: string;
    estimatedDelivery?: string;
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

export function buildOrderConfirmationEmailHtml(payload: OrderConfirmationPayload): string {
    const itemRows = payload.items.map((item) => `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0;">
                ${escapeHtml(item.productName)}
            </td>
            <td style="padding: 12px; border-bottom: 1px solid #e0e0e0; text-align: center;">
                ${escapeHtml(item.vendorName)}
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
            <title>Order Confirmation - MTWO Group</title>
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
                .order-card { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin:16px 0 24px; }
                .order-meta { font-size:13px; color:#64748b; }
                .table { width:100%; border-collapse:collapse; font-size:14px; }
                .table th { text-align:left; padding:10px 0; border-bottom:1px solid #e2e8f0; color:#475569; font-weight:600; }
                .table td { padding:12px 0; border-bottom:1px solid #eef2f7; }
                .text-right { text-align:right; }
                .summary { margin-top:16px; }
                .summary-row { display:flex; justify-content:space-between; padding:8px 0; color:#334155; }
                .summary-total { font-weight:700; color:#0f172a; font-size:16px; }
                .panel { background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:16px; margin-top:18px; color:#1e3a8a; }
                .cta { display:inline-block; background:#1d4ed8; color:#ffffff; padding:12px 28px; border-radius:10px; text-decoration:none; font-weight:600; }
                .footer { border-top:1px solid #e2e8f0; padding:20px 32px 28px; font-size:12px; color:#64748b; }
                .link { color:#2563eb; text-decoration:none; }
            </style>
        </head>
        <body>
            <div class="preheader">Your MTWO Group order ${escapeHtml(payload.orderId)} is confirmed.</div>
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
                                        <div class="subtitle">Order confirmed</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="content">
                                        <h2 class="title">Thanks for your order, ${escapeHtml(payload.userName)}.</h2>
                                        <p class="lead">We have received your order and it is now being prepared. You can track updates from your MTWO Group account.</p>

                                        <div class="order-card">
                                            <div style="font-size:13px; text-transform:uppercase; letter-spacing:0.12em; color:#64748b;">Order number</div>
                                            <div style="font-size:20px; font-weight:700; margin-top:6px;">${escapeHtml(payload.orderId)}</div>
                                            <div class="order-meta">Placed on ${new Date(payload.orderDate).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                                        </div>

                                        <div style="font-weight:600; margin-bottom:10px;">Order items</div>
                                        <table class="table">
                                            <thead>
                                                <tr>
                                                    <th>Product</th>
                                                    <th>Vendor</th>
                                                    <th class="text-right">Qty</th>
                                                    <th class="text-right">Unit Price</th>
                                                    <th class="text-right">Total</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${itemRows}
                                            </tbody>
                                        </table>

                                        <div class="summary">
                                            <div class="summary-row"><span>Subtotal</span><span>${formatCurrency(payload.subtotal)}</span></div>
                                            ${payload.taxAmount ? `<div class="summary-row"><span>Tax (GST)</span><span>${formatCurrency(payload.taxAmount)}</span></div>` : ''}
                                            ${payload.shippingCost ? `<div class="summary-row"><span>Shipping</span><span>${formatCurrency(payload.shippingCost)}</span></div>` : ''}
                                            <div class="summary-row summary-total"><span>Total</span><span>${formatCurrency(payload.totalAmount)}</span></div>
                                        </div>

                                        ${payload.deliveryAddress || payload.estimatedDelivery ? `
                                            <div class="panel">
                                                <strong>Delivery information</strong><br />
                                                ${payload.deliveryAddress ? `${escapeHtml(payload.deliveryAddress)}<br />` : ''}
                                                ${payload.estimatedDelivery ? `Estimated delivery: ${payload.estimatedDelivery}` : ''}
                                            </div>
                                        ` : ''}

                                        <div class="panel" style="background:#f8fafc; border-color:#e2e8f0; color:#334155;">
                                            <strong>What happens next?</strong><br />
                                            Your order is routed to vendors, tracking details will follow within 24 hours, and you can monitor progress in your account.
                                        </div>

                                        <div style="text-align:center; margin-top:22px;">
                                            <a href="https://mtwo.in/orders" class="cta">Track your order</a>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="footer">
                                        Need help? Contact <a class="link" href="mailto:support@mtwo.in">support@mtwo.in</a><br />
                                        © ${new Date().getFullYear()} MTWO Group. All rights reserved.<br />
                                        <a class="link" href="https://mtwo.in">Website</a> · <a class="link" href="https://mtwo.in/orders">My Orders</a>
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

export function buildOrderConfirmationEmailText(payload: OrderConfirmationPayload): string {
    let text = `
MTWO Group Marketplace - Order Confirmation

Hi ${payload.userName},

Thank you for your order! We're thrilled to have your business. Your order has been confirmed and is being prepared for shipment.

ORDER NUMBER: ${payload.orderId}
Date: ${new Date(payload.orderDate).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}

📦 ORDER ITEMS
=====================================
`;

    payload.items.forEach((item) => {
        text += `
${escapeHtml(item.productName)}
  Vendor: ${escapeHtml(item.vendorName)}
  Quantity: ${item.quantity}
  Unit Price: ${formatCurrency(item.unitPrice)}
  Total: ${formatCurrency(item.totalPrice)}
`;
    });

    text += `
PRICE SUMMARY
=====================================
Subtotal: ${formatCurrency(payload.subtotal)}
${payload.taxAmount ? `Tax (GST): ${formatCurrency(payload.taxAmount)}\n` : ''}${payload.shippingCost ? `Shipping: ${formatCurrency(payload.shippingCost)}\n` : ''}
TOTAL AMOUNT: ${formatCurrency(payload.totalAmount)}
`;

    if (payload.deliveryAddress || payload.estimatedDelivery) {
        text += `
🚚 DELIVERY INFORMATION
`;
        if (payload.deliveryAddress) {
            text += `\nDelivery Address:
${payload.deliveryAddress}
`;
        }
        if (payload.estimatedDelivery) {
            text += `\nEstimated Delivery: ${payload.estimatedDelivery}\n`;
        }
    }

    text += `
📋 WHAT'S NEXT?
1. Your order is being processed by our vendors
2. You'll receive tracking information via email within 24 hours
3. Your order will be dispatched as per delivery timeline
4. Track your order anytime from your MTWO Group account

TRACK YOUR ORDER:
https://mtwo.in/orders

Questions or Issues?
If you have any questions about your order or need assistance, please contact our customer support team at support@mtwo.in

© ${new Date().getFullYear()} MTWO Group. All rights reserved.
    `;

    return text;
}

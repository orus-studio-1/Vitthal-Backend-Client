type AbandonedReminderItem = {
    sourceType: "cart" | "wishlist";
    productName: string;
    productId: string;
    vendorName?: string | null;
    price?: number | null;
    moq?: number | null;
    quantity?: number | null;
    imageUrl?: string | null;
};

type AbandonedReminderPayload = {
    userName: string;
    userEmail: string;
    items: AbandonedReminderItem[];
    cartValue?: number;
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatCurrency(value?: number | null): string {
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
        return "Contact supplier";
    }
    return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function sourceLabel(sourceType: "cart" | "wishlist"): string {
    return sourceType === "cart" ? "🛒 Cart" : "❤️ Wishlist";
}

export function buildAbandonedReminderEmailHtml(payload: AbandonedReminderPayload): string {
    const cartItems = payload.items.filter(item => item.sourceType === "cart");
    const wishlistItems = payload.items.filter(item => item.sourceType === "wishlist");

    const itemRows = payload.items.map((item) => `
        <tr>
            <td style="padding: 20px; border-bottom: 1px solid #e0e0e0;">
                <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
                    <tr>
                        <td style="vertical-align: top; width: 100px; padding-right: 15px;">
                            ${item.imageUrl ? `
                                <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.productName)}" 
                                     style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px; display: block;" />
                            ` : `
                                <div style="width: 100px; height: 100px; background-color: #f0f0f0; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #ccc;">
                                    No Image
                                </div>
                            `}
                        </td>
                        <td style="vertical-align: top;">
                            <div style="font-size: 16px; font-weight: 600; color: #333; margin-bottom: 8px;">
                                ${escapeHtml(item.productName)}
                            </div>
                            <div style="font-size: 13px; color: #666; margin-bottom: 6px;">
                                <strong>Vendor:</strong> ${item.vendorName ? escapeHtml(item.vendorName) : "N/A"}
                            </div>
                            <div style="font-size: 13px; color: #666; margin-bottom: 6px;">
                                <strong>Price:</strong> ${formatCurrency(item.price)}
                            </div>
                            ${item.moq ? `
                                <div style="font-size: 13px; color: #666; margin-bottom: 6px;">
                                    <strong>MOQ:</strong> ${item.moq} units
                                </div>
                            ` : ''}
                            ${item.quantity && item.sourceType === "cart" ? `
                                <div style="font-size: 13px; color: #666;">
                                    <strong>Quantity in ${sourceLabel(item.sourceType)}:</strong> ${item.quantity}
                                </div>
                            ` : ''}
                            <div style="font-size: 12px; color: #999; margin-top: 8px;">
                                ${sourceLabel(item.sourceType)}
                            </div>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    `).join('');

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Don't Miss Out - MTWO Group</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    background-color: #eef2f7;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                    color: #0f172a;
                }
                .preheader {
                    display: none;
                    font-size: 1px;
                    color: #eef2f7;
                    line-height: 1px;
                    max-height: 0;
                    max-width: 0;
                    opacity: 0;
                    overflow: hidden;
                }
                .container {
                    width: 100%;
                    padding: 28px 0;
                }
                .card {
                    width: 640px;
                    margin: 0 auto;
                    background-color: #ffffff;
                    border-radius: 18px;
                    overflow: hidden;
                    box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
                }
                .header {
                    background: #0f172a;
                    padding: 30px 32px 26px;
                }
                .brand {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    color: #ffffff;
                    font-weight: 700;
                    font-size: 20px;
                }
                .headline {
                    margin: 18px 0 0;
                    font-size: 22px;
                    font-weight: 700;
                    color: #f8fafc;
                }
                .subhead {
                    margin: 6px 0 0;
                    font-size: 14px;
                    color: #cbd5f5;
                }
                .content {
                    padding: 32px;
                }
                .lead {
                    font-size: 15px;
                    line-height: 1.7;
                    color: #475569;
                    margin: 0 0 24px;
                }
                .section-title {
                    font-size: 16px;
                    font-weight: 700;
                    color: #0f172a;
                    margin: 28px 0 12px;
                }
                .items-table {
                    width: 100%;
                    border-collapse: collapse;
                }
                .items-table td {
                    border-bottom: 1px solid #e2e8f0;
                    padding: 18px 0;
                }
                .card-panel {
                    background-color: #f8fafc;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 16px 18px;
                    margin: 18px 0;
                }
                .summary-row {
                    display: flex;
                    justify-content: space-between;
                    font-size: 14px;
                    color: #0f172a;
                }
                .cta {
                    display: inline-block;
                    background-color: #2563eb;
                    color: #ffffff;
                    text-decoration: none;
                    padding: 12px 28px;
                    border-radius: 999px;
                    font-weight: 600;
                    margin-top: 18px;
                }
                .alert {
                    background-color: #fff7ed;
                    border: 1px solid #fed7aa;
                    border-radius: 12px;
                    padding: 14px 16px;
                    font-size: 13px;
                    color: #9a3412;
                    margin-top: 24px;
                }
                .footer {
                    border-top: 1px solid #e2e8f0;
                    padding: 22px 32px 26px;
                    font-size: 12px;
                    color: #64748b;
                }
                .link {
                    color: #2563eb;
                    text-decoration: none;
                }
            </style>
        </head>
        <body>
            <div class="preheader">Items in your cart and wishlist are waiting for you.</div>
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Items waiting for you - MTWO Group</title>
                <style>
                    body { margin:0; padding:0; background:#f2f4f8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; color:#0f172a; }
                    .preheader { display:none; font-size:1px; color:#f2f4f8; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
                    .container { width:100%; background:#f2f4f8; padding:32px 0; }
                    .card { width:640px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 18px 42px rgba(15, 23, 42, 0.08); }
                    .header { background:#0f172a; padding:28px 32px; color:#ffffff; }
                    .brand { display:flex; align-items:center; gap:12px; font-weight:700; font-size:20px; }
                    .subtitle { margin:8px 0 0; color:#cbd5f5; font-size:14px; }
                    .content { padding:32px; }
                    .title { font-size:22px; font-weight:700; margin:0 0 10px 0; }
                    .lead { margin:0 0 18px 0; font-size:15px; color:#475569; line-height:1.7; }
                    .section { margin-top:24px; }
                    .section-title { font-size:14px; text-transform:uppercase; letter-spacing:0.08em; color:#64748b; margin-bottom:12px; }
                    .card-item { border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:12px; }
                    .pill { display:inline-block; font-size:12px; color:#1d4ed8; background:#eff6ff; padding:4px 10px; border-radius:999px; margin-top:8px; }
                    .cta { display:inline-block; background:#1d4ed8; color:#ffffff; padding:14px 28px; border-radius:10px; text-decoration:none; font-weight:600; }
                    .summary { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-top:16px; }
                    .footer { border-top:1px solid #e2e8f0; padding:20px 32px 28px; font-size:12px; color:#64748b; }
                    .link { color:#2563eb; text-decoration:none; }
                </style>
            </head>
            <body>
                <div class="preheader">Your MTWO Group cart and wishlist items are waiting.</div>
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
                                            <p class="subtitle">Items waiting in your cart & wishlist</p>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td class="content">
                                            <h2 class="title">Complete your purchase</h2>
                                            <p class="lead">Hi <strong>${payload.userName}</strong>, your saved items are still available. Lock in pricing and secure your order now.</p>

                                            ${cartItems.length > 0 ? `
                                                <div class="section">
                                                    <div class="section-title">Cart (${cartItems.length})</div>
                                                    ${cartItems.map((item) => `
                                                        <div class="card-item">
                                                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                                                <tr>
                                                                    <td style="width:96px; padding-right:14px; vertical-align:top;">
                                                                        ${item.imageUrl ? `
                                                                            <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.productName)}" style="width:96px; height:96px; object-fit:cover; border-radius:10px; display:block;" />
                                                                        ` : `
                                                                            <div style="width:96px; height:96px; background:#e2e8f0; border-radius:10px;"></div>
                                                                        `}
                                                                    </td>
                                                                    <td style="vertical-align:top;">
                                                                        <div style="font-size:16px; font-weight:600; margin-bottom:6px;">${escapeHtml(item.productName)}</div>
                                                                        <div style="font-size:13px; color:#64748b;">Vendor: ${item.vendorName ? escapeHtml(item.vendorName) : "N/A"}</div>
                                                                        <div style="font-size:13px; color:#64748b;">Price: ${formatCurrency(item.price)}</div>
                                                                        ${item.moq ? `<div style="font-size:13px; color:#64748b;">MOQ: ${item.moq} units</div>` : ''}
                                                                        ${item.quantity ? `<div style="font-size:13px; color:#64748b;">Quantity: ${item.quantity}</div>` : ''}
                                                                        <span class="pill">In your cart</span>
                                                                    </td>
                                                                </tr>
                                                            </table>
                                                        </div>
                                                    `).join('')}
                                                </div>
                                                ${payload.cartValue ? `
                                                    <div class="summary">
                                                        <strong>Cart total:</strong> ${formatCurrency(payload.cartValue)}
                                                    </div>
                                                ` : ''}
                                            ` : ''}

                                            ${wishlistItems.length > 0 ? `
                                                <div class="section">
                                                    <div class="section-title">Wishlist (${wishlistItems.length})</div>
                                                    ${wishlistItems.map((item) => `
                                                        <div class="card-item">
                                                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                                                                <tr>
                                                                    <td style="width:96px; padding-right:14px; vertical-align:top;">
                                                                        ${item.imageUrl ? `
                                                                            <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.productName)}" style="width:96px; height:96px; object-fit:cover; border-radius:10px; display:block;" />
                                                                        ` : `
                                                                            <div style="width:96px; height:96px; background:#e2e8f0; border-radius:10px;"></div>
                                                                        `}
                                                                    </td>
                                                                    <td style="vertical-align:top;">
                                                                        <div style="font-size:16px; font-weight:600; margin-bottom:6px;">${escapeHtml(item.productName)}</div>
                                                                        <div style="font-size:13px; color:#64748b;">Vendor: ${item.vendorName ? escapeHtml(item.vendorName) : "N/A"}</div>
                                                                        <div style="font-size:13px; color:#64748b;">Price: ${formatCurrency(item.price)}</div>
                                                                        ${item.moq ? `<div style="font-size:13px; color:#64748b;">MOQ: ${item.moq} units</div>` : ''}
                                                                        <span class="pill" style="background:#fdf2f8; color:#be185d;">Wishlist</span>
                                                                    </td>
                                                                </tr>
                                                            </table>
                                                        </div>
                                                    `).join('')}
                                                </div>
                                            ` : ''}

                                            <div class="summary" style="background:#fff7ed; border-color:#fdba74; color:#9a3412;">
                                                <strong>Time-sensitive pricing:</strong> Availability and pricing can change. Complete your order to lock in current terms.
                                            </div>

                                            <div style="text-align:center; margin-top:24px;">
                                                <a href="https://mtwo.in/cart" class="cta">Complete purchase</a>
                                            </div>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td class="footer">
                                            Questions? Contact <a class="link" href="mailto:support@mtwo.in">support@mtwo.in</a><br />
                                            © ${new Date().getFullYear()} MTWO Group. All rights reserved.<br />
                                            <a class="link" href="https://mtwo.in">Website</a> · <a class="link" href="https://mtwo.in/aboutUs">About Us</a>
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

export function buildAbandonedReminderEmailText(payload: AbandonedReminderPayload): string {
    const items = payload.items.map(item => `- ${item.productName} (Price: ${formatCurrency(item.price)})`).join("\n");
    return `Hi ${payload.userName},\n\nYour saved items are still available:\n\n${items}\n\nComplete your purchase here: https://mtwo.in/cart\n\nQuestions? Contact support@mtwo.in\n\n© ${new Date().getFullYear()} MTWO Group. All rights reserved.`;
}

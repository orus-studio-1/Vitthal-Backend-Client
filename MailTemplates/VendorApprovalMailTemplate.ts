type VendorApprovalEmailPayload = {
    vendorName: string;
    vendorEmail: string;
    companyName: string;
    status: "approved" | "rejected";
    approvalNotes?: string;
    applicationNumber?: string;
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function buildVendorApprovalEmailHtml(payload: VendorApprovalEmailPayload): string {
    const isApproved = payload.status === "approved";
    const headerColor = isApproved ? "#10b981" : "#ef4444";
    const accentColor = isApproved ? "#059669" : "#dc2626";
    const bgColor = isApproved ? "#ecfdf5" : "#fef2f2";
    const borderColor = isApproved ? "#d1fae5" : "#fee2e2";
    const statusText = isApproved ? "Approved ✓" : "Rejected ✗";
    const statusIcon = isApproved ? "🎉" : "📋";

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Vendor Application ${statusText}</title>
            <style>
                body { margin:0; padding:0; background:#f2f4f8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; color:#0f172a; }
                .preheader { display:none; font-size:1px; color:#f2f4f8; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
                .container { width:100%; background:#f2f4f8; padding:32px 0; }
                .card { width:620px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 18px 44px rgba(15, 23, 42, 0.08); }
                .header { background:#0f172a; padding:28px 32px; color:#ffffff; }
                .brand { display:flex; align-items:center; gap:12px; font-weight:700; font-size:20px; }
                .subtitle { margin:8px 0 0; color:#cbd5f5; font-size:14px; }
                .content { padding:32px; }
                .title { font-size:22px; font-weight:700; margin:0 0 8px 0; }
                .lead { margin:0 0 18px 0; font-size:15px; color:#475569; line-height:1.7; }
                .status { background:${bgColor}; border:1px solid ${borderColor}; color:#0f172a; border-radius:12px; padding:16px; margin:16px 0; }
                .badge { display:inline-block; background:${accentColor}; color:#ffffff; padding:6px 14px; border-radius:999px; font-size:12px; font-weight:600; }
                .info { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-top:16px; font-size:14px; }
                .cta { display:inline-block; background:${accentColor}; color:#ffffff; padding:12px 26px; border-radius:10px; text-decoration:none; font-weight:600; }
                .panel { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-top:16px; color:#334155; }
                .rejection { background:#fff7ed; border:1px solid #fed7aa; border-radius:12px; padding:16px; margin-top:16px; color:#9a3412; }
                .footer { border-top:1px solid #e2e8f0; padding:20px 32px 28px; font-size:12px; color:#64748b; }
                .link { color:#2563eb; text-decoration:none; }
            </style>
        </head>
        <body>
            <div class="preheader">Your MTWO Group vendor application is ${statusText}.</div>
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
                                        <div class="subtitle">Vendor application update</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="content">
                                        <h2 class="title">Hi ${escapeHtml(payload.vendorName)},</h2>
                                        <p class="lead">Your vendor application has been reviewed. Here is your current status:</p>

                                        <div class="status">
                                            <div class="badge">${statusText}</div>
                                            <p style="margin:12px 0 0; font-size:15px;">
                                                ${isApproved
            ? "Congratulations! Your MTWO Group vendor account is approved and ready to use."
            : "Your MTWO Group vendor application was not approved at this time."}
                                            </p>
                                        </div>

                                        ${isApproved ? `
                                            <div class="panel">
                                                <strong>Next steps</strong><br />
                                                1. Log in to the vendor portal<br />
                                                2. Add products with pricing and images<br />
                                                3. Configure payment and shipping settings
                                            </div>

                                            <div style="text-align:center; margin-top:18px;">
                                                <a href="https://vendor.mtwo.in/dashboard" class="cta">Open vendor dashboard</a>
                                            </div>
                                        ` : `
                                            <div class="rejection">
                                                ${payload.approvalNotes ? `<strong>Feedback:</strong> ${escapeHtml(payload.approvalNotes)}` : "We evaluate vendor applications against compliance and quality benchmarks. You can reapply once updated."}
                                            </div>

                                            <div style="text-align:center; margin-top:18px;">
                                                <a href="mailto:support@mtwo.in?subject=Reapplication%20-%20${encodeURIComponent(payload.companyName)}" class="cta">Contact vendor support</a>
                                            </div>
                                        `}

                                        <div class="info">
                                            <strong>Company</strong>: ${escapeHtml(payload.companyName)}<br />
                                            ${payload.applicationNumber ? `<strong>Application #</strong>: ${escapeHtml(payload.applicationNumber)}` : ''}
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="footer">
                                        Need help? Email <a class="link" href="mailto:support@mtwo.in">support@mtwo.in</a><br />
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

export function buildVendorApprovalEmailText(payload: VendorApprovalEmailPayload): string {
    const isApproved = payload.status === "approved";
    const statusText = isApproved ? "Approved ✓" : "Rejected ✗";
    const statusIcon = isApproved ? "🎉" : "📋";

    let text = `
MTWO Group - Vendor Application ${statusText}

Hi ${payload.vendorName},

${statusIcon} Vendor Application ${statusText}

Company: ${payload.companyName}
${payload.applicationNumber ? `Application #: ${payload.applicationNumber}\n` : ""}

${isApproved
            ? `Thank you for your application! Your MTWO Group vendor account has been approved and is ready to use.

You can now start selling on our B2B marketplace. Here's what you need to do next:

🚀 GETTING STARTED AS A VENDOR
1. Log in to your vendor dashboard at: https://vendor.mtwo.in/login
2. Add your products with descriptions, images, and pricing
3. Set up your payment preferences and banking details
4. Configure shipping settings for your orders
5. Start receiving orders! You'll get notifications for all new orders

ACCESS YOUR VENDOR DASHBOARD:
https://vendor.mtwo.in/dashboard

📚 Resources to Help You:
• Vendor Guidelines: https://mtwo.in/aboutUs
• FAQ & Help Center: https://mtwo.in/aboutUs
• Contact Vendor Support: support@mtwo.in
`
            : `Thank you for applying to become a vendor on MTWO Group. After careful review, your application has not been approved at this time.

${payload.approvalNotes ? `Feedback on Your Application:
${payload.approvalNotes}
` : `We appreciate your interest in joining MTWO Group. We carefully review each application to ensure all vendors meet our quality and compliance standards.
`}

What Next?
If you believe this is an error or would like to reapply, please contact our vendor support team with updated information or clarification. We'd love to work with you!

Contact Vendor Support: support@mtwo.in
`}

Need Help?
For any questions regarding your application status or to discuss your vendor account, please reach out to our vendor support team at support@mtwo.in

© ${new Date().getFullYear()} MTWO Group. All rights reserved.
    `;

    return text;
}

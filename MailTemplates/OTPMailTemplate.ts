type OTPEmailPayload = {
    userName: string;
    userEmail: string;
    otp: string;
    expiryMinutes: number;
};

export function buildOTPEmailHtml(payload: OTPEmailPayload): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verify Your MTWO Group Account</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    background-color: #f2f4f8;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                    color: #0f172a;
                }
                .preheader {
                    display: none;
                    font-size: 1px;
                    color: #f2f4f8;
                    line-height: 1px;
                    max-height: 0;
                    max-width: 0;
                    opacity: 0;
                    overflow: hidden;
                }
                .container {
                    width: 100%;
                    background-color: #f2f4f8;
                    padding: 32px 0;
                }
                .card {
                    width: 600px;
                    margin: 0 auto;
                    background-color: #ffffff;
                    border-radius: 16px;
                    overflow: hidden;
                    box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
                }
                .header {
                    background: #0f172a;
                    padding: 28px 32px 20px;
                    text-align: left;
                }
                .brand {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    color: #ffffff;
                    font-weight: 700;
                    font-size: 20px;
                }
                .subtitle {
                    margin: 8px 0 0;
                    color: #cbd5f5;
                    font-size: 14px;
                }
                .content {
                    padding: 32px;
                }
                .title {
                    font-size: 22px;
                    font-weight: 700;
                    margin: 0 0 8px 0;
                }
                .lead {
                    margin: 0 0 20px 0;
                    font-size: 15px;
                    color: #475569;
                    line-height: 1.7;
                }
                .otp-box {
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 20px;
                    background-color: #f8fafc;
                    text-align: center;
                    margin: 24px 0;
                }
                .otp-label {
                    font-size: 12px;
                    letter-spacing: 0.12em;
                    text-transform: uppercase;
                    color: #64748b;
                    margin-bottom: 8px;
                }
                .otp-code {
                    font-size: 36px;
                    letter-spacing: 10px;
                    color: #0f172a;
                    font-weight: 700;
                    font-family: 'Courier New', monospace;
                }
                .expiry {
                    margin-top: 10px;
                    font-size: 12px;
                    color: #ef4444;
                    font-weight: 600;
                }
                .steps {
                    margin: 0;
                    padding: 0 0 0 18px;
                    color: #334155;
                    font-size: 14px;
                    line-height: 1.7;
                }
                .note {
                    margin-top: 24px;
                    padding: 16px;
                    border-radius: 10px;
                    background-color: #fff7ed;
                    color: #9a3412;
                    font-size: 13px;
                }
                .footer {
                    border-top: 1px solid #e2e8f0;
                    padding: 20px 32px 28px;
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
            <div class="preheader">Your MTWO Group verification code is ${payload.otp}.</div>
            <div class="container">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr>
                        <td align="center">
                            <table role="presentation" class="card" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td class="header">
                                        <div class="brand">
                                            <img src="https://res.cloudinary.com/deudvpcgx/image/upload/v1779186769/favicon_somltc.jpg" alt="MTWO Group Logo" style="height: 44px; width: 44px; border-radius: 10px;" />
                                            MTWO Group
                                        </div>
                                        <p class="subtitle">Secure account verification</p>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="content">
                                        <h2 class="title">Verify your account</h2>
                                        <p class="lead">Hi <strong>${payload.userName}</strong>, use the one-time code below to complete your MTWO Group registration.</p>

                                        <div class="otp-box">
                                            <div class="otp-label">Verification Code</div>
                                            <div class="otp-code">${payload.otp}</div>
                                            <div class="expiry">Code expires in ${payload.expiryMinutes} minutes</div>
                                        </div>

                                        <p class="lead" style="margin-bottom: 10px;">Next steps:</p>
                                        <ol class="steps">
                                            <li>Return to the MTWO Group verification screen.</li>
                                            <li>Enter the 6-digit code above.</li>
                                            <li>Finish setup and start using the marketplace.</li>
                                        </ol>

                                        <div class="note">
                                            <strong>Security tip:</strong> MTWO Group will never ask you for this code. If you did not request it, you can safely ignore this email.
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td class="footer">
                                        Need help? Contact <a class="link" href="mailto:support@mtwo.in">support@mtwo.in</a><br />
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

export function buildOTPEmailText(payload: OTPEmailPayload): string {
    return `
MTWO Group Marketplace

Hi ${payload.userName},

Thank you for signing up with MTWO Group! To complete your account verification, please use the OTP below:

Your Verification Code: ${payload.otp}

⏱️ This code expires in ${payload.expiryMinutes} minutes

How to use this code:
1. Go back to the MTWO Group verification page
2. Enter the 6-digit code above
3. Complete your registration

🔒 Security Notice
Never share this OTP with anyone. MTWO Group staff will never ask for your OTP. If you didn't request this verification, please ignore this email.

Need Help?
If you have any questions or didn't request this code, please contact our support team at support@mtwo.in

© ${new Date().getFullYear()} MTWO Group. All rights reserved.
    `;
}

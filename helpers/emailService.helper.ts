import { sendEmail } from './mailer.helper';
import { buildOTPEmailHtml, buildOTPEmailText } from '../MailTemplates/OTPMailTemplate';
import { buildAbandonedReminderEmailHtml, buildAbandonedReminderEmailText } from '../MailTemplates/AbadonFeatTemplate';
import { buildVendorApprovalEmailHtml, buildVendorApprovalEmailText } from '../MailTemplates/VendorApprovalMailTemplate';
import { buildOrderConfirmationEmailHtml, buildOrderConfirmationEmailText } from '../MailTemplates/OrderConfirmationMailTemplate';
import { buildVendorOrderAlertEmailHtml, buildVendorOrderAlertEmailText } from '../MailTemplates/VendorOrderAlertMailTemplate';
import { buildQuotationRequestEmailHtml, buildQuotationRequestEmailText } from '../MailTemplates/QuotationRequestMailTemplate';
import { buildQuotationUpdateEmailHtml, buildQuotationUpdateEmailText } from '../MailTemplates/QuotationUpdateMailTemplate';

/**
 * Send OTP verification email
 */
export async function sendOTPEmail(
    userName: string,
    userEmail: string,
    otp: string,
    expiryMinutes: number = 10
) {
    const payload = {
        userName,
        userEmail,
        otp,
        expiryMinutes,
    };

    const htmlContent = buildOTPEmailHtml(payload);
    const textContent = buildOTPEmailText(payload);

    return sendEmail({
        to: userEmail,
        subject: `Verify Your MTWO Group Account - OTP: ${otp}`,
        htmlContent,
        textContent,
    });
}

/**
 * Send abandoned cart/wishlist reminder email
 */
export async function sendAbandonedReminderEmail(
    userName: string,
    userEmail: string,
    items: Array<{
        sourceType: 'cart' | 'wishlist';
        productName: string;
        productId: string;
        vendorName?: string | null;
        price?: number | null;
        moq?: number | null;
        quantity?: number | null;
        imageUrl?: string | null;
    }>,
    cartValue?: number
) {
    const payload = {
        userName,
        userEmail,
        items,
        cartValue,
    };

    const htmlContent = buildAbandonedReminderEmailHtml(payload);
    const textContent = buildAbandonedReminderEmailText(payload);

    return sendEmail({
        to: userEmail,
        subject: "🎁 Don't Miss Out - Your Items Are Waiting!",
        htmlContent,
        textContent,
    });
}

/**
 * Send vendor approval/rejection email
 */
export async function sendVendorApprovalEmail(
    vendorName: string,
    vendorEmail: string,
    companyName: string,
    status: 'approved' | 'rejected',
    approvalNotes?: string,
    applicationNumber?: string
) {
    const payload = {
        vendorName,
        vendorEmail,
        companyName,
        status,
        approvalNotes,
        applicationNumber,
    };

    const htmlContent = buildVendorApprovalEmailHtml(payload);
    const textContent = buildVendorApprovalEmailText(payload);

    const subject = status === 'approved'
        ? '🎉 Welcome to MTWO - Your Vendor Account is Approved!'
        : '📋 Update on Your MTWO Vendor Application';

    return sendEmail({
        to: vendorEmail,
        subject,
        htmlContent,
        textContent,
    });
}

/**
 * Send order confirmation email to customer
 */
export async function sendOrderConfirmationEmail(
    userName: string,
    userEmail: string,
    orderId: string,
    orderDate: string,
    items: Array<{
        productName: string;
        productId: string;
        vendorName: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
    }>,
    subtotal: number,
    totalAmount: number,
    taxAmount?: number,
    shippingCost?: number,
    deliveryAddress?: string,
    estimatedDelivery?: string
) {
    const payload = {
        userName,
        userEmail,
        orderId,
        orderDate,
        items,
        subtotal,
        taxAmount,
        shippingCost,
        totalAmount,
        deliveryAddress,
        estimatedDelivery,
    };

    const htmlContent = buildOrderConfirmationEmailHtml(payload);
    const textContent = buildOrderConfirmationEmailText(payload);

    return sendEmail({
        to: userEmail,
        subject: `✓ Order Confirmed - Order #${orderId}`,
        htmlContent,
        textContent,
    });
}

/**
 * Send new order alert email to vendor
 */
export async function sendVendorOrderAlertEmail(
    vendorName: string,
    vendorEmail: string,
    orderId: string,
    orderDate: string,
    customerName: string,
    customerEmail: string,
    items: Array<{
        productName: string;
        productId: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
    }>,
    subtotal: number,
    totalAmount: number,
    deliveryAddress?: string
) {
    const payload = {
        vendorName,
        vendorEmail,
        orderId,
        orderDate,
        customerName,
        customerEmail,
        items,
        subtotal,
        totalAmount,
        deliveryAddress,
    };

    const htmlContent = buildVendorOrderAlertEmailHtml(payload);
    const textContent = buildVendorOrderAlertEmailText(payload);

    return sendEmail({
        to: vendorEmail,
        subject: `🎉 New Order Received - Order #${orderId}`,
        htmlContent,
        textContent,
    });
}

export async function sendQuotationRequestEmail(payload: {
    vendorName: string;
    vendorEmail: string;
    buyerId: string;
    buyerCity?: string | null;
    productName: string;
    quantity: number;
    requestedPrice?: number | null;
    note?: string;
}) {
    const htmlContent = buildQuotationRequestEmailHtml(payload);
    const textContent = buildQuotationRequestEmailText(payload);

    return sendEmail({
        to: payload.vendorEmail,
        subject: `New Quotation Request - ${payload.productName}`,
        htmlContent,
        textContent,
    });
}

export async function sendQuotationUpdateEmail(payload: {
    recipientName: string;
    recipientEmail: string;
    quotationId: string;
    status: string;
    note?: string;
    reason?: string;
}) {
    const htmlContent = buildQuotationUpdateEmailHtml(payload);
    const textContent = buildQuotationUpdateEmailText(payload);

    return sendEmail({
        to: payload.recipientEmail,
        subject: `Quotation Update - ${payload.quotationId}`,
        htmlContent,
        textContent,
    });
}

/**
 * Send public account deletion request email to support/admin
 */
export async function sendPublicAccountDeletionEmail(
    email: string,
    phone: string,
    reason: string
) {
    const supportEmail = process.env.EMAIL_REPLY_TO || 'support@mtwo.in';
    const htmlContent = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #d9534f; border-bottom: 2px solid #d9534f; padding-bottom: 10px;">New Account Deletion Request</h2>
            <p>A user has requested their account to be deleted via the public website form.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr style="background-color: #f9f9f9;">
                    <td style="padding: 10px; font-weight: bold; width: 30%; border: 1px solid #ddd;">Email:</td>
                    <td style="padding: 10px; border: 1px solid #ddd;">\${email}</td>
                </tr>
                <tr>
                    <td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Phone:</td>
                    <td style="padding: 10px; border: 1px solid #ddd;">\${phone}</td>
                </tr>
                <tr style="background-color: #f9f9f9;">
                    <td style="padding: 10px; font-weight: bold; border: 1px solid #ddd;">Reason:</td>
                    <td style="padding: 10px; border: 1px solid #ddd;">\${reason || 'No reason provided'}</td>
                </tr>
            </table>
            <p style="color: #666; font-size: 12px; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">This request was generated from the public website delete account page.</p>
        </div>
    `;

    return sendEmail({
        to: supportEmail,
        subject: `⚠️ Account Deletion Request - \${email}`,
        htmlContent,
    });
}


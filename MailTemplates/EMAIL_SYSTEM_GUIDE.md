# Email System Documentation

## Overview
This email system provides a complete solution for sending templated emails throughout the MTWO application using **nodemailer**. It includes templates for various scenarios and a centralized email service.

## Installation

nodemailer and types are already installed in your dependencies:
```bash
npm install nodemailer
npm install -D @types/nodemailer
```

## Configuration

### Step 1: Set Up Environment Variables

Create or update your `.env` file with email credentials:

```env
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-specific-password
EMAIL_FROM=your-email@gmail.com
EMAIL_REPLY_TO=support@MTWO.com
```

### Step 2: For Gmail Users

1. Enable 2-Factor Authentication on your Google Account
2. Generate an App Password:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and "Windows Computer" (or your device)
   - Copy the generated 16-character password
3. Use this password as `EMAIL_PASSWORD` in your `.env` file

### Step 3: For Other Email Services

Replace `EMAIL_SERVICE` with your provider:
- **Outlook**: `outlook`
- **Yahoo**: `yahoo`
- **Custom SMTP**: Configure `SMTP_HOST`, `SMTP_PORT`, etc.

See [Nodemailer Transport Documentation](https://nodemailer.com/smtp/)

## Email Templates

### 1. **OTP Email** (`OTPMailTemplate.ts`)
Sent when users register or verify their account

**Use Case**: User registration verification
**Parameters**:
- `userName`: User's display name
- `userEmail`: User's email address
- `otp`: 6-digit OTP code
- `expiryMinutes`: OTP expiration time

**Usage**:
```typescript
import { sendOTPEmail } from './helpers/emailService.helper';

await sendOTPEmail('John Doe', 'john@example.com', '123456', 10);
```

### 2. **Abandoned Reminder Email** (`AbadonFeatTemplate.ts`)
Sent to remind users about items in their cart/wishlist

**Use Case**: Cart abandonment reminder (typically sent after 24 hours)
**Parameters**:
- `userName`: User's display name
- `userEmail`: User's email address
- `items`: Array of cart/wishlist items
- `cartValue`: Optional total cart value

**Usage**:
```typescript
import { sendAbandonedReminderEmail } from './helpers/emailService.helper';

const items = [
    {
        sourceType: 'cart',
        productName: 'Steel Coils',
        productId: 'prod-123',
        vendorName: 'Vendor Inc',
        price: 5000,
        moq: 100,
        quantity: 200,
        imageUrl: 'https://...'
    }
];

await sendAbandonedReminderEmail('John Doe', 'john@example.com', items, 10000);
```

### 3. **Vendor Approval Email** (`VendorApprovalMailTemplate.ts`)
Sent when vendor application is approved or rejected

**Use Case**: Vendor registration approval/rejection
**Parameters**:
- `vendorName`: Vendor's name
- `vendorEmail`: Vendor's email
- `companyName`: Company name
- `status`: 'approved' or 'rejected'
- `approvalNotes`: Optional rejection reason
- `applicationNumber`: Optional application reference

**Usage**:
```typescript
import { sendVendorApprovalEmail } from './helpers/emailService.helper';

await sendVendorApprovalEmail(
    'Acme Corp',
    'contact@acmecorp.com',
    'ACME Corporation',
    'approved'
);

// For rejection:
await sendVendorApprovalEmail(
    'XYZ Corp',
    'contact@xyzcorp.com',
    'XYZ Corporation',
    'rejected',
    'GST number could not be verified'
);
```

### 4. **Order Confirmation Email** (`OrderConfirmationMailTemplate.ts`)
Sent to customer after successful order placement

**Use Case**: Order confirmation to customer
**Parameters**:
- `userName`: Customer name
- `userEmail`: Customer email
- `orderId`: Order ID
- `orderDate`: ISO date string
- `items`: Array of order items
- `subtotal`: Order subtotal
- `totalAmount`: Final total including taxes/shipping
- `taxAmount`: Optional tax amount
- `shippingCost`: Optional shipping cost
- `deliveryAddress`: Optional delivery address
- `estimatedDelivery`: Optional delivery timeline

**Usage**:
```typescript
import { sendOrderConfirmationEmail } from './helpers/emailService.helper';

const items = [
    {
        productName: 'Plastic Sheets',
        productId: 'prod-456',
        vendorName: 'Vendor A',
        quantity: 50,
        unitPrice: 500,
        totalPrice: 25000
    }
];

await sendOrderConfirmationEmail(
    'John Doe',
    'john@example.com',
    'ORD-20260519-001',
    new Date().toISOString(),
    items,
    50000,
    50000,
    5000,  // tax
    500    // shipping
);
```

### 5. **Vendor Order Alert Email** (`VendorOrderAlertMailTemplate.ts`)
Sent to vendor when they receive a new order

**Use Case**: New order notification to vendor
**Parameters**:
- `vendorName`: Vendor's name
- `vendorEmail`: Vendor's email
- `orderId`: Order ID
- `orderDate`: ISO date string
- `customerName`: Customer name
- `customerEmail`: Customer email
- `items`: Array of ordered items
- `subtotal`: Order subtotal
- `totalAmount`: Final total
- `deliveryAddress`: Optional delivery address

**Usage**:
```typescript
import { sendVendorOrderAlertEmail } from './helpers/emailService.helper';

const items = [
    {
        productName: 'Steel Coils',
        productId: 'prod-123',
        quantity: 100,
        unitPrice: 5000,
        totalPrice: 500000
    }
];

await sendVendorOrderAlertEmail(
    'Vendor Inc',
    'vendor@example.com',
    'ORD-20260519-001',
    new Date().toISOString(),
    'John Doe',
    'john@example.com',
    items,
    500000,
    500000
);
```

## Helper Functions

### `sendEmail(payload)`
Low-level function to send any email

```typescript
import { sendEmail } from './helpers/mailer.helper';

await sendEmail({
    to: 'recipient@example.com',
    subject: 'Email Subject',
    htmlContent: '<h1>Email Body</h1>',
    textContent: 'Email Body'
});
```

### `sendEmailBatch(payloads, delayMs)`
Send multiple emails with rate limiting (100ms delay by default)

```typescript
import { sendEmailBatch } from './helpers/mailer.helper';

const emails = [
    { to: 'user1@example.com', subject: 'Hello 1', htmlContent: '...' },
    { to: 'user2@example.com', subject: 'Hello 2', htmlContent: '...' }
];

const results = await sendEmailBatch(emails, 200); // 200ms delay
```

### `verifyEmailConfiguration()`
Check if email service is properly configured

```typescript
import { verifyEmailConfiguration } from './helpers/mailer.helper';

const isConfigured = await verifyEmailConfiguration();
if (!isConfigured) {
    console.error('Email service not properly configured');
}
```

## Integration Examples

### In Auth Controller (OTP Verification)
```typescript
// After generating OTP
await sendOTPEmail(
    user.name,
    user.email,
    plainOTP,
    10 // expires in 10 minutes
);
```

### In Abandoned Reminder Job
```typescript
// In abandonedReminder.job.ts
import { sendAbandonedReminderEmail } from '../helpers/emailService.helper';

// After fetching abandoned items
await sendAbandonedReminderEmail(
    user.user_name,
    user.user_email,
    items,
    cartValue
);
```

### In Vendor Controller (Approval)
```typescript
import { sendVendorApprovalEmail } from '../helpers/emailService.helper';

// After approving vendor
await sendVendorApprovalEmail(
    user.name,
    user.email,
    vendor.company_name,
    'approved',
    undefined,
    vendor.application_number
);
```

### In Order Controller (Order Placed)
```typescript
import { 
    sendOrderConfirmationEmail,
    sendVendorOrderAlertEmail 
} from '../helpers/emailService.helper';

// Send to customer
await sendOrderConfirmationEmail(
    customer.name,
    customer.email,
    order.id,
    order.created_at,
    items,
    subtotal,
    totalAmount
);

// Send to vendor for each vendor's items
for (const vendorId in itemsByVendor) {
    const vendor = vendors[vendorId];
    await sendVendorOrderAlertEmail(
        vendor.company_name,
        vendor.user.email,
        order.id,
        order.created_at,
        customer.name,
        customer.email,
        itemsByVendor[vendorId],
        vendorSubtotal,
        vendorTotal
    );
}
```

## Testing

### Test with Ethereal Email
Ethereal provides free testing email accounts:

```env
EMAIL_SERVICE=ethereal
EMAIL_USER=test@ethereal.email
EMAIL_PASSWORD=ethereal-password
```

```typescript
import { verifyEmailConfiguration } from './helpers/mailer.helper';

await verifyEmailConfiguration(); // Returns true if configured
```

### Verify Before Deployment
```typescript
import { verifyEmailConfiguration } from './helpers/mailer.helper';

// In your app startup
const isEmailConfigured = await verifyEmailConfiguration();
if (!isEmailConfigured) {
    console.warn('⚠️ Email service not configured. Emails will not be sent.');
}
```

## Error Handling

All email functions return an `EmailResult` object:

```typescript
interface EmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

// Usage
const result = await sendOTPEmail('John', 'john@example.com', '123456');
if (!result.success) {
    console.error(`Failed to send email: ${result.error}`);
} 
```

## Customization

### Modifying Templates
Each template file exports two functions:
- `buildXxxEmailHtml()` - Returns HTML content
- `buildXxxEmailText()` - Returns plain text version

Customize by editing these functions in their respective files:
- [OTPMailTemplate.ts](./OTPMailTemplate.ts)
- [AbadonFeatTemplate.ts](./AbadonFeatTemplate.ts)
- [VendorApprovalMailTemplate.ts](./VendorApprovalMailTemplate.ts)
- [OrderConfirmationMailTemplate.ts](./OrderConfirmationMailTemplate.ts)
- [VendorOrderAlertMailTemplate.ts](./VendorOrderAlertMailTemplate.ts)

### Adding New Templates
1. Create a new file in `MailTemplates/`
2. Export `build*EmailHtml()` and `build*EmailText()` functions
3. Create a helper function in `emailService.helper.ts` that uses your template
4. Use the helper function in your controllers

## Best Practices

1. **Rate Limiting**: Use `sendEmailBatch()` for bulk emails to avoid rate limits
2. **Error Handling**: Always check the `success` property in the result
3. **Logging**: Log all email sends for debugging and auditing
4. **Plain Text**: Always provide a text version for accessibility
5. **Security**: Never log email addresses in production
6. **Testing**: Test email configuration before going live

## Troubleshooting

### Emails not being sent
1. Check `.env` file has correct credentials
2. Run `verifyEmailConfiguration()` to debug
3. Check console for error messages
4. For Gmail: Verify app password was generated correctly
5. Check firewall/network restrictions

### Gmail authentication fails
- Ensure 2FA is enabled
- Generate new app password
- Wait a few minutes for changes to propagate

### Rate limiting errors
- Reduce number of emails per job
- Increase delay in `sendEmailBatch(payloads, delayMs)`
- Consider using email service provider's queue

## Support
For issues with nodemailer: https://nodemailer.com/

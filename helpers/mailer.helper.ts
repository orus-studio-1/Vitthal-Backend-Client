import nodemailer from 'nodemailer';
import dns from 'dns';

try {
    dns.setDefaultResultOrder('ipv4first');
} catch (err) {
    // Ignore if not supported in older node
}

const transporter = nodemailer.createTransport(
    (process.env.SMTP_HOST
        ? {
              host: process.env.SMTP_HOST.trim(),
              port: Number(process.env.SMTP_PORT || 587),
              secure: process.env.SMTP_SECURE === 'true' && Number(process.env.SMTP_PORT) === 465,
              auth: {
                  user: (process.env.SMTP_USER || process.env.EMAIL_USER)?.trim(),
                  pass: (process.env.SMTP_PASS || process.env.EMAIL_PASSWORD)?.trim(),
              },
              family: 4,
          }
        : {
              service: process.env.EMAIL_SERVICE || 'gmail',
              auth: {
                  user: process.env.EMAIL_USER,
                  pass: process.env.EMAIL_PASSWORD,
              },
              family: 4,
          }) as any
);

interface EmailPayload {
    to: string;
    subject: string;
    htmlContent: string;
    textContent?: string;
}

interface EmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

/**
 * Send an email using nodemailer
 * @param payload - Email configuration and content
 * @returns Result of the email send operation
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
    try {
        // Verify transporter connection on first use
        if (!transporter.verify) {
            return {
                success: false,
                error: 'Email transporter is not properly configured',
            };
        }

        const mailOptions = {
            from: process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER,
            to: payload.to,
            subject: payload.subject,
            html: payload.htmlContent,
            text: payload.textContent || stripHtml(payload.htmlContent),
            replyTo: process.env.EMAIL_REPLY_TO || process.env.SMTP_USER || process.env.EMAIL_USER,
        };

        const info = await transporter.sendMail(mailOptions);

        if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
            console.log(`Email sent successfully to ${payload.to}. Message ID: ${info.messageId}`);
        }

        return {
            success: true,
            messageId: info.messageId,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        console.error(`Failed to send email to ${payload.to}: ${errorMessage}`);

        return {
            success: false,
            error: errorMessage,
        };
    }
}

/**
 * Send emails in batch with rate limiting to avoid overwhelming the service
 * @param payloads - Array of email configurations
 * @param delayMs - Delay between each email send in milliseconds (default: 100)
 * @returns Array of results for each email
 */
export async function sendEmailBatch(payloads: EmailPayload[], delayMs: number = 100): Promise<EmailResult[]> {
    const results: EmailResult[] = [];

    for (const payload of payloads) {
        const result = await sendEmail(payload);
        results.push(result);

        // Add delay between emails to avoid rate limiting
        if (payloads.indexOf(payload) < payloads.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return results;
}

/**
 * Verify email transporter configuration
 * @returns true if transporter is properly configured, false otherwise
 */
export async function verifyEmailConfiguration(): Promise<boolean> {
    try {
        if (!transporter.verify) {
            console.error('Email transporter verify method not available');
            return false;
        }
        await transporter.verify();
        if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
            console.log('Email service configured successfully');
        }
        return true;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Email configuration verification failed: ${errorMessage}`);
        return false;
    }
}

/**
 * Strip HTML tags from a string (for plain text fallback)
 * @param html - HTML string
 * @returns Plain text without HTML tags
 */
function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

// Email service configuration export
export const emailConfig = {
    service: process.env.EMAIL_SERVICE || (process.env.SMTP_HOST ? undefined : 'gmail'),
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER,
    replyTo: process.env.EMAIL_REPLY_TO || process.env.SMTP_USER || process.env.EMAIL_USER,
};

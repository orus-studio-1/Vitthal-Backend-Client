import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

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
 * Send an email using Resend (HTTPS API)
 * @param payload - Email configuration and content
 * @returns Result of the email send operation
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
    try {
        if (!process.env.RESEND_API_KEY) {
            return {
                success: false,
                error: 'RESEND_API_KEY environment variable is missing',
            };
        }

        // Resend requires a verified domain or "onboarding@resend.dev" for testing
        const fromAddress =
            process.env.EMAIL_FROM || 'onboarding@resend.dev';

        const { data, error } = await resend.emails.send({
            from: fromAddress,
            to: payload.to,
            subject: payload.subject,
            html: payload.htmlContent,
            text: payload.textContent || stripHtml(payload.htmlContent),
            replyTo: process.env.EMAIL_REPLY_TO,
        });

        if (error) {
            console.error(`Failed to send email to ${payload.to}: ${error.message}`);
            return {
                success: false,
                error: error.message,
            };
        }

        if (process.env.Production !== 'true' && process.env.NODE_ENV !== 'production') {
            console.log(`Email sent successfully to ${payload.to}. Message ID: ${data?.id}`);
        }

        return {
            success: true,
            messageId: data?.id,
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
 * Send emails in batch with rate limiting
 * @param payloads - Array of email configurations
 * @param delayMs - Delay between each email send in milliseconds (default: 100)
 * @returns Array of results for each email
 */
export async function sendEmailBatch(payloads: EmailPayload[], delayMs: number = 100): Promise<EmailResult[]> {
    const results: EmailResult[] = [];

    for (const payload of payloads) {
        const result = await sendEmail(payload);
        results.push(result);

        if (payloads.indexOf(payload) < payloads.length - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    return results;
}

/**
 * Verify email configuration
 * @returns true if API key is present
 */
export async function verifyEmailConfiguration(): Promise<boolean> {
    if (!process.env.RESEND_API_KEY) {
        console.error('RESEND_API_KEY is not defined');
        return false;
    }
    return true;
}

/**
 * Strip HTML tags from a string (for plain text fallback)
 */
function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

export const emailConfig = {
    service: 'resend',
    from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
    replyTo: process.env.EMAIL_REPLY_TO,
};
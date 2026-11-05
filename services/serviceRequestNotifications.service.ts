import pool from "../DbConnect";
import { createNotification } from "../Controllers/Notification.controller";

export const ACCEPTED_BY_ANOTHER_VENDOR_TITLE = "Request accepted by another vendor";

/**
 * Tells every vendor who was offered or quoted a service request that another vendor now has it.
 * Reaches vendors who never quoted too, because they saw the request and could still act on it.
 */
export async function notifyServiceRequestClosedForOthers(ticketId: string, winnerVendorId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT DISTINCT recipient.user_id, ticket.ticket_payload->>'job_title' AS job_title, ticket.ticket_number
       FROM service_tickets ticket
       JOIN LATERAL (
         SELECT n.user_id FROM notifications n
         WHERE n.reference_id = ticket.id AND n.type = 'quotation_request_received'
         UNION
         SELECT v.user_id FROM service_ticket_quotations q
         JOIN vendors v ON v.id = q.vendor_id
         WHERE q.ticket_id = ticket.id
       ) recipient ON TRUE
       WHERE ticket.id = $1
         AND recipient.user_id IS DISTINCT FROM (SELECT user_id FROM vendors WHERE id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM notifications sent
           WHERE sent.user_id = recipient.user_id AND sent.reference_id = ticket.id AND sent.title = $3
         )`,
      [ticketId, winnerVendorId, ACCEPTED_BY_ANOTHER_VENDOR_TITLE],
    );
    for (const row of result.rows) {
      const name = row.job_title || row.ticket_number || "this service request";
      await createNotification({
        userId: row.user_id,
        type: "quotation_rejected",
        title: ACCEPTED_BY_ANOTHER_VENDOR_TITLE,
        body: `${name} has been accepted by another vendor and is now closed. Thank you for your interest. New requests matching your services will keep reaching you.`,
        referenceType: "service_quotation",
        referenceId: ticketId,
      });
    }
  } catch (error) {
    console.error(`[ServiceRequestNotifications] Could not notify other vendors for ${ticketId}:`, error);
  }
}

import pool from "../DbConnect";
import { createNotification } from "../Controllers/Notification.controller";

type OrderEvent = "placed" | "accepted" | "cancelled_by_vendor" | "picked_up" | "at_final_hub" | "delivered";

type Message = { title: string; body: (reference: string) => string };

const CLIENT_MESSAGES: Record<OrderEvent, Message> = {
  placed: { title: "Order placed", body: (ref) => `Your order ${ref} has been placed and sent to the vendor.` },
  accepted: { title: "Order accepted", body: (ref) => `The vendor accepted your order ${ref} and is preparing it.` },
  cancelled_by_vendor: { title: "Order cancelled", body: (ref) => `The vendor cancelled your order ${ref}.` },
  picked_up: { title: "Order picked up", body: (ref) => `Your order ${ref} has been picked up from the vendor.` },
  at_final_hub: { title: "Order on its way", body: (ref) => `Your order ${ref} has reached the nearest hub and will be delivered soon.` },
  delivered: { title: "Order delivered", body: (ref) => `Your order ${ref} has been delivered.` },
};

const VENDOR_MESSAGES: Partial<Record<OrderEvent, Message>> = {
  placed: { title: "New order received", body: (ref) => `You received a new order ${ref}. Please review and accept it.` },
  delivered: { title: "Order delivered", body: (ref) => `Order ${ref} has been delivered to the customer.` },
};

/** Tells the client and the vendor about an order step. Never throws: an order must not fail over a notification. */
export async function notifyOrderEvent(orderId: string, event: OrderEvent): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT o.user_id, o.order_reference, v.user_id AS vendor_user_id
       FROM orders o LEFT JOIN vendors v ON v.id = o.vendor_id
       WHERE o.id = $1`,
      [orderId],
    );
    const order = result.rows[0];
    if (!order) return;
    const reference = order.order_reference || `#${orderId.slice(0, 8).toUpperCase()}`;
    const send = async (userId: string | null, message?: Message) => {
      if (!userId || !message) return;
      await createNotification({
        userId,
        type: "general",
        title: message.title,
        body: message.body(reference),
        referenceType: "order",
        referenceId: orderId,
      });
    };
    await send(order.user_id, CLIENT_MESSAGES[event]);
    await send(order.vendor_user_id, VENDOR_MESSAGES[event]);
  } catch (error) {
    console.error(`[OrderNotifications] Could not send "${event}" for order ${orderId}:`, error);
  }
}

/** Tells a vendor about a service booking paid or placed through the cart. */
export async function notifyServiceBookingPlaced(bookingId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT v.user_id AS vendor_user_id, s.name AS service_name
       FROM service_bookings sb
       JOIN vendors v ON v.id = sb.vendor_id
       LEFT JOIN vendor_services vs ON vs.id = sb.vendor_service_id
       LEFT JOIN services s ON s.id = vs.service_id
       WHERE sb.id = $1`,
      [bookingId],
    );
    const booking = result.rows[0];
    if (!booking?.vendor_user_id) return;
    await createNotification({
      userId: booking.vendor_user_id,
      type: "general",
      title: "New service booking",
      body: `You received a new booking for ${booking.service_name || "your service"}.`,
      referenceType: "service_booking",
      referenceId: bookingId,
    });
  } catch (error) {
    console.error(`[OrderNotifications] Could not notify booking ${bookingId}:`, error);
  }
}

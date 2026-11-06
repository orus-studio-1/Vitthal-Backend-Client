import type { PoolClient } from "pg";

/**
 * Records when a delivered product order becomes payable to its vendor, using the
 * vendor's credit cycle. Mirrors the admin panel's status update so rider-delivered
 * orders get the same payout record as orders an admin marks delivered.
 */
export async function recordVendorPayoutDue(client: PoolClient, orderId: string): Promise<void> {
  await client.query(
    `INSERT INTO vendor_payouts (order_id, vendor_id, status, delivered_at, due_date)
     SELECT
         o.id,
         o.vendor_id,
         'pending',
         NOW(),
         NOW() + (
             COALESCE(
                 CASE
                     WHEN LOWER(v.credit_cycle) LIKE '%immediate%' THEN 0
                     WHEN substring(v.credit_cycle from '\\d+') IS NOT NULL THEN substring(v.credit_cycle from '\\d+')::integer
                     ELSE 15
                 END,
                 15
             ) * INTERVAL '1 day'
         )
     FROM orders o
     JOIN vendors v ON o.vendor_id = v.id
     WHERE o.id = $1
     ON CONFLICT (order_id) DO UPDATE SET
         delivered_at = EXCLUDED.delivered_at,
         due_date = EXCLUDED.due_date,
         updated_at = NOW()`,
    [orderId],
  );
}

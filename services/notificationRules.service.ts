import pool from "../DbConnect";

const NOTIFICATION_TYPES = [
  "admin_confirmation_accepted",
  "admin_confirmation_rejected",
  "admin_confirmation_sent",
  "general",
  "hire_completion_confirmed",
  "hire_contract_completed",
  "hire_message",
  "hire_offer_accepted",
  "hire_offer_received",
  "hire_payment_successful",
  "hire_request_accepted",
  "hire_request_cancelled",
  "hire_request_received",
  "hire_request_rejected",
  "hiring_access_unlocked",
  "image_approved",
  "image_rejected",
  "product_approved",
  "product_rejected",
  "quotation_accepted",
  "quotation_counter_received",
  "quotation_dispatch_payment_requested",
  "quotation_dispatched",
  "quotation_offer_received",
  "quotation_rejected",
  "quotation_request_received",
  "service_completed",
  "vendor_product_approved",
  "vendor_product_rejected",
];

const NOTIFICATION_REFERENCE_TYPES = [
  "quotation",
  "order",
  "product",
  "service",
  "service_quotation",
  "service_booking",
  "service_ticket",
  "hire_request",
];

const RULES = [
  { name: "chk_notification_type", column: "type", nullable: false, required: NOTIFICATION_TYPES },
  { name: "chk_notification_reference_type", column: "reference_type", nullable: true, required: NOTIFICATION_REFERENCE_TYPES },
];

/**
 * Keeps the notifications check constraints able to accept every value the code sends. It runs on every
 * boot because production drifted from the migrations, and migrations can be switched off with
 * RUN_MIGRATIONS_ON_START. Values already allowed are kept, and NOT VALID leaves old rows unchecked.
 */
export async function ensureNotificationRules(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const rule of RULES) {
      const current = await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'notifications'::regclass AND conname = $1`,
        [rule.name],
      );
      const existing: string = current.rows[0]?.def ?? "";
      const allowed = [...existing.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1] as string);
      const missing = rule.required.filter((value) => !allowed.includes(value));
      if (existing && missing.length === 0) {
        console.log(`[NotificationRules] ${rule.name} is up to date.`);
        continue;
      }
      const values = [...new Set([...allowed, ...rule.required])].map((value) => `'${value}'`).join(", ");
      const check = rule.nullable
        ? `${rule.column} IS NULL OR ${rule.column} IN (${values})`
        : `${rule.column} IN (${values})`;
      await client.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS ${rule.name}`);
      await client.query(`ALTER TABLE notifications ADD CONSTRAINT ${rule.name} CHECK (${check}) NOT VALID`);
      console.log(`[NotificationRules] ${rule.name} updated, added: ${missing.join(", ")}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const OPTIONAL_DISPATCH_COLUMNS = [
  "lr_number",
  "eway_bill_number",
  "transporter_name",
  "eway_bill_url",
  "delivery_challan_url",
  "invoice_url",
  "lr_document_url",
];

/** The dispatch form needs only one detail or document, but production required some of these columns. */
export async function ensureDispatchColumnsOptional(): Promise<void> {
  const required = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'order_dispatch_details' AND is_nullable = 'NO' AND column_name = ANY($1::text[])`,
    [OPTIONAL_DISPATCH_COLUMNS],
  );
  for (const row of required.rows) {
    await pool.query(`ALTER TABLE order_dispatch_details ALTER COLUMN ${row.column_name} DROP NOT NULL`);
    console.log(`[DispatchColumns] ${row.column_name} is now optional.`);
  }
  if (required.rows.length === 0) console.log("[DispatchColumns] Already optional.");
}

/**
 * Lets one email hold one account per role (client, vendor, worker, ...) instead of one in total.
 * Existing data already satisfies the new rule, since emails were unique before.
 */
export async function ensureEmailUniquePerRole(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("CREATE UNIQUE INDEX IF NOT EXISTS users_email_role_key ON users (email, role)");
        await client.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key");
        await client.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS idx_users_email_unique");
        await client.query("DROP INDEX IF EXISTS users_email_key");
        await client.query("DROP INDEX IF EXISTS idx_users_email_unique");
        await client.query("CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)");
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

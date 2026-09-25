import { Request , Response} from "express";
import pool from "../DbConnect";
import { sendWhatsAppNotification } from "../services/pushNotification.service";

export const clientEnquiryController = async (req : Request, res:Response) => {
  const { name, email, company, phone, subject, message } = req.body;

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 1. Save to DB so it shows up in the admin panel
    const result = await pool.query(
      `INSERT INTO contact_queries (name, email, company, phone, subject, message, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'new', NOW())
       RETURNING id`,
      [name, email, company || null, phone || null, subject, message]
    );
    const queryId = result.rows[0].id;

    // 2. Notify admin on WhatsApp (fire-and-forget, don't block the response on it)
    sendWhatsAppNotification({ name, email, phone, subject, message }).catch((err) =>
      console.error("WhatsApp notify failed:", err)
    );

    return res.status(201).json({ success: true, id: queryId });
  } catch (err) {
    console.error("Contact form error:", err);
    return res.status(500).json({ error: "Something went wrong" });
  }
};
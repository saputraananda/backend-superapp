import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/birthday/upcoming -> List customers with birthdays this month and next month
export const getUpcomingBirthdays = async (req, res) => {
  try {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;

    const [rows] = await safeMyWaschenQuery(
      `SELECT id, customer_no, name, phone, birth_date, birth_month, birth_day, segment, total_transactions, last_transaction_at
       FROM mst_customer
       WHERE is_active = 1 
         AND deleted_at IS NULL
         AND (birth_month = ? OR birth_month = ?)
       ORDER BY birth_month ASC, birth_day ASC`,
      [currentMonth, nextMonth]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getUpcomingBirthdays] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/birthday/send-promo -> Trigger birthday promo creation & message logging
export const sendBirthdayPromo = async (req, res) => {
  try {
    const { customer_id, campaign_type, message, bonus_amount, discount_pct, valid_until } = req.body;
    const userId = req.session.userId || 1;

    if (!customer_id || !campaign_type || !message) {
      return res.status(400).json({ success: false, message: "Customer ID, campaign type, and message are required." });
    }

    const [customerRow] = await safeMyWaschenQuery(
      "SELECT name FROM mst_customer WHERE id = ?",
      [customer_id]
    );
    if (customerRow.length === 0) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    const customerName = customerRow[0].name;

    // 1. Create a notification log
    await safeMyWaschenQuery(
      `INSERT INTO tr_birthday_notification (customer_id, campaign_type, message, status, sent_via, sent_by, sent_at)
       VALUES (?, ?, ?, 'sent', 'whatsapp', ?, NOW())`,
      [customer_id, campaign_type, message, userId]
    );

    // 2. Generate a unique promo code if type is discount
    if (campaign_type === 'discount') {
      const code = `HBD-${customerName.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
      
      const expDate = valid_until || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // default 30 days
      
      await safeMyWaschenQuery(
        `INSERT INTO tr_birthday_promo_code (customer_id, code, promo_type, discount_pct, valid_from, valid_until, status)
         VALUES (?, ?, 'discount', ?, CURDATE(), ?, 'active')`,
        [customer_id, code, discount_pct || 15.00, expDate]
      );
    }

    // 3. Create a claiming offer if type is deposit_bonus or free_service
    if (campaign_type === 'deposit_bonus' || campaign_type === 'free_service') {
      const expDate = valid_until || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      await safeMyWaschenQuery(
        `INSERT INTO tr_birthday_offer (customer_id, offer_type, bonus_amount, message, status, expires_at, created_by)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [customer_id, campaign_type, bonus_amount || 0.00, message, expDate, userId]
      );
    }

    return res.json({ success: true, message: "Birthday promo campaign sent and logged successfully." });
  } catch (err) {
    console.error("[sendBirthdayPromo] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

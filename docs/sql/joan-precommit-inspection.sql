-- READ ONLY. Run in the correct authenticated project. No data cleanup or update.
SELECT "name", "price", "deposit", "duration"
FROM "packages"
WHERE "name" = 'THE ICON';

-- Replace <test_customer_id> with the operator-controlled identifier.
-- Intentionally no real phone number is stored in this tracked file.
WITH target AS (SELECT '<test_customer_id>'::text AS customer_id)
SELECT c."id", c."name", b."id" AS booking_id, b."service", b."status",
       b."dateTime" AS stored_datetime,
       (b."dateTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Nairobi' AS nairobi_datetime,
       b."googleEventId",
       (SELECT count(*) FROM "payments" p
        WHERE p."bookingId" = b."id" AND p."status" = 'success') AS successful_payments
FROM "customers" c
JOIN target t ON c."id" = t.customer_id OR c."whatsappId" = t.customer_id
LEFT JOIN "bookings" b ON b."customerId" = c."id"
ORDER BY b."dateTime";

-- Identify exact test-owned records and linked Calendar/payment state before any
-- cancellation. Do not DELETE all rows for a number or silently overwrite a name.
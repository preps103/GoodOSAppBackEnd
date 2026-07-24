"use strict";

const crypto = require("crypto");
const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool, query } = require("../config/database");

const router = express.Router();
router.use(authRequired, tenantContext);

const ACTIVE_BOOKING_STATUSES = [
  "pending_payment", "confirmed", "assigned", "checked_in",
  "checked_out", "extended", "overdue"
];

function actor(request) {
  return request.user?.id || null;
}

function organization(request) {
  return request.tenantContext.organizationId;
}

function fail(response, status, code, message, details) {
  return response.status(status).json({ success: false, code, message, ...(details ? { details } : {}) });
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function money(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    const error = new Error(`${field} must be a non-negative number.`);
    error.statusCode = 400;
    error.code = "INVALID_MONEY";
    throw error;
  }
  return parsed.toFixed(2);
}

function timestamp(date, time, field) {
  const parsed = new Date(`${date}T${time || "10:00"}:00`);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${field} is invalid.`);
    error.statusCode = 400;
    error.code = "INVALID_DATE";
    throw error;
  }
  return parsed.toISOString();
}

function vehiclePayload(row) {
  return {
    ...(row.payload || {}), id: row.id, vin: row.vin, licensePlate: row.license_plate,
    make: row.make, model: row.model, year: row.model_year, status: row.status,
    assignedBranchId: row.assigned_branch_id, dailyRate: Number(row.daily_rate),
    registrationExpiry: row.registration_expiry, insuranceExpiry: row.insurance_expiry,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function customerPayload(row) {
  return {
    ...(row.payload || {}), id: row.id, name: row.full_name, email: row.email,
    phone: row.phone, status: row.status, licenseNumber: row.license_number,
    licenseExpiry: row.license_expiry,
    licenseVerificationStatus: row.license_verification_status,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function bookingPayload(row) {
  const pickup = new Date(row.pickup_at);
  const returned = new Date(row.return_at);
  return {
    ...(row.payload || {}), id: row.id, reservationNumber: row.reservation_number,
    customerId: row.customer_id, carId: row.vehicle_id || undefined,
    startDate: pickup.toISOString().slice(0, 10), endDate: returned.toISOString().slice(0, 10),
    pickupTime: pickup.toISOString().slice(11, 16), dropoffTime: returned.toISOString().slice(11, 16),
    pickupLocationId: row.pickup_branch_id, returnLocationId: row.return_branch_id,
    status: row.status, paymentStatus: row.payment_status,
    totalAmount: Number(row.total_amount), depositAmount: Number(row.deposit_amount),
    paidAmount: Number(row.paid_amount), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function audit(client, request, action, entityType, entityId, before, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [organization(request), actor(request), action, entityType, entityId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      request.id || request.get("X-Request-ID") || null, request.ip || null]
  );
}

router.get("/health", async (request, response, next) => {
  try {
    const result = await query(`SELECT to_regclass('public.fleet_bookings') IS NOT NULL AS ready`);
    response.json({ success: true, service: "goodfleet", databaseReady: result.rows[0].ready });
  } catch (error) { next(error); }
});

router.get("/bootstrap", async (request, response, next) => {
  try {
    const org = organization(request);
    const [vehicles, customers, bookings] = await Promise.all([
      query(`SELECT * FROM fleet_vehicles WHERE organization_id=$1 ORDER BY created_at DESC`, [org]),
      query(`SELECT * FROM fleet_customers WHERE organization_id=$1 ORDER BY created_at DESC`, [org]),
      query(`SELECT * FROM fleet_bookings WHERE organization_id=$1 ORDER BY pickup_at DESC`, [org])
    ]);
    response.json({ success: true, data: {
      vehicles: vehicles.rows.map(vehiclePayload),
      customers: customers.rows.map(customerPayload),
      bookings: bookings.rows.map(bookingPayload)
    }});
  } catch (error) { next(error); }
});

router.post("/vehicles", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_vehicles
       (organization_id,vin,license_plate,make,model,model_year,status,assigned_branch_id,daily_rate,registration_expiry,insurance_expiry,payload,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$13) RETURNING *`,
      [organization(request), text(body.vin, 80), text(body.licensePlate, 40), text(body.make, 100),
        text(body.model, 100), Number(body.year), text(body.status || "available", 40),
        text(body.assignedBranchId, 200) || null, money(body.dailyRate, "dailyRate"),
        body.registrationExpiry || null, body.insuranceExpiry || null, JSON.stringify(body), actor(request)]
    );
    const vehicle = vehiclePayload(result.rows[0]);
    await audit(client, request, "vehicle.created", "vehicle", vehicle.id, null, vehicle);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: vehicle });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "VEHICLE_ALREADY_EXISTS", "VIN or license plate already exists.");
    next(error);
  } finally { client.release(); }
});

router.post("/customers", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO fleet_customers
       (organization_id,full_name,email,phone,status,license_number,license_expiry,license_verification_status,payload,created_by,updated_by)
       VALUES ($1,$2,lower($3),$4,$5,$6,$7,$8,$9::jsonb,$10,$10) RETURNING *`,
      [organization(request), text(body.name, 200), text(body.email, 320), text(body.phone, 50) || null,
        text(body.status || "active", 40), text(body.licenseNumber, 100), body.licenseExpiry,
        text(body.licenseVerificationStatus || "pending", 40), JSON.stringify(body), actor(request)]
    );
    const customer = customerPayload(result.rows[0]);
    await audit(client, request, "customer.created", "customer", customer.id, null, customer);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: customer });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return fail(response, 409, "CUSTOMER_ALREADY_EXISTS", "Email or driver license already exists.");
    next(error);
  } finally { client.release(); }
});

router.post("/bookings", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const body = request.body || {};
    const org = organization(request);
    const pickupAt = timestamp(body.startDate, body.pickupTime, "pickupAt");
    const returnAt = timestamp(body.endDate, body.dropoffTime, "returnAt");
    if (new Date(returnAt) <= new Date(pickupAt)) return fail(response, 400, "INVALID_RENTAL_PERIOD", "Return must be after pickup.");
    await client.query("BEGIN");
    if (body.carId) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${org}:${body.carId}`]);

    const customerResult = await client.query(
      `SELECT * FROM fleet_customers WHERE organization_id=$1 AND id=$2 FOR SHARE`, [org, body.customerId]
    );
    if (!customerResult.rowCount) { await client.query("ROLLBACK"); return fail(response, 404, "CUSTOMER_NOT_FOUND", "Customer not found."); }
    const customer = customerResult.rows[0];
    if (customer.status !== "active" || customer.license_verification_status !== "verified" || new Date(customer.license_expiry) < new Date(pickupAt)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "DRIVER_NOT_ELIGIBLE", "Customer must be active with a verified license valid through pickup.");
    }

    if (body.carId) {
      const vehicleResult = await client.query(
        `SELECT * FROM fleet_vehicles WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [org, body.carId]
      );
      if (!vehicleResult.rowCount) { await client.query("ROLLBACK"); return fail(response, 404, "VEHICLE_NOT_FOUND", "Vehicle not found."); }
      const vehicle = vehicleResult.rows[0];
      if (vehicle.status !== "available" || (vehicle.registration_expiry && new Date(vehicle.registration_expiry) < new Date(pickupAt)) || (vehicle.insurance_expiry && new Date(vehicle.insurance_expiry) < new Date(pickupAt))) {
        await client.query("ROLLBACK");
        return fail(response, 409, "VEHICLE_NOT_ELIGIBLE", "Vehicle is unavailable or has expired compliance documents.");
      }
    }

    const reservation = text(body.reservationNumber, 80) || `GF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const result = await client.query(
      `INSERT INTO fleet_bookings
       (organization_id,reservation_number,customer_id,vehicle_id,pickup_at,return_at,pickup_branch_id,return_branch_id,status,payment_status,total_amount,deposit_amount,paid_amount,payload,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_payment','unpaid',$9,$10,$11,$12::jsonb,$13,$13) RETURNING *`,
      [org, reservation, body.customerId, body.carId || null, pickupAt, returnAt,
        text(body.pickupLocationId, 200), text(body.returnLocationId, 200),
        money(body.totalAmount, "totalAmount"), money(body.depositAmount || 0, "depositAmount"),
        money(body.paidAmount || 0, "paidAmount"), JSON.stringify(body), actor(request)]
    );
    const booking = bookingPayload(result.rows[0]);
    await audit(client, request, "booking.created", "booking", booking.id, null, booking);
    await client.query("COMMIT");
    response.status(201).json({ success: true, data: booking });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23P01") return fail(response, 409, "VEHICLE_NOT_AVAILABLE", "Vehicle is already committed during this rental period, including turnaround time.");
    if (error.code === "23505") return fail(response, 409, "RESERVATION_ALREADY_EXISTS", "Reservation number already exists.");
    next(error);
  } finally { client.release(); }
});

module.exports = router;

"use strict";

const crypto = require("node:crypto");
const express = require("express");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const PLATFORMS = new Set(["YouTube", "Instagram", "TikTok", "Twitter/X", "Telegram"]);
const STATUSES = new Set(["draft", "pending_review"]);

function clean(value, max = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function number(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function boolean(value) {
  return value === true;
}

function validAccountUrl(platform, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const allowed = {
    YouTube: ["youtube.com", "youtu.be"],
    Instagram: ["instagram.com"],
    TikTok: ["tiktok.com"],
    "Twitter/X": ["x.com", "twitter.com"],
    Telegram: ["t.me", "telegram.me"],
  };
  return allowed[platform].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function listingResponse(row) {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    accountUrl: row.account_url,
    platform: row.platform,
    subscribers: Number(row.subscribers),
    price: Number(row.price),
    monthlyRevenue: Number(row.monthly_revenue),
    description: row.description,
    verified: row.status === "active",
    status: row.status,
    category: row.category,
    createdAt: row.created_at,
    engagementRate: Number(row.engagement_rate),
    imageUrl: row.image_url || undefined,
    country: row.country,
    ogEmail: row.original_email_included,
    audienceMalePercent: row.audience_male_percent,
    escrowAccepted: true,
    instantDelivery: row.instant_delivery,
    audienceReport: row.audience_report_available,
    transferMethod: row.transfer_method,
    ownershipVerificationCode: row.is_owner ? row.ownership_verification_code : undefined,
    seller: {
      id: row.user_id,
      name: row.seller_name || "GoodSwapz seller",
      rating: Number(row.seller_rating || 0),
      dealsCompleted: Number(row.deals_completed || 0),
      verified: Boolean(row.seller_verified),
    },
    audienceAgeRange: row.audience_age_json || {},
    audienceTopLocations: row.audience_locations_json || {},
  };
}

router.use(authRequired);
router.use((req, res, next) => {
  const origin = clean(req.get("Origin"), 300);
  const expected = process.env.GOODSWAPZ_ORIGIN || "https://swapz.goodos.app";
  const local = process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(?::\d+)?$/.test(origin);
  if (origin && origin !== expected && !local) {
    return res.status(403).json({ success: false, code: "GOODSWAPZ_ORIGIN_DENIED", message: "Request origin is not allowed." });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "GoodSwapz") {
    return res.status(403).json({ success: false, code: "GOODSWAPZ_REQUEST_HEADER_REQUIRED", message: "Required request header is missing." });
  }
  return next();
});

router.get("/listings", async (req, res, next) => {
  try {
    const result = await database.query(
      `SELECT listing.*, listing.user_id=$1 AS is_owner,
              COALESCE(account.display_name, account.email) AS seller_name,
              account.email_verified AS seller_verified,
              0::numeric AS seller_rating, 0::integer AS deals_completed
       FROM goodswapz_listings listing
       JOIN users account ON account.id=listing.user_id
       WHERE listing.status='active' OR listing.user_id=$1
       ORDER BY listing.created_at DESC
       LIMIT 500`,
      [req.user.id]
    );
    return res.json({ success: true, listings: result.rows.map(listingResponse) });
  } catch (error) { return next(error); }
});

router.post("/listings", async (req, res, next) => {
  try {
    const input = req.body || {};
    const platform = clean(input.platform, 40);
    const title = clean(input.title, 120);
    const handle = clean(input.handle, 100);
    const accountUrl = clean(input.accountUrl, 2048);
    const category = clean(input.category, 80);
    const country = clean(input.country, 80);
    const description = clean(input.description, 4000);
    const transferMethod = clean(input.transferMethod, 500);
    const imageUrl = clean(input.imageUrl, 2048);
    const subscribers = number(input.subscribers, 1, 2_000_000_000);
    const price = number(input.price, 50, 100_000_000);
    const revenue = number(input.monthlyRevenue || 0, 0, 100_000_000);
    const engagement = number(input.engagementRate || 0, 0, 100);
    const audienceMale = number(input.audienceMalePercent ?? 50, 0, 100);
    const status = input.submitForReview === true ? "pending_review" : "draft";

    if (!PLATFORMS.has(platform) || title.length < 8 || handle.length < 2 ||
        !validAccountUrl(platform, accountUrl) || category.length < 2 ||
        country.length < 2 || description.length < 40 || !subscribers ||
        !price || revenue === null || engagement === null || audienceMale === null ||
        transferMethod.length < 20 || input.acceptsSellerTerms !== true) {
      return res.status(400).json({
        success: false,
        code: "INVALID_LISTING",
        message: "Complete every required listing, ownership, transfer, and seller-certification field.",
      });
    }

    let safeImageUrl = null;
    if (imageUrl) {
      try {
        const parsed = new URL(imageUrl);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
        safeImageUrl = parsed.toString();
      } catch {
        return res.status(400).json({ success: false, code: "INVALID_IMAGE_URL", message: "Listing image URL must be a public HTTPS URL." });
      }
    }

    const verificationCode = `GOODSWAPZ-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    const result = await database.query(
      `INSERT INTO goodswapz_listings(
        user_id,title,handle,account_url,platform,subscribers,price,monthly_revenue,
        description,category,engagement_rate,image_url,country,original_email_included,
        audience_male_percent,instant_delivery,audience_report_available,
        audience_age_json,audience_locations_json,transfer_method,status,
        ownership_verification_code
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18::jsonb,$19::jsonb,$20,$21,$22
      ) RETURNING *, true AS is_owner, $23::text AS seller_name,
        false AS seller_verified, 0::numeric AS seller_rating, 0::integer AS deals_completed`,
      [
        req.user.id, title, handle.startsWith("@") ? handle : `@${handle}`, accountUrl,
        platform, subscribers, price, revenue, description, category, engagement,
        safeImageUrl, country, boolean(input.ogEmail), audienceMale,
        boolean(input.instantDelivery), boolean(input.audienceReport),
        JSON.stringify(input.audienceAgeRange || {}), JSON.stringify(input.audienceTopLocations || {}),
        transferMethod, status, verificationCode, req.user.displayName || req.user.email,
      ]
    );
    await logAudit({
      userId: req.user.id,
      appId: "goodswapz",
      action: "goodswapz.listing.create",
      entityType: "listing",
      entityId: result.rows[0].id,
      ipAddress: req.ip,
      metadata: { platform, status },
    }).catch(() => {});
    return res.status(201).json({ success: true, listing: listingResponse(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.patch("/listings/:id/status", async (req, res, next) => {
  try {
    const status = clean(req.body?.status, 40);
    if (!STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "Listing status is invalid." });
    }
    const result = await database.query(
      `UPDATE goodswapz_listings SET status=$3,updated_at=NOW()
       WHERE id=$1 AND user_id=$2
       RETURNING *, true AS is_owner, $4::text AS seller_name,
         false AS seller_verified, 0::numeric AS seller_rating, 0::integer AS deals_completed`,
      [req.params.id, req.user.id, status, req.user.displayName || req.user.email]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "Listing not found." });
    return res.json({ success: true, listing: listingResponse(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.post("/ai/estimate-valuation", async (req, res) => {
  const platform = clean(req.body?.platform, 40);
  const subscribers = number(req.body?.subscribers, 1, 2_000_000_000);
  const revenue = number(req.body?.revenue || 0, 0, 100_000_000);
  if (!PLATFORMS.has(platform) || !subscribers || revenue === null) {
    return res.status(400).json({ success: false, message: "Valid platform, followers, and revenue are required." });
  }
  const platformRate = { YouTube: 0.035, Instagram: 0.018, TikTok: 0.012, "Twitter/X": 0.01, Telegram: 0.014 }[platform];
  const audienceValue = subscribers * platformRate;
  const revenueValue = revenue * 30;
  const midpoint = Math.max(50, audienceValue + revenueValue);
  return res.json({
    success: true,
    low: Math.round(midpoint * 0.8),
    high: Math.round(midpoint * 1.2),
    reasoning: "GoodBase estimated this range from audience size, platform, and a 30-month revenue multiple. Ownership, engagement evidence, account health, and transfer risk can change the final value.",
  });
});

router.post("/ai/generate-description", async (req, res) => {
  const platform = clean(req.body?.platform, 40);
  const category = clean(req.body?.category, 80);
  const title = clean(req.body?.title, 120);
  const notes = clean(req.body?.notes, 800);
  const subscribers = number(req.body?.subscribers, 1, 2_000_000_000);
  const revenue = number(req.body?.revenue || 0, 0, 100_000_000);
  if (!PLATFORMS.has(platform) || category.length < 2 || !subscribers || revenue === null) {
    return res.status(400).json({ success: false, message: "Platform, category, and followers are required." });
  }
  const revenueText = revenue > 0 ? ` It currently reports approximately $${Math.round(revenue).toLocaleString("en-US")} in monthly revenue.` : "";
  const noteText = notes ? ` Additional seller notes: ${notes}` : "";
  return res.json({
    success: true,
    description: `${title || `${category} ${platform} account`} is an established ${category} account on ${platform} with approximately ${Math.round(subscribers).toLocaleString("en-US")} followers.${revenueText}${noteText} The account will be transferred only after GoodEscrow confirms funding and ownership review is complete.`,
  });
});

module.exports = router;

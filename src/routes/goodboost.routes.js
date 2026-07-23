"use strict";

const express = require("express");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const PLATFORMS = new Set(["Facebook","YouTube","TikTok","Instagram","Twitter","LinkedIn","Pinterest","SoundCloud","VKontakte","MySpace","Flickr","Vimeo","Reverbnation","Ok.ru","Ask.fm","Twitch","Website"]);
const INTERACTIONS = new Set(["Like","Follow","View","Share","Comment","Subscribe","Save","Repost","Listen","Join","Connection","Fave","Fan","Retweet"]);

function clean(value, max = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function publicCampaign(row) {
  return {
    id: row.id,
    platform: row.platform,
    url: row.content_url,
    type: row.interaction_type,
    target: row.target,
    current: row.current_count,
    status: row.status,
    targeting: row.targeting_json,
    createdAt: row.created_at,
  };
}

function publicProfile(row) {
  if (!row) return {};
  return {
    tier: row.tier,
    trustScore: row.trust_score,
    dailyStreak: row.daily_streak,
    bonusClaimed: row.bonus_claimed,
    referrals: row.referral_json,
    settings: row.preferences_json,
    whiteLabelConfig: row.white_label_json,
  };
}

function publicListing(row) {
  return {
    id: row.id,
    platform: row.platform,
    assetType: row.asset_type,
    handle: row.handle,
    profileUrl: row.profile_url,
    niche: row.niche,
    followers: row.followers,
    averageViews: row.average_views,
    engagementRate: Number(row.engagement_rate),
    monthlyRevenue: Number(row.monthly_revenue),
    askingPrice: Number(row.asking_price),
    valuationLow: Number(row.valuation_low),
    valuationHigh: Number(row.valuation_high),
    transferEligibility: row.transfer_eligibility,
    transferReason: row.transfer_reason,
    status: row.status,
    metricsVerified: row.metrics_verified,
    ownershipVerified: row.ownership_verified,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function transferPolicy(platform, assetType) {
  const normalized = assetType.toLowerCase();
  if (platform === "YouTube" && normalized === "brand account") {
    return { eligibility: "Manual review", reason: "Only a YouTube Brand Account with a documented primary-owner transfer can proceed." };
  }
  if (platform === "Facebook" && ["page", "business asset"].includes(normalized)) {
    return { eligibility: "Manual review", reason: "Only Page or business-asset access may proceed after Meta ownership and role-transfer review." };
  }
  if (platform === "Website" && ["website", "digital business"].includes(normalized)) {
    return { eligibility: "Eligible", reason: "Domain, content, analytics, and business assets can proceed through documented asset transfer." };
  }
  return { eligibility: "Unsupported", reason: `${platform} personal accounts cannot be listed because account transfers may violate platform rules.` };
}

function valuation({ followers, averageViews, engagementRate, monthlyRevenue }) {
  const revenueValue = monthlyRevenue * 24;
  const audienceValue = followers * Math.min(0.12, 0.025 + engagementRate * 0.006);
  const viewValue = averageViews * 0.035;
  const midpoint = Math.max(100, revenueValue + audienceValue + viewValue);
  return {
    low: Math.round(midpoint * 0.75 * 100) / 100,
    high: Math.round(midpoint * 1.3 * 100) / 100,
  };
}

function validCampaignUrl(platform, value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const domains = {
    Facebook: ["facebook.com"], YouTube: ["youtube.com","youtu.be"], TikTok: ["tiktok.com"],
    Instagram: ["instagram.com"], Twitter: ["x.com","twitter.com"], LinkedIn: ["linkedin.com"],
    Pinterest: ["pinterest.com","pin.it"], SoundCloud: ["soundcloud.com"], VKontakte: ["vk.com"],
    MySpace: ["myspace.com"], Flickr: ["flickr.com"], Vimeo: ["vimeo.com"],
    Reverbnation: ["reverbnation.com"], "Ok.ru": ["ok.ru"], "Ask.fm": ["ask.fm"],
    Twitch: ["twitch.tv"],
  };
  if (platform === "Website") return true;
  return (domains[platform] || []).some(domain => host === domain || host.endsWith(`.${domain}`));
}

router.use(authRequired);
router.use((req, res, next) => {
  const origin = clean(req.get("Origin"), 300);
  const expected = process.env.GOODBOOST_ORIGIN || "https://boost.goodos.app";
  const developmentOrigin = process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(?::\d+)?$/.test(origin);
  if (origin && origin !== expected && !developmentOrigin) {
    return res.status(403).json({ success: false, code: "GOODBOOST_ORIGIN_DENIED", message: "Request origin is not allowed." });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "GoodBoost") {
    return res.status(403).json({ success: false, code: "GOODBOOST_REQUEST_HEADER_REQUIRED", message: "Required request header is missing." });
  }
  return next();
});

router.get("/bootstrap", async (req, res, next) => {
  try {
    await database.query("INSERT INTO goodboost_profiles(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [req.user.id]);
    const [profile, campaigns, activity] = await Promise.all([
      database.query("SELECT * FROM goodboost_profiles WHERE user_id=$1", [req.user.id]),
      database.query("SELECT * FROM goodboost_campaigns WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500", [req.user.id]),
      database.query(`SELECT date_trunc('day',created_at) AS day,COUNT(*)::int AS count FROM goodboost_activity WHERE user_id=$1 AND created_at>NOW()-INTERVAL '90 days' GROUP BY 1 ORDER BY 1`, [req.user.id]),
    ]);
    return res.json({
      success: true,
      profile: publicProfile(profile.rows[0]),
      campaigns: campaigns.rows.map(publicCampaign),
      activityLogs: activity.rows.map(row => ({ date: row.day, count: row.count })),
      connectedAccounts: [],
    });
  } catch (error) { return next(error); }
});

router.get("/listings", async (req, res, next) => {
  try {
    const result = await database.query(
      "SELECT * FROM goodboost_asset_listings WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 200",
      [req.user.id]
    );
    return res.json({ success: true, listings: result.rows.map(publicListing) });
  } catch (error) { return next(error); }
});

router.post("/listings", async (req, res, next) => {
  try {
    const platform = clean(req.body?.platform, 40);
    const assetType = clean(req.body?.assetType, 60);
    const handle = clean(req.body?.handle, 100);
    const profileUrl = clean(req.body?.profileUrl, 2048);
    const niche = clean(req.body?.niche, 100);
    const notes = clean(req.body?.notes, 2000);
    const followers = Number(req.body?.followers);
    const averageViews = Number(req.body?.averageViews);
    const engagementRate = Number(req.body?.engagementRate);
    const monthlyRevenue = Number(req.body?.monthlyRevenue);
    const askingPrice = Number(req.body?.askingPrice);
    if (!PLATFORMS.has(platform) || !assetType || !handle || !niche ||
        !Number.isInteger(followers) || followers < 0 || followers > 2000000000 ||
        !Number.isInteger(averageViews) || averageViews < 0 || averageViews > 2000000000 ||
        !Number.isFinite(engagementRate) || engagementRate < 0 || engagementRate > 100 ||
        !Number.isFinite(monthlyRevenue) || monthlyRevenue < 0 || monthlyRevenue > 1000000000 ||
        !Number.isFinite(askingPrice) || askingPrice < 0 || askingPrice > 1000000000 ||
        !validCampaignUrl(platform, profileUrl)) {
      return res.status(400).json({ success: false, code: "INVALID_LISTING", message: "Listing details are invalid." });
    }
    const policy = transferPolicy(platform, assetType);
    const estimated = valuation({ followers, averageViews, engagementRate, monthlyRevenue });
    const status = policy.eligibility === "Unsupported" ? "Draft" : "Ready for review";
    const result = await database.query(
      `INSERT INTO goodboost_asset_listings(
        user_id,platform,asset_type,handle,profile_url,niche,followers,average_views,
        engagement_rate,monthly_revenue,asking_price,valuation_low,valuation_high,
        transfer_eligibility,transfer_reason,status,notes
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [req.user.id, platform, assetType, handle, profileUrl, niche, followers, averageViews,
       engagementRate, monthlyRevenue, askingPrice, estimated.low, estimated.high,
       policy.eligibility, policy.reason, status, notes]
    );
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.listing.create", entityType: "asset_listing", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { platform, assetType, eligibility: policy.eligibility } }).catch(() => {});
    return res.status(201).json({ success: true, listing: publicListing(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const platform = clean(req.body?.platform, 40);
    const interaction = clean(req.body?.type, 40);
    const target = Number(req.body?.target);
    const url = clean(req.body?.url, 2048);
    const targeting = req.body?.targeting && typeof req.body.targeting === "object" ? req.body.targeting : {};
    if (!PLATFORMS.has(platform) || !INTERACTIONS.has(interaction) || !Number.isInteger(target) || target < 10 || target > 1000 || !validCampaignUrl(platform, url)) {
      return res.status(400).json({ success: false, code: "INVALID_CAMPAIGN", message: "Campaign platform, URL, interaction, or target is invalid." });
    }
    const safeTargeting = {
      countries: Array.isArray(targeting.countries) ? targeting.countries.map(value => clean(value, 80)).filter(Boolean).slice(0, 25) : [],
      interests: Array.isArray(targeting.interests) ? targeting.interests.map(value => clean(value, 80)).filter(Boolean).slice(0, 25) : [],
      verifiedOnly: targeting.verifiedOnly === true,
    };
    const result = await database.query(
      `INSERT INTO goodboost_campaigns(user_id,platform,content_url,interaction_type,target,targeting_json)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [req.user.id, platform, url, interaction, target, JSON.stringify(safeTargeting)]
    );
    await logAudit({ userId: req.user.id, appId: "goodboost", action: "goodboost.campaign.create", entityType: "campaign", entityId: result.rows[0].id, ipAddress: req.ip, metadata: { platform, interaction, target } }).catch(() => {});
    return res.status(201).json({ success: true, campaign: publicCampaign(result.rows[0]) });
  } catch (error) { return next(error); }
});

router.post("/activity", async (req, res, next) => {
  const client = await database.pool.connect();
  try {
    const description = clean(req.body?.description, 240);
    if (description.length < 2) return res.status(400).json({ success: false, message: "Activity description is required." });
    await client.query("BEGIN");
    await client.query("INSERT INTO goodboost_activity(user_id,description) VALUES($1,$2)", [req.user.id, description]);
    const boosted = await client.query(
      `UPDATE goodboost_campaigns SET current_count=LEAST(target,current_count+1),
       status=CASE WHEN current_count+1>=target THEN 'Completed' ELSE status END,updated_at=NOW()
       WHERE id=(SELECT id FROM goodboost_campaigns WHERE user_id=$1 AND status='Active' AND current_count<target ORDER BY created_at LIMIT 1)
       RETURNING *`, [req.user.id]
    );
    await client.query("COMMIT");
    const campaigns = await database.query("SELECT * FROM goodboost_campaigns WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500", [req.user.id]);
    return res.json({ success: true, user: {}, boostedCampaign: boosted.rows[0] ? publicCampaign(boosted.rows[0]) : null, campaigns: campaigns.rows.map(publicCampaign) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally { client.release(); }
});

router.patch("/profile", async (req, res, next) => {
  try {
    const settings = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : {};
    const webhook = clean(settings.webhookUrl, 2048);
    if (webhook) {
      let parsed;
      try { parsed = new URL(webhook); } catch { return res.status(400).json({ success: false, message: "Webhook URL is invalid." }); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return res.status(400).json({ success: false, message: "Webhook URL must use HTTPS and cannot contain credentials." });
    }
    const safeSettings = {
      emailNotifications: settings.emailNotifications !== false,
      dailyReports: settings.dailyReports !== false,
      webhookUrl: webhook || undefined,
    };
    const result = await database.query(
      `INSERT INTO goodboost_profiles(user_id,preferences_json) VALUES($1,$2::jsonb)
       ON CONFLICT(user_id) DO UPDATE SET preferences_json=$2::jsonb,updated_at=NOW() RETURNING *`,
      [req.user.id, JSON.stringify(safeSettings)]
    );
    return res.json({ success: true, profile: publicProfile(result.rows[0]) });
  } catch (error) { return next(error); }
});

module.exports = router;

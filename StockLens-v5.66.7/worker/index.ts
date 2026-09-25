/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import * as XLSX from "xlsx";
import { ebayReviewFingerprint } from "../lib/ebay-review-fingerprint";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  STOCKLENS_SERVICE_KEY?: string;
  STOCKLENS_ADMIN_KEY?: string;
  AMAZON_CREDENTIAL_ENCRYPTION_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const EBAY_ADMIN_COOKIE = "stocklens_ebay_admin";
const EBAY_ADMIN_SESSION_MS = 24 * 60 * 60 * 1000;

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const signAdminSession = async (expiresAt: number, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`stocklens:${expiresAt}`));
  return `${expiresAt}.${encodeBase64Url(new Uint8Array(signature))}`;
};

const signGoogleDriveState = async (expiresAt: number, secret: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`stocklens-google-drive:${expiresAt}`));
  return `${expiresAt}.${encodeBase64Url(new Uint8Array(signature))}`;
};

const validGoogleDriveState = async (state: string, secret: string) => {
  const [rawExpiry, suppliedSignature] = state.split(".");
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !suppliedSignature) return false;
  const expectedSignature = (await signGoogleDriveState(expiresAt, secret)).split(".")[1];
  if (expectedSignature.length !== suppliedSignature.length) return false;
  let difference = 0;
  for (let index = 0; index < expectedSignature.length; index += 1)
    difference |= expectedSignature.charCodeAt(index) ^ suppliedSignature.charCodeAt(index);
  return difference === 0;
};

const adminSessionExpiry = async (request: Request, env: Env) => {
  if (!env.STOCKLENS_ADMIN_KEY) return 0;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${EBAY_ADMIN_COOKIE}=`))?.slice(EBAY_ADMIN_COOKIE.length + 1) || "";
  const [rawExpiry, suppliedSignature] = token.split(".");
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !suppliedSignature) return 0;
  const expectedToken = await signAdminSession(expiresAt, env.STOCKLENS_ADMIN_KEY);
  const expectedSignature = expectedToken.split(".")[1];
  if (expectedSignature.length !== suppliedSignature.length) return 0;
  let difference = 0;
  for (let index = 0; index < expectedSignature.length; index += 1)
    difference |= expectedSignature.charCodeAt(index) ^ suppliedSignature.charCodeAt(index);
  return difference === 0 ? expiresAt : 0;
};

const hasEbayAdminAccess = async (request: Request, env: Env) =>
  !!env.STOCKLENS_ADMIN_KEY && (
    request.headers.get("x-stocklens-admin-key") === env.STOCKLENS_ADMIN_KEY
    || (await adminSessionExpiry(request, env)) > Date.now()
  );

type AmazonCredentials = { clientId: string; clientSecret: string; refreshToken: string };
type AmazonMarketplace = {
  id: string;
  name: string;
  countryCode: string;
  currencyCode: string;
  languageCode: string;
  domainName: string;
  participating: boolean;
  suspended: boolean;
};

type AmazonConnectionRow = {
  credentials_ciphertext: string;
  credentials_iv: string;
  region: string;
  marketplaces_json: string;
  connected_at: string;
  updated_at: string;
  last_tested_at: string;
};

type ShopifyConnectionRow = {
  shop_domain: string;
  shop_name: string;
  credentials_ciphertext: string;
  credentials_iv: string;
  scopes_json: string;
  connected_at: string;
  updated_at: string;
  last_tested_at: string;
};

type ShopifyCredentials = { clientId: string; clientSecret: string };
type GoogleDriveCredentials = { clientSecret: string; refreshToken: string };
type GoogleDriveConnectionRow = {
  credentials_ciphertext: string;
  credentials_iv: string;
  account_email: string;
  connected_at: string;
  updated_at: string;
  last_tested_at: string;
};
type ShopifyVariantSnapshotRow = {
  variantId: string;
  productId: string;
  sku: string;
  title: string;
  productTitle: string;
  productStatus: string;
  barcode: string;
};

const htmlEscape = (value: unknown) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

type EbayCommittedReviewRow = {
  listingId: string;
  ebaySku: string;
  title?: string;
  currentQuantity: number;
  recommendedQuantity: number;
  result?: string;
};

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const csvDownload = (fileName: string, headers: string[], rows: unknown[][]) => new Response(
  `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
  { headers: {
    "content-type": "text/csv;charset=utf-8",
    "content-disposition": `attachment; filename="${fileName.replace(/[^a-zA-Z0-9._-]+/g, "-")}"`,
    "cache-control": "no-store",
  } },
);

const decodeBase64 = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const encodeBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const amazonEncryptionKey = async (env: Env, usage: KeyUsage[]) => {
  if (!env.AMAZON_CREDENTIAL_ENCRYPTION_KEY)
    throw new Error("Amazon credential encryption is not configured");
  const raw = decodeBase64(env.AMAZON_CREDENTIAL_ENCRYPTION_KEY);
  if (raw.byteLength !== 32)
    throw new Error("Amazon credential encryption is not configured correctly");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usage);
};

const encryptAmazonCredentials = async (credentials: AmazonCredentials, env: Env) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await amazonEncryptionKey(env, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  return { ciphertext: encodeBase64(new Uint8Array(ciphertext)), iv: encodeBase64(iv) };
};

const decryptAmazonCredentials = async (row: AmazonConnectionRow, env: Env) => {
  const key = await amazonEncryptionKey(env, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(row.credentials_iv) },
    key,
    decodeBase64(row.credentials_ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as AmazonCredentials;
};

const encryptShopifyCredentials = async (credentials: ShopifyCredentials, env: Env) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await amazonEncryptionKey(env, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(credentials)));
  return { ciphertext: encodeBase64(new Uint8Array(ciphertext)), iv: encodeBase64(iv) };
};

const decryptShopifyCredentials = async (row: ShopifyConnectionRow, env: Env) => {
  const key = await amazonEncryptionKey(env, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(row.credentials_iv) }, key, decodeBase64(row.credentials_ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as ShopifyCredentials;
};

const encryptGoogleDriveCredentials = async (credentials: GoogleDriveCredentials, env: Env) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await amazonEncryptionKey(env, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(credentials)));
  return { ciphertext: encodeBase64(new Uint8Array(ciphertext)), iv: encodeBase64(iv) };
};

const decryptGoogleDriveCredentials = async (row: GoogleDriveConnectionRow, env: Env) => {
  const key = await amazonEncryptionKey(env, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(row.credentials_iv) }, key, decodeBase64(row.credentials_ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as GoogleDriveCredentials;
};

const amazonErrorMessage = (payload: unknown, fallback: string) => {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error_description === "string") return record.error_description;
  if (typeof record.message === "string") return record.message;
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const first = errors[0] as Record<string, unknown> | undefined;
  return typeof first?.message === "string" ? first.message : fallback;
};

const getAmazonAccessToken = async (credentials: AmazonCredentials) => {
  const tokenResponse = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string")
    throw new Error(amazonErrorMessage(tokenPayload, `Amazon authorization failed (${tokenResponse.status})`));
  return tokenPayload.access_token;
};

const verifyAmazonConnection = async (credentials: AmazonCredentials) => {
  const accessToken = await getAmazonAccessToken(credentials);
  const marketplaceResponse = await fetch("https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations", {
    headers: { accept: "application/json", "x-amz-access-token": accessToken },
  });
  const marketplacePayload = await marketplaceResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!marketplaceResponse.ok)
    throw new Error(amazonErrorMessage(marketplacePayload, `Amazon marketplace verification failed (${marketplaceResponse.status})`));
  const records = Array.isArray(marketplacePayload.payload) ? marketplacePayload.payload : [];
  return records.map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const marketplace = record.marketplace && typeof record.marketplace === "object" ? record.marketplace as Record<string, unknown> : {};
    const participation = record.participation && typeof record.participation === "object" ? record.participation as Record<string, unknown> : {};
    return {
      id: String(marketplace.id || ""),
      name: String(marketplace.name || marketplace.countryCode || marketplace.id || "Amazon marketplace"),
      countryCode: String(marketplace.countryCode || ""),
      currencyCode: String(marketplace.defaultCurrencyCode || ""),
      languageCode: String(marketplace.defaultLanguageCode || ""),
      domainName: String(marketplace.domainName || ""),
      participating: participation.isParticipating === true,
      suspended: participation.hasSuspendedListings === true,
    } satisfies AmazonMarketplace;
  });
};

const amazonApiJson = async (url: URL, accessToken: string) => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, { headers: { accept: "application/json", "x-amz-access-token": accessToken } });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) return payload;
    if (response.status !== 429 || attempt === 5)
      throw new Error(amazonErrorMessage(payload, `Amazon inventory could not be read (${response.status})`));
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error("Amazon inventory could not be read");
};

const getAmazonInventory = async (row: AmazonConnectionRow, env: Env, requestedMarketplaceId: string) => {
  const credentials = await decryptAmazonCredentials(row, env);
  const accessToken = await getAmazonAccessToken(credentials);
  let marketplaces: AmazonMarketplace[] = [];
  try { marketplaces = JSON.parse(row.marketplaces_json || "[]") as AmazonMarketplace[]; } catch { marketplaces = []; }
  const eligible = marketplaces.filter((marketplace) => marketplace.participating && !marketplace.suspended);
  const preferred = eligible.find((marketplace) => marketplace.id === "ATVPDKIKX0DER") || eligible[0] || marketplaces[0];
  const marketplace = marketplaces.find((entry) => entry.id === requestedMarketplaceId) || preferred;
  if (!marketplace?.id) throw new Error("No authorized Amazon marketplace is available for inventory.");

  const summaries: Array<Record<string, unknown>> = [];
  let nextToken = "";
  for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
    const url = new URL("https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries");
    url.searchParams.set("details", "true");
    url.searchParams.set("granularityType", "Marketplace");
    url.searchParams.set("granularityId", marketplace.id);
    url.searchParams.append("marketplaceIds", marketplace.id);
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const response = await amazonApiJson(url, accessToken);
    const payload = response.payload && typeof response.payload === "object" ? response.payload as Record<string, unknown> : {};
    const page = Array.isArray(payload.inventorySummaries) ? payload.inventorySummaries : [];
    summaries.push(...page.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object"));
    const pagination = response.pagination && typeof response.pagination === "object" ? response.pagination as Record<string, unknown> : {};
    nextToken = typeof pagination.nextToken === "string" ? pagination.nextToken : "";
    if (!nextToken) break;
  }
  return { marketplace, marketplaces, summaries, retrievedAt: new Date().toISOString() };
};

type AmazonInboundHistoryRow = {
  inboundPlanId: string;
  shipmentId: string;
  planStatus: string;
  shipmentStatus: string;
  createdAt: string;
  lastUpdatedAt: string;
  fnSku: string;
  sellerSku: string;
  asin: string;
  quantity: number;
  quantityReceived: number | null;
};

const amazonInboundApiJson = async (url: URL, accessToken: string) => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(url, { headers: { accept: "application/json", "x-amz-access-token": accessToken } });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.ok) return payload;
    if (response.status === 403)
      throw new Error("Amazon denied Fulfillment Inbound access. Update the Amazon app authorization so StockLens can read inbound plans and shipment items, then generate a new refresh token.");
    if (response.status !== 429 || attempt === 6)
      throw new Error(amazonErrorMessage(payload, `Amazon inbound shipments could not be read (${response.status})`));
    const waitMs = Math.max(750, retryAfterSeconds(response.headers.get("retry-after")) * 1000, attempt * 750);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error("Amazon inbound shipments could not be read");
};

const isUnsupportedNonFbaInboundPlan = (error: unknown) => {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("getinboundplan is not supported")
    && (message.includes("amazon warehousing and distribution") || message.includes("amazon global logistics"));
};

const getAmazonInboundHistory = async (
  row: AmazonConnectionRow,
  env: Env,
  requestedMarketplaceId: string,
  requestedStartDate: string,
  requestedEndDate: string,
  forceRefresh = false,
) => {
  let marketplaces: AmazonMarketplace[] = [];
  try { marketplaces = JSON.parse(row.marketplaces_json || "[]") as AmazonMarketplace[]; } catch { marketplaces = []; }
  const marketplace = marketplaces.find((entry) => entry.id === requestedMarketplaceId)
    || marketplaces.find((entry) => entry.id === "ATVPDKIKX0DER")
    || marketplaces.find((entry) => entry.participating && !entry.suspended)
    || marketplaces[0];
  if (!marketplace?.id) throw new Error("No authorized Amazon marketplace is available for inbound shipments.");

  const startTime = Date.parse(requestedStartDate);
  const endTime = Date.parse(requestedEndDate);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime)
    throw new Error("Amazon inbound history dates are invalid.");

  const cached = await env.DB.prepare(`SELECT start_date, end_date, rows_json, plan_count, shipment_count, retrieved_at
    FROM amazon_inbound_history_cache WHERE marketplace_id = ? AND start_date <= ? AND end_date >= ?`)
    .bind(marketplace.id, requestedStartDate, requestedEndDate)
    .first<{ start_date: string; end_date: string; rows_json: string; plan_count: number; shipment_count: number; retrieved_at: string }>();
  if (!forceRefresh && cached?.rows_json) {
    try {
      const rows = JSON.parse(cached.rows_json) as AmazonInboundHistoryRow[];
      if (Array.isArray(rows)) return {
        marketplace, rows, planCount: cached.plan_count, shipmentCount: cached.shipment_count,
        retrievedAt: cached.retrieved_at, cached: true,
      };
    } catch { /* Ignore a damaged cache row and refresh only this inbound dataset. */ }
  }

  const credentials = await decryptAmazonCredentials(row, env);
  const accessToken = await getAmazonAccessToken(credentials);

  const planSummaries = new Map<string, Record<string, unknown>>();
  for (const status of ["ACTIVE", "SHIPPED", "VOIDED"]) {
    let paginationToken = "";
    for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
      const url = new URL("https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans");
      url.searchParams.set("status", status);
      url.searchParams.set("sortBy", status === "ACTIVE" ? "CREATION_TIME" : "LAST_UPDATED_TIME");
      url.searchParams.set("sortOrder", "DESC");
      url.searchParams.set("pageSize", "30");
      if (paginationToken) url.searchParams.set("paginationToken", paginationToken);
      const payload = await amazonInboundApiJson(url, accessToken);
      const plans = Array.isArray(payload.inboundPlans)
        ? payload.inboundPlans.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        : [];
      for (const plan of plans) {
        const planId = String(plan.inboundPlanId || "");
        const createdAt = Date.parse(String(plan.createdAt || ""));
        const lastUpdatedAt = Date.parse(String(plan.lastUpdatedAt || ""));
        const planMarketplaces = Array.isArray(plan.marketplaceIds) ? plan.marketplaceIds.map(String) : [];
        if (planId && createdAt <= endTime && (status === "ACTIVE" || !Number.isFinite(lastUpdatedAt) || lastUpdatedAt >= startTime)
          && (!planMarketplaces.length || planMarketplaces.includes(marketplace.id))) planSummaries.set(planId, plan);
      }
      const pagination = payload.pagination && typeof payload.pagination === "object" ? payload.pagination as Record<string, unknown> : {};
      paginationToken = typeof pagination.nextToken === "string" ? pagination.nextToken : "";
      const terminalHistoryExhausted = status !== "ACTIVE" && plans.length > 0
        && plans.every((plan) => Date.parse(String(plan.lastUpdatedAt || "")) < startTime);
      if (!paginationToken || terminalHistoryExhausted) break;
    }
  }

  const rows: AmazonInboundHistoryRow[] = [];
  let shipmentCount = 0;
  let processedPlanCount = 0;
  let skippedUnsupportedPlanCount = 0;
  for (const summary of planSummaries.values()) {
    const inboundPlanId = String(summary.inboundPlanId || "");
    let planPayload: Record<string, unknown>;
    try {
      planPayload = await amazonInboundApiJson(new URL(`https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}`), accessToken);
    } catch (error) {
      if (!isUnsupportedNonFbaInboundPlan(error)) throw error;
      skippedUnsupportedPlanCount += 1;
      continue;
    }
    processedPlanCount += 1;
    const createdAt = String(planPayload.createdAt || summary.createdAt || "");
    const lastUpdatedAt = String(planPayload.lastUpdatedAt || summary.lastUpdatedAt || createdAt);
    const planStatus = String(planPayload.status || summary.status || "");
    const shipments = Array.isArray(planPayload.shipments)
      ? planPayload.shipments.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      : [];
    for (const shipment of shipments) {
      const shipmentId = String(shipment.shipmentId || "");
      if (!shipmentId) continue;
      shipmentCount += 1;
      const receivingByFnSku = new Map<string, { shipped: number; received: number }>();
      if (String(shipment.status || "").toUpperCase() === "RECEIVING") {
        try {
          let legacyNextToken = "";
          for (let legacyPage = 0; legacyPage < 100; legacyPage += 1) {
            const legacyUrl = new URL(`https://sellingpartnerapi-na.amazon.com/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`);
            if (legacyNextToken) legacyUrl.searchParams.set("NextToken", legacyNextToken);
            const legacyResponse = await amazonInboundApiJson(legacyUrl, accessToken);
            const payload = legacyResponse.payload && typeof legacyResponse.payload === "object" ? legacyResponse.payload as Record<string, unknown> : legacyResponse;
            const legacyItems = Array.isArray(payload.ItemData) ? payload.ItemData : Array.isArray(payload.itemData) ? payload.itemData : [];
            for (const legacyItem of legacyItems) {
              if (!legacyItem || typeof legacyItem !== "object") continue;
              const item = legacyItem as Record<string, unknown>, key = String(item.FulfillmentNetworkSKU || item.fulfillmentNetworkSKU || "").trim().toUpperCase();
              if (!key) continue;
              const existing = receivingByFnSku.get(key) || { shipped: 0, received: 0 };
              existing.shipped += Math.max(0, Number(item.QuantityShipped ?? item.quantityShipped) || 0);
              existing.received += Math.max(0, Number(item.QuantityReceived ?? item.quantityReceived) || 0);
              receivingByFnSku.set(key, existing);
            }
            legacyNextToken = String(payload.NextToken || payload.nextToken || "");
            if (!legacyNextToken) break;
          }
        } catch { /* Fall back to the current shipment item quantity if legacy receiving detail is unavailable. */ }
      }
      let paginationToken = "";
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const itemsUrl = new URL(`https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/items`);
        itemsUrl.searchParams.set("pageSize", "1000");
        if (paginationToken) itemsUrl.searchParams.set("paginationToken", paginationToken);
        const itemsPayload = await amazonInboundApiJson(itemsUrl, accessToken);
        const items = Array.isArray(itemsPayload.items)
          ? itemsPayload.items.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
          : [];
        for (const item of items) {
          const fnSku = String(item.fnsku || item.fnSku || ""), receiving = receivingByFnSku.get(fnSku.trim().toUpperCase());
          rows.push({
            inboundPlanId,
            shipmentId,
            planStatus,
            shipmentStatus: String(shipment.status || ""),
            createdAt,
            lastUpdatedAt: String(shipment.lastUpdatedAt || shipment.updatedAt || lastUpdatedAt),
            fnSku,
            sellerSku: String(item.msku || item.sellerSku || ""),
            asin: String(item.asin || ""),
            quantity: receiving?.shipped || Math.max(0, Number(item.quantity) || 0),
            quantityReceived: receiving ? receiving.received : Number.isFinite(Number(item.quantityReceived)) ? Math.max(0, Number(item.quantityReceived)) : null,
          });
        }
        const pagination = itemsPayload.pagination && typeof itemsPayload.pagination === "object" ? itemsPayload.pagination as Record<string, unknown> : {};
        paginationToken = typeof pagination.nextToken === "string" ? pagination.nextToken : "";
        if (!paginationToken) break;
      }
    }
  }

  const retrievedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO amazon_inbound_history_cache
    (marketplace_id, start_date, end_date, rows_json, plan_count, shipment_count, retrieved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(marketplace_id) DO UPDATE SET start_date = excluded.start_date,
    end_date = excluded.end_date, rows_json = excluded.rows_json, plan_count = excluded.plan_count,
    shipment_count = excluded.shipment_count, retrieved_at = excluded.retrieved_at`)
    .bind(marketplace.id, requestedStartDate, requestedEndDate, JSON.stringify(rows), processedPlanCount, shipmentCount, retrievedAt).run();
  return {
    marketplace, rows, planCount: processedPlanCount, discoveredPlanCount: planSummaries.size,
    skippedUnsupportedPlanCount, shipmentCount, retrievedAt, cached: false,
  };
};

class AmazonReportsError extends Error {
  status: number;
  retryAfterSeconds: number;
  rateLimit: string;

  constructor(message: string, status: number, retryAfterSeconds = 0, rateLimit = "") {
    super(message);
    this.name = "AmazonReportsError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.rateLimit = rateLimit;
  }
}

const retryAfterSeconds = (value: string | null) => {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 0;
};

const amazonReportsErrorResponse = (error: unknown, fallback: string) => {
  console.error("Amazon Reports API operation failed", error instanceof Error ? error.message : fallback);
  if (error instanceof AmazonReportsError && error.status === 429)
    return Response.json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds || 65, rateLimit: error.rateLimit }, {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": String(error.retryAfterSeconds || 65) },
    });
  return Response.json({ error: error instanceof Error ? error.message : fallback }, {
    status: 502,
    headers: { "cache-control": "no-store" },
  });
};

const amazonReportsRequest = async (url: string, accessToken: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", "x-amz-access-token": accessToken, ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const rateLimit = response.headers.get("x-amzn-ratelimit-limit") || "";
  if (response.ok) return { payload, rateLimit };
  if (response.status === 403)
    throw new AmazonReportsError("Amazon denied the requested Reports API resource. Add the Amazon Fulfillment role to the StockLens Amazon app, save the registration, generate a new refresh token, and update the Amazon connection. Restock Inventory and Inventory Ledger reports require this authorization.", 403, 0, rateLimit);
  const waitSeconds = response.status === 429
    ? Math.max(65, retryAfterSeconds(response.headers.get("retry-after")))
    : 0;
  throw new AmazonReportsError(
    amazonErrorMessage(payload, response.status === 429 ? "Amazon's Reports API quota is temporarily full." : `Amazon report request failed (${response.status})`),
    response.status,
    waitSeconds,
    rateLimit,
  );
};

type AmazonReportJobRow = {
  month_key: string;
  marketplace_id: string;
  start_date: string;
  end_date: string;
  report_id: string;
  processing_status: string;
  rate_limit: string;
  created_at: string;
  updated_at: string;
};

type AmazonReportCacheRow = {
  report_id: string;
  month_key: string;
  marketplace_id: string;
  rows_json: string;
  raw_row_count: number;
  sellable_row_count: number;
  sellable_units: number;
  parser_version: number;
  retrieved_at: string;
};

const startAmazonInventoryLedgerReport = async (row: AmazonConnectionRow, env: Env, requestedMarketplaceId: string, startDate: string, endDate: string, reuseOnly = false) => {
  let marketplaces: AmazonMarketplace[] = [];
  try { marketplaces = JSON.parse(row.marketplaces_json || "[]") as AmazonMarketplace[]; } catch { marketplaces = []; }
  const marketplace = marketplaces.find((entry) => entry.id === requestedMarketplaceId)
    || marketplaces.find((entry) => entry.id === "ATVPDKIKX0DER")
    || marketplaces.find((entry) => entry.participating && !entry.suspended);
  if (!marketplace?.id) throw new Error("No authorized Amazon marketplace is available for the inventory ledger report.");
  const monthKey = startDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error("Amazon inventory report month is invalid.");
  const existing = await env.DB.prepare(`SELECT month_key, marketplace_id, start_date, end_date, report_id,
    processing_status, rate_limit, created_at, updated_at FROM amazon_inventory_report_job
    WHERE month_key = ? AND marketplace_id = ?`).bind(monthKey, marketplace.id).first<AmazonReportJobRow>();
  const reusableStatuses = new Set(["IN_QUEUE", "IN_PROGRESS", "DONE"]);
  const reuseCutoff = Date.now() - 80 * 24 * 60 * 60 * 1000;
  if (existing?.report_id && reusableStatuses.has(existing.processing_status) && (reuseOnly || Date.parse(existing.updated_at) >= reuseCutoff)) {
    const cached = await env.DB.prepare("SELECT report_id FROM amazon_inventory_report_cache WHERE report_id = ? AND parser_version = 3")
      .bind(existing.report_id).first<{ report_id: string }>();
    return { reportId: existing.report_id, marketplace, reused: true, cached: !!cached, processingStatus: existing.processing_status, rateLimit: existing.rate_limit || "" };
  }
  const stoppedSavedReport = !!existing?.report_id && ["CANCELLED", "FATAL"].includes(existing.processing_status);
  if (reuseOnly && !stoppedSavedReport)
    throw new Error(`No reusable saved Amazon report was found for ${monthKey}. Run a new Amazon quantity fetch only if this month was never downloaded.`);

  const latest = await env.DB.prepare("SELECT created_at FROM amazon_inventory_report_job ORDER BY created_at DESC LIMIT 1")
    .first<{ created_at: string }>();
  const secondsSinceCreate = latest?.created_at ? (Date.now() - Date.parse(latest.created_at)) / 1000 : Number.POSITIVE_INFINITY;
  if (Number.isFinite(secondsSinceCreate) && secondsSinceCreate < 65)
    throw new AmazonReportsError("StockLens is pacing Amazon report requests to stay within the createReport quota.", 429, Math.ceil(65 - secondsSinceCreate), "0.0167");

  const credentials = await decryptAmazonCredentials(row, env);
  const accessToken = await getAmazonAccessToken(credentials);
  const { payload, rateLimit } = await amazonReportsRequest("https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports", accessToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reportType: "GET_LEDGER_SUMMARY_VIEW_DATA",
      marketplaceIds: [marketplace.id],
      dataStartTime: startDate,
      dataEndTime: endDate,
      reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "MONTHLY" },
    }),
  });
  if (!payload.reportId) throw new Error("Amazon did not return an inventory ledger report ID.");
  const reportId = String(payload.reportId), now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO amazon_inventory_report_job
    (month_key, marketplace_id, start_date, end_date, report_id, processing_status, rate_limit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'IN_QUEUE', ?, ?, ?)
    ON CONFLICT(month_key, marketplace_id) DO UPDATE SET start_date = excluded.start_date,
    end_date = excluded.end_date, report_id = excluded.report_id, processing_status = excluded.processing_status,
    rate_limit = excluded.rate_limit, created_at = excluded.created_at, updated_at = excluded.updated_at`)
    .bind(monthKey, marketplace.id, startDate, endDate, reportId, rateLimit, now, now).run();
  return { reportId, marketplace, reused: false, processingStatus: "IN_QUEUE", rateLimit };
};

const parseDelimitedReport = (text: string) => {
  // Amazon's Inventory Ledger is TSV, not RFC-style CSV. Product titles and
  // seller SKUs frequently contain literal inch marks (") that must not toggle
  // quote parsing or subsequent rows are swallowed into the title field.
  // Amazon still wraps each individual TSV cell in quotes, so remove only the
  // matching outer pair after splitting on tabs. Interior inch marks remain.
  const decodeCell = (cell: string) => {
    const value = cell.trim();
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1).replaceAll('""', '"')
      : value;
  };
  return text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)
    .map((line) => line.split("\t").map(decodeCell))
    .filter((cells) => cells.some((cell) => cell !== ""));
};

const parseAmazonInventoryLedger = (text: string) => {
  const records = parseDelimitedReport(text);
  const headings = (records.shift() || []).map((heading) => heading.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!headings.includes("fnsku") || !headings.includes("disposition") || !headings.includes("endingwarehousebalance"))
    throw new Error("The selected file is not an Amazon Inventory Ledger Summary report.");
  const dispositionValues = new Set(["SELLABLE", "DEFECTIVE", "CARRIER_DAMAGED", "CUSTOMER_DAMAGED", "DISTRIBUTOR_DAMAGED", "WAREHOUSE_DAMAGED", "EXPIRED", "DAMAGED"]);
  const normalizeCells = (rawCells: string[]) => {
    if (rawCells.length <= headings.length) return [...rawCells, ...Array.from({ length: Math.max(0, headings.length - rawCells.length) }, () => "")];
    // A few Amazon rows contain an actual tab inside the title. Locate the
    // disposition column and fold any overflow between MSKU and disposition
    // back into Title so every quantity column remains aligned.
    const actualDispositionIndex = rawCells.findIndex((cell, index) => index >= 4 && dispositionValues.has(String(cell || "").trim().toUpperCase()));
    if (actualDispositionIndex >= 5) {
      const repaired = [...rawCells.slice(0, 4), rawCells.slice(4, actualDispositionIndex).filter(Boolean).join(" "), ...rawCells.slice(actualDispositionIndex)];
      return repaired.slice(0, headings.length);
    }
    return [...rawCells.slice(0, 4), rawCells.slice(4, rawCells.length - (headings.length - 5)).join(" "), ...rawCells.slice(-(headings.length - 5))];
  };
  const field = (cells: string[], ...aliases: string[]) => {
    const wanted = aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const index = headings.findIndex((heading) => wanted.includes(heading));
    return index >= 0 ? String(cells[index] || "").trim() : "";
  };
  const reportNumber = (value: string) => {
    const parsed = Number(value.replaceAll(",", "").replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const rows = records.map((rawCells) => {
    const cells = normalizeCells(rawCells);
    return {
      date: field(cells, "Date"), fnSku: field(cells, "FNSKU"), asin: field(cells, "ASIN"), sellerSku: field(cells, "MSKU", "SKU"),
      title: field(cells, "Title"), disposition: field(cells, "Disposition"), location: field(cells, "Location"),
      receipts: reportNumber(field(cells, "Receipts")),
      customerShipments: reportNumber(field(cells, "CustomerShipments")),
      customerReturns: reportNumber(field(cells, "CustomerReturns")),
      vendorReturns: reportNumber(field(cells, "VendorReturns")),
      warehouseTransferInOut: reportNumber(field(cells, "WarehouseTransferInOut")),
      found: reportNumber(field(cells, "Found")), lost: reportNumber(field(cells, "Lost")),
      damaged: reportNumber(field(cells, "Damaged")), disposed: reportNumber(field(cells, "Disposed")),
      otherEvents: reportNumber(field(cells, "OtherEvents")), unknownEvents: reportNumber(field(cells, "UnknownEvents")),
      endingWarehouseBalance: reportNumber(field(cells, "EndingWarehouseBalance")),
      inTransitBetweenWarehouses: reportNumber(field(cells, "InTransitBetweenWarehouses")),
    };
  }).filter((entry) => entry.fnSku);
  const sellableRows = rows.filter((entry) => entry.disposition.trim().toUpperCase() === "SELLABLE");
  const sellableUnits = sellableRows.reduce((sum, entry) => sum + Math.max(0, entry.endingWarehouseBalance) + Math.max(0, entry.inTransitBetweenWarehouses), 0);
  if (!rows.length || !sellableRows.length) throw new Error("The Amazon Inventory Ledger contains no usable SELLABLE rows.");
  return { rows, rawRowCount: records.length, sellableRowCount: sellableRows.length, sellableUnits };
};

const cacheAmazonInventoryLedger = async (env: Env, reportId: string, monthKey: string, marketplaceId: string, parsed: ReturnType<typeof parseAmazonInventoryLedger>) => {
  const retrievedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO amazon_inventory_report_cache
    (report_id, month_key, marketplace_id, rows_json, raw_row_count, sellable_row_count, sellable_units, parser_version, retrieved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 3, ?)
    ON CONFLICT(report_id) DO UPDATE SET month_key = excluded.month_key,
    marketplace_id = excluded.marketplace_id, rows_json = excluded.rows_json,
    raw_row_count = excluded.raw_row_count, sellable_row_count = excluded.sellable_row_count,
    sellable_units = excluded.sellable_units, parser_version = excluded.parser_version,
    retrieved_at = excluded.retrieved_at`)
    .bind(reportId, monthKey, marketplaceId, JSON.stringify(parsed.rows), parsed.rawRowCount, parsed.sellableRowCount, parsed.sellableUnits, retrievedAt).run();
  return retrievedAt;
};

const getAmazonInventoryLedgerReport = async (row: AmazonConnectionRow, env: Env, reportId: string) => {
  const cached = await env.DB.prepare(`SELECT report_id, month_key, marketplace_id, rows_json, raw_row_count,
    sellable_row_count, sellable_units, parser_version, retrieved_at
    FROM amazon_inventory_report_cache WHERE report_id = ? AND parser_version = 3`)
    .bind(reportId).first<AmazonReportCacheRow>();
  if (cached?.rows_json) {
    try {
      const rows = JSON.parse(cached.rows_json) as Array<Record<string, unknown>>;
      if (Array.isArray(rows)) return {
        processingStatus: "DONE", reportId, rows, cached: true,
        rawRowCount: cached.raw_row_count, sellableRowCount: cached.sellable_row_count,
        sellableUnits: cached.sellable_units, retrievedAt: cached.retrieved_at,
      };
    } catch { /* Ignore a damaged cache row and rebuild it from the saved Amazon report ID. */ }
  }
  const credentials = await decryptAmazonCredentials(row, env);
  const accessToken = await getAmazonAccessToken(credentials);
  let statusResponse: Awaited<ReturnType<typeof amazonReportsRequest>>;
  try {
    statusResponse = await amazonReportsRequest(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, accessToken);
  } catch (error) {
    if (error instanceof AmazonReportsError)
      throw new AmazonReportsError(`Amazon report-status check failed for the saved report: ${error.message}`, error.status, error.retryAfterSeconds, error.rateLimit);
    throw new Error(`Amazon report-status check failed for the saved report: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const status = statusResponse.payload;
  const processingStatus = String(status.processingStatus || "IN_PROGRESS");
  await env.DB.prepare("UPDATE amazon_inventory_report_job SET processing_status = ?, rate_limit = CASE WHEN ? = '' THEN rate_limit ELSE ? END, updated_at = ? WHERE report_id = ?")
    .bind(processingStatus, statusResponse.rateLimit, statusResponse.rateLimit, new Date().toISOString(), reportId).run();
  if (processingStatus !== "DONE") return { processingStatus, reportId, rateLimit: statusResponse.rateLimit };
  const documentId = String(status.reportDocumentId || "");
  if (!documentId) throw new Error("Amazon completed the report without a document ID.");
  let documentResponse: Awaited<ReturnType<typeof amazonReportsRequest>>;
  try {
    documentResponse = await amazonReportsRequest(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`, accessToken);
  } catch (error) {
    if (error instanceof AmazonReportsError)
      throw new AmazonReportsError(`Amazon completed the report, but its document details could not be retrieved: ${error.message}`, error.status, error.retryAfterSeconds, error.rateLimit);
    throw new Error(`Amazon completed the report, but its document details could not be retrieved: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const document = documentResponse.payload;
  const downloadUrl = String(document.url || "");
  if (!downloadUrl) throw new Error("Amazon completed the report without a download URL.");
  const download = await fetch(downloadUrl);
  if (!download.ok || !download.body) throw new Error(`Amazon completed the report, but the inventory ledger download failed (HTTP ${download.status}).`);
  const stream = String(document.compressionAlgorithm || "").toUpperCase() === "GZIP"
    ? download.body.pipeThrough(new DecompressionStream("gzip"))
    : download.body;
  const text = await new Response(stream).text();
  let parsed: ReturnType<typeof parseAmazonInventoryLedger>;
  try { parsed = parseAmazonInventoryLedger(text); }
  catch (error) { throw new Error(`Amazon inventory ledger parsing failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  const reportJob = await env.DB.prepare("SELECT month_key, marketplace_id FROM amazon_inventory_report_job WHERE report_id = ?")
    .bind(reportId).first<{ month_key: string; marketplace_id: string }>();
  let retrievedAt = new Date().toISOString();
  if (reportJob?.month_key && reportJob.marketplace_id) {
    try { retrievedAt = await cacheAmazonInventoryLedger(env, reportId, reportJob.month_key, reportJob.marketplace_id, parsed); }
    catch (error) { throw new Error(`Amazon inventory ledger was downloaded, but its reusable cache could not be saved: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
  return {
    processingStatus, reportId, rows: parsed.rows, cached: false, rawRowCount: parsed.rawRowCount,
    sellableRowCount: parsed.sellableRowCount, sellableUnits: parsed.sellableUnits, retrievedAt,
    rateLimit: statusResponse.rateLimit || documentResponse.rateLimit,
  };
};

type AmazonReplenishmentJobRow = {
  marketplace_id: string;
  report_id: string;
  processing_status: string;
  rate_limit: string;
  created_at: string;
  updated_at: string;
};

type AmazonReplenishmentCacheRow = {
  report_id: string;
  marketplace_id: string;
  rows_json: string;
  row_count: number;
  retrieved_at: string;
};

const replenishmentNumber = (value: string) => {
  const parsed = Number(String(value || "").replaceAll(",", "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseAmazonReplenishmentReport = (text: string) => {
  const records = parseDelimitedReport(text);
  const headings = (records.shift() || []).map((heading) => heading.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  const indexFor = (...aliases: string[]) => {
    const wanted = aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]/g, ""));
    return headings.findIndex((heading) => wanted.includes(heading));
  };
  const fnSkuIndex = indexFor("FNSKU");
  const sellerSkuIndex = indexFor("Merchant SKU", "Seller SKU", "MSKU", "SKU");
  const recommendedIndex = indexFor("Recommended replenishment qty", "Recommended replenishment quantity");
  if (fnSkuIndex < 0 || sellerSkuIndex < 0 || recommendedIndex < 0)
    throw new Error("Amazon returned a Restock Inventory report without FNSKU, Merchant SKU, or Recommended replenishment qty.");
  const cell = (row: string[], ...aliases: string[]) => {
    const index = indexFor(...aliases);
    return index >= 0 ? String(row[index] || "").trim() : "";
  };
  const rows = records.map((row, index) => ({
    key: `${cell(row, "FNSKU")}:${cell(row, "Merchant SKU", "Seller SKU", "MSKU", "SKU")}:${cell(row, "ASIN")}:${index}`,
    country: cell(row, "Country"),
    productName: cell(row, "Product Name"),
    fnSku: cell(row, "FNSKU"),
    sellerSku: cell(row, "Merchant SKU", "Seller SKU", "MSKU", "SKU"),
    barcode: cell(row, "Barcode"),
    asin: cell(row, "ASIN"),
    condition: cell(row, "Condition"),
    supplier: cell(row, "Supplier"),
    price: replenishmentNumber(cell(row, "Price")),
    salesLast30Days: replenishmentNumber(cell(row, "Sales last 30 days")),
    unitsSoldLast30Days: replenishmentNumber(cell(row, "Units Sold Last 30 Days")),
    totalUnits: replenishmentNumber(cell(row, "Total Units")),
    inbound: replenishmentNumber(cell(row, "Inbound")),
    available: replenishmentNumber(cell(row, "Available")),
    fcTransfer: replenishmentNumber(cell(row, "FC transfer")),
    fcProcessing: replenishmentNumber(cell(row, "FC Processing")),
    customerOrder: replenishmentNumber(cell(row, "Customer Order")),
    unfulfillable: replenishmentNumber(cell(row, "Unfulfillable")),
    working: replenishmentNumber(cell(row, "Working")),
    shipped: replenishmentNumber(cell(row, "Shipped")),
    receiving: replenishmentNumber(cell(row, "Receiving")),
    fulfilledBy: cell(row, "Fulfilled by"),
    totalDaysOfSupply: replenishmentNumber(cell(row, "Total Days of Supply", "Total Days of Supply including units from open shipments")),
    afnDaysOfSupply: replenishmentNumber(cell(row, "Days of Supply at Amazon Fulfillment Network")),
    alert: cell(row, "Alert"),
    recommendedReplenishmentQty: replenishmentNumber(cell(row, "Recommended replenishment qty", "Recommended replenishment quantity")),
    recommendedShipDate: cell(row, "Recommended ship date"),
    recommendedAction: cell(row, "Recommended Action"),
    unitStorageSize: cell(row, "Unit Storage Size"),
    advertisingCostRaw: cell(row, "adv cst", "Advertising Cost", "Advertising Spend"),
    storageCostRaw: cell(row, "storage cost", "Estimated Storage Cost"),
    profitabilityRaw: cell(row, "profitability (pft/cst)", "pft/cst", "Profitability"),
    obsJune25: cell(row, "Obs June 25", "Observation June 25", "Observations June 25"),
  })).filter((entry) => entry.fnSku || entry.sellerSku || entry.asin);
  if (!rows.length) throw new Error("The Amazon Restock Inventory report contains no usable listings.");
  return rows;
};

const amazonMarketplace = (row: AmazonConnectionRow, requestedMarketplaceId: string) => {
  let marketplaces: AmazonMarketplace[] = [];
  try { marketplaces = JSON.parse(row.marketplaces_json || "[]") as AmazonMarketplace[]; } catch { marketplaces = []; }
  return marketplaces.find((entry) => entry.id === requestedMarketplaceId)
    || marketplaces.find((entry) => entry.id === "ATVPDKIKX0DER")
    || marketplaces.find((entry) => entry.participating && !entry.suspended);
};

const amazonReplenishmentBusinessDay = (value: string | number | Date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const startAmazonReplenishmentReport = async (row: AmazonConnectionRow, env: Env, requestedMarketplaceId: string, _forceRefresh = false) => {
  const marketplace = amazonMarketplace(row, requestedMarketplaceId);
  if (!marketplace?.id) throw new Error("No authorized Amazon marketplace is available for replenishment recommendations.");
  const today = amazonReplenishmentBusinessDay();
  const dailyCache = await env.DB.prepare(`SELECT report_id, marketplace_id, rows_json, row_count, retrieved_at
    FROM amazon_replenishment_report_cache WHERE marketplace_id = ? ORDER BY retrieved_at DESC LIMIT 1`)
    .bind(marketplace.id).first<AmazonReplenishmentCacheRow>();
  if (dailyCache?.rows_json && amazonReplenishmentBusinessDay(dailyCache.retrieved_at) === today) {
    return {
      reportId: dailyCache.report_id, marketplace, reused: true, cached: true, dailyCache: true,
      processingStatus: "DONE", retrievedAt: dailyCache.retrieved_at, rowCount: dailyCache.row_count,
    };
  }
  const existing = await env.DB.prepare(`SELECT marketplace_id, report_id, processing_status, rate_limit, created_at, updated_at
    FROM amazon_replenishment_report_job WHERE marketplace_id = ?`).bind(marketplace.id).first<AmazonReplenishmentJobRow>();
  const reusable = existing?.report_id && ["IN_QUEUE", "IN_PROGRESS", "DONE"].includes(existing.processing_status)
    && amazonReplenishmentBusinessDay(existing.created_at) === today;
  if (reusable) {
    const cached = await env.DB.prepare("SELECT report_id FROM amazon_replenishment_report_cache WHERE report_id = ?")
      .bind(existing.report_id).first<{ report_id: string }>();
    return { reportId: existing.report_id, marketplace, reused: true, cached: !!cached, dailyCache: !!cached, processingStatus: existing.processing_status, rateLimit: existing.rate_limit };
  }
  const credentials = await decryptAmazonCredentials(row, env);
  const accessToken = await getAmazonAccessToken(credentials);
  const { payload, rateLimit } = await amazonReportsRequest("https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports", accessToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reportType: "GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT", marketplaceIds: [marketplace.id] }),
  });
  if (!payload.reportId) throw new Error("Amazon did not return a replenishment report ID.");
  const reportId = String(payload.reportId), now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO amazon_replenishment_report_job
    (marketplace_id, report_id, processing_status, rate_limit, created_at, updated_at)
    VALUES (?, ?, 'IN_QUEUE', ?, ?, ?)
    ON CONFLICT(marketplace_id) DO UPDATE SET report_id = excluded.report_id,
    processing_status = excluded.processing_status, rate_limit = excluded.rate_limit,
    created_at = excluded.created_at, updated_at = excluded.updated_at`)
    .bind(marketplace.id, reportId, rateLimit, now, now).run();
  return { reportId, marketplace, reused: false, cached: false, dailyCache: false, processingStatus: "IN_QUEUE", rateLimit };
};

const getAmazonReplenishmentReport = async (row: AmazonConnectionRow, env: Env, reportId: string) => {
  const cached = await env.DB.prepare(`SELECT report_id, marketplace_id, rows_json, row_count, retrieved_at
    FROM amazon_replenishment_report_cache WHERE report_id = ?`).bind(reportId).first<AmazonReplenishmentCacheRow>();
  if (cached?.rows_json) return { processingStatus: "DONE", reportId, rows: JSON.parse(cached.rows_json), rowCount: cached.row_count, retrievedAt: cached.retrieved_at, cached: true };
  const credentials = await decryptAmazonCredentials(row, env);
  const accessToken = await getAmazonAccessToken(credentials);
  const statusResponse = await amazonReportsRequest(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, accessToken);
  const processingStatus = String(statusResponse.payload.processingStatus || "IN_PROGRESS");
  await env.DB.prepare("UPDATE amazon_replenishment_report_job SET processing_status = ?, rate_limit = CASE WHEN ? = '' THEN rate_limit ELSE ? END, updated_at = ? WHERE report_id = ?")
    .bind(processingStatus, statusResponse.rateLimit, statusResponse.rateLimit, new Date().toISOString(), reportId).run();
  if (processingStatus !== "DONE") return { processingStatus, reportId, rateLimit: statusResponse.rateLimit };
  const documentId = String(statusResponse.payload.reportDocumentId || "");
  if (!documentId) throw new Error("Amazon completed the replenishment report without a document ID.");
  const documentResponse = await amazonReportsRequest(`https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`, accessToken);
  const downloadUrl = String(documentResponse.payload.url || "");
  if (!downloadUrl) throw new Error("Amazon completed the replenishment report without a download URL.");
  const download = await fetch(downloadUrl);
  if (!download.ok || !download.body) throw new Error(`Amazon replenishment report download failed (HTTP ${download.status}).`);
  const stream = String(documentResponse.payload.compressionAlgorithm || "").toUpperCase() === "GZIP"
    ? download.body.pipeThrough(new DecompressionStream("gzip")) : download.body;
  const rows = parseAmazonReplenishmentReport(await new Response(stream).text());
  const job = await env.DB.prepare("SELECT marketplace_id FROM amazon_replenishment_report_job WHERE report_id = ?")
    .bind(reportId).first<{ marketplace_id: string }>();
  const retrievedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO amazon_replenishment_report_cache (report_id, marketplace_id, rows_json, row_count, retrieved_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(report_id) DO UPDATE SET rows_json = excluded.rows_json,
    row_count = excluded.row_count, retrieved_at = excluded.retrieved_at`)
    .bind(reportId, job?.marketplace_id || "", JSON.stringify(rows), rows.length, retrievedAt).run();
  return { processingStatus, reportId, rows, rowCount: rows.length, retrievedAt, cached: false, rateLimit: statusResponse.rateLimit || documentResponse.rateLimit };
};

const amazonConnectionRecord = async (env: Env) =>
  env.DB.prepare(`SELECT credentials_ciphertext, credentials_iv, region, marketplaces_json,
    connected_at, updated_at, last_tested_at FROM amazon_connection WHERE id = 1`).first<AmazonConnectionRow>();

const SHOPIFY_API_VERSION = "2026-07";
const SHOPIFY_REQUIRED_SCOPES = ["read_products", "write_products", "read_orders", "read_inventory", "write_inventory", "read_locations", "read_reports"];
const SHOPIFY_CONNECTION_QUERY = `query StockLensConnectionCheck {
  shop { name myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
}`;
const SHOPIFY_VARIANTS_QUERY = `query StockLensShopifyVariants($cursor: String) {
  productVariants(first: 250, after: $cursor) {
    nodes {
      id
      sku
      title
      barcode
      product { id title status }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const normalizeShopifyDomain = (input: string) => {
  const trimmed = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const adminMatch = trimmed.match(/^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/);
  const domain = adminMatch ? `${adminMatch[1]}.myshopify.com` : trimmed.split("/")[0];
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))
    throw new Error("Enter the store's .myshopify.com domain or its admin.shopify.com/store/... URL.");
  return domain;
};

const shopifyConnectionRecord = async (env: Env) => env.DB.prepare(`SELECT shop_domain, shop_name,
  credentials_ciphertext, credentials_iv, scopes_json, connected_at, updated_at, last_tested_at
  FROM shopify_connection WHERE id = 1`).first<ShopifyConnectionRow>();

const getShopifyAccessToken = async (shopDomain: string, credentials: ShopifyCredentials) => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!response.ok || !accessToken) {
    const detail = String(payload.error_description || payload.error || "Shopify rejected the client credentials.");
    throw new Error(`${detail} Confirm the app is installed on this store and copy the Client ID and Client secret from the Dev Dashboard.`);
  }
  return accessToken;
};

const verifyShopifyConnection = async (shopDomain: string, accessToken: string) => {
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
    body: JSON.stringify({ query: SHOPIFY_CONNECTION_QUERY }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const errors = Array.isArray(payload.errors) ? payload.errors as Array<Record<string, unknown>> : [];
    throw new Error(String(errors[0]?.message || `Shopify connection failed (HTTP ${response.status}). Check the store domain and app permissions.`));
  }
  const errors = Array.isArray(payload.errors) ? payload.errors as Array<Record<string, unknown>> : [];
  if (errors.length) throw new Error(String(errors[0]?.message || "Shopify could not verify the connection."));
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const shop = data.shop && typeof data.shop === "object" ? data.shop as Record<string, unknown> : {};
  const installation = data.currentAppInstallation && typeof data.currentAppInstallation === "object" ? data.currentAppInstallation as Record<string, unknown> : {};
  const scopes = (Array.isArray(installation.accessScopes) ? installation.accessScopes : []).map((entry) => String((entry as Record<string, unknown>)?.handle || "")).filter(Boolean).sort();
  if (!shop.myshopifyDomain) throw new Error("Shopify verified the token but did not return the store identity.");
  return { shopName: String(shop.name || shopDomain), shopDomain: String(shop.myshopifyDomain || shopDomain).toLowerCase(), scopes };
};

const shopifyGraphql = async (shopDomain: string, accessToken: string, query: string, variables: Record<string, unknown> = {}) => {
  const response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const errors = Array.isArray(payload.errors) ? payload.errors as Array<Record<string, unknown>> : [];
  if (!response.ok || errors.length) throw new Error(String(errors[0]?.message || `Shopify request failed (HTTP ${response.status}).`));
  return payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
};

const fetchShopifyVariants = async (env: Env) => {
  const connection = await shopifyConnectionRecord(env);
  if (!connection) throw new Error("Connect Shopify before importing the product catalog.");
  const credentials = await decryptShopifyCredentials(connection, env);
  const accessToken = await getShopifyAccessToken(connection.shop_domain, credentials);
  const variants: ShopifyVariantSnapshotRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const data = await shopifyGraphql(connection.shop_domain, accessToken, SHOPIFY_VARIANTS_QUERY, { cursor });
    const connectionData = data.productVariants && typeof data.productVariants === "object" ? data.productVariants as Record<string, unknown> : {};
    const nodes = Array.isArray(connectionData.nodes) ? connectionData.nodes as Array<Record<string, unknown>> : [];
    for (const node of nodes) {
      const product = node.product && typeof node.product === "object" ? node.product as Record<string, unknown> : {};
      const variantId = String(node.id || "");
      if (!variantId) continue;
      variants.push({
        variantId,
        productId: String(product.id || ""),
        sku: String(node.sku || "").trim(),
        title: String(node.title || "").trim(),
        productTitle: String(product.title || "").trim(),
        productStatus: String(product.status || ""),
        barcode: String(node.barcode || "").trim(),
      });
    }
    const pageInfo = connectionData.pageInfo && typeof connectionData.pageInfo === "object" ? connectionData.pageInfo as Record<string, unknown> : {};
    if (pageInfo.hasNextPage !== true || !pageInfo.endCursor) break;
    cursor = String(pageInfo.endCursor);
  }
  const importedAt = new Date().toISOString();
  for (let offset = 0; offset < variants.length; offset += 75) {
    await env.DB.batch(variants.slice(offset, offset + 75).map((variant) => env.DB.prepare(`INSERT INTO shopify_variant_snapshot
      (variant_id, product_id, sku, title, product_title, product_status, barcode, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(variant_id) DO UPDATE SET product_id = excluded.product_id, sku = excluded.sku,
      title = excluded.title, product_title = excluded.product_title, product_status = excluded.product_status,
      barcode = excluded.barcode, imported_at = excluded.imported_at`)
      .bind(variant.variantId, variant.productId, variant.sku, variant.title, variant.productTitle, variant.productStatus, variant.barcode, importedAt)));
  }
  await env.DB.prepare("DELETE FROM shopify_variant_snapshot WHERE imported_at <> ?").bind(importedAt).run();
  return { variants, importedAt };
};

const GOOGLE_DRIVE_CLIENT_ID = "765209318120-k7snbd4hnjc4tvl5poqd4l17c6u5pbl9.apps.googleusercontent.com";
const WOH_FOLDER_ID = "127jhfJXyaM3V_0plR4LSLMacysNJs9tT";
const WOH_FILE_ID = "1YFXl8d2QcxHZGF2Qk1fNxLu5qW9L-P-P";
const INVENTORY_MOVES_FOLDER_ID = "1TMw6vU5nwKOk3MH1Idag5QPAeft3Zgr5";

const googleDriveConnectionRecord = (env: Env) => env.DB.prepare("SELECT * FROM google_drive_connection WHERE id = 1").first<GoogleDriveConnectionRow>();

const getGoogleDriveAccessToken = async (credentials: GoogleDriveCredentials) => {
  if (!credentials.clientSecret || !credentials.refreshToken)
    throw new Error("Automatic Google Drive inventory refresh is not connected. Open Data Connections → Google Drive Nightly Access and connect it once.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_DRIVE_CLIENT_ID, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string")
    throw new Error(typeof payload.error_description === "string" ? payload.error_description : "Google Drive could not renew the nightly access token. Reconnect Google Drive Nightly Access in Data Connections.");
  return payload.access_token;
};

const exchangeGoogleDriveAuthorizationCode = async (clientSecret: string, code: string, redirectUri: string) => {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_DRIVE_CLIENT_ID, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string")
    throw new Error(typeof payload.error_description === "string" ? payload.error_description : "Google did not complete the Drive authorization.");
  return { accessToken: payload.access_token, refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "" };
};

const verifyGoogleDriveAccess = async (accessToken: string) => {
  const response = await googleDriveFetch(accessToken, "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)");
  const payload = await response.json() as { user?: { displayName?: string; emailAddress?: string } };
  const inventoryFile = await liveInventoryMovesFile(accessToken);
  const wohFileId = await liveWohFileId(accessToken);
  const [wohBuffer, inventoryBuffer] = await Promise.all([
    downloadGoogleDriveFile(accessToken, wohFileId),
    downloadGoogleDriveFile(accessToken, inventoryFile.id),
  ]);
  // A successful Drive listing is not enough: validate the same workbook bytes
  // and parsers that the unattended nightly job will actually use.
  readNightlyWohItems(wohBuffer);
  readNightlyEndPositionUnits(inventoryBuffer);
  return { email: payload.user?.emailAddress || payload.user?.displayName || "Google Drive account" };
};

const googleDriveFetch = async (token: string, url: string) => {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, "cache-control": "no-cache" } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const detail = payload.error && typeof payload.error === "object" ? String((payload.error as Record<string, unknown>).message || "") : "";
    throw new Error(detail || `Google Drive request failed (HTTP ${response.status}).`);
  }
  return response;
};

const liveWohFileId = async (token: string) => {
  const params = new URLSearchParams({
    q: `'${WOH_FOLDER_ID}' in parents and name = 'WOH.xlsm' and trashed = false`,
    fields: "files(id,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "10",
  });
  const response = await googleDriveFetch(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  const payload = await response.json() as { files?: Array<{ id: string }> };
  return payload.files?.[0]?.id || WOH_FILE_ID;
};

const liveInventoryMovesFile = async (token: string) => {
  const params = new URLSearchParams({
    q: `'${INVENTORY_MOVES_FOLDER_ID}' in parents and trashed = false`,
    fields: "files(id,name,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "1000",
    includeItemsFromAllDrives: "true", supportsAllDrives: "true",
  });
  const response = await googleDriveFetch(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  const payload = await response.json() as { files?: Array<{ id: string; name: string; modifiedTime?: string }> };
  const latest = payload.files?.find((file) => /all\s+inv\s+adj/i.test(file.name) && /\.xlsx$/i.test(file.name));
  if (!latest) throw new Error("No All Inv Adj XLSX workbook was found in the configured Google Drive inventory folder.");
  return latest;
};

const downloadGoogleDriveFile = async (token: string, fileId: string) => {
  const response = await googleDriveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&stocklensRefresh=${Date.now()}`);
  return response.arrayBuffer();
};

const nightlyClean = (value: unknown) => String(value ?? "").trim().replace(/\.0$/, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
const nightlyCleanSku = (value: unknown) => String(value ?? "").trim().toLowerCase().replaceAll("galvanized", "gal").replaceAll("galv", "gal").replace(/[^a-z0-9]/g, "");

const readNightlyEndPositionUnits = (buffer: ArrayBuffer) => {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  const latest = new Map<string, { quantity: number; date: number }>();
  for (const row of rows) {
    const itemNumber = String(row["Item ID"] || row["Item Number"] || "").trim();
    const tag = nightlyClean(`${String(row["Item Description"] || "")} ${String(row["Adjustment Code"] || "")}`);
    const quantity = Number(String(row["Total Units"] || "").replaceAll(",", ""));
    const parsedDate = Date.parse(String(row.Date || row["Date Time"] || ""));
    const date = Number.isFinite(parsedDate) ? parsedDate : 0;
    const key = nightlyClean(itemNumber);
    if (!key || (!tag.includes("endposition") && !tag.includes("endingposition")) || !Number.isFinite(quantity)) continue;
    const prior = latest.get(key);
    if (!prior || date >= prior.date) latest.set(key, { quantity, date });
  }
  if (!latest.size) throw new Error("all inv adj.xlsx did not contain usable Item ID, End Position, and Total Units rows.");
  return new Map([...latest].map(([key, value]) => [key, value.quantity]));
};

const readNightlyWohItems = (buffer: ArrayBuffer) => {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    throw new Error(`WOH.xlsm downloaded from Google Drive, but its ${buffer.byteLength.toLocaleString()} bytes are not a readable Excel workbook.`);
  }
  const itemAliases = new Set(["currentbarcode", "itemnumber", "itemid", "barcode"]);
  const skuAliases = new Set(["sku", "itemsku", "wohsku", "stocksku"]);
  let selected: { name: string; sheet: XLSX.WorkSheet; headerRow: number; score: number } | null = null;
  const worksheetNotes: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const preview = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, { header: 1, defval: "", raw: false }).slice(0, 50);
    let bestHeaders: string[] = [];
    preview.forEach((row, headerRow) => {
      const headers = row.map((value) => nightlyClean(String(value || ""))).filter(Boolean);
      if (headers.length > bestHeaders.length) bestHeaders = headers;
      const hasItem = headers.some((header) => itemAliases.has(header));
      const hasSku = headers.some((header) => skuAliases.has(header));
      const score = Number(hasItem) * 5 + Number(hasSku) * 5
        + Number(headers.includes("description")) + Number(headers.includes("itemdescription"));
      if (hasItem && hasSku && (!selected || score > selected.score)) selected = { name, sheet, headerRow, score };
    });
    worksheetNotes.push(`${name}: ${bestHeaders.slice(0, 8).join(", ") || "no visible headers"}`);
  }
  if (!selected) throw new Error(`WOH.xlsm opened, but no worksheet contains both a Current Barcode/Item Number column and a SKU/Item SKU column. Checked ${workbook.SheetNames.length.toLocaleString()} worksheet${workbook.SheetNames.length === 1 ? "" : "s"}: ${worksheetNotes.join(" · ")}.`);
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(selected.sheet, { range: selected.headerRow, defval: "", raw: false });
  const bySku = new Map<string, string>();
  for (const row of rows) {
    const normalized = new Map(Object.entries(row).map(([header, value]) => [nightlyClean(header), String(value ?? "").trim()]));
    const value = (aliases: Set<string>) => {
      for (const alias of aliases) {
        const found = normalized.get(alias);
        if (found) return found;
      }
      return "";
    };
    const itemNumber = value(itemAliases);
    const sku = value(skuAliases);
    if (itemNumber && sku && !bySku.has(nightlyCleanSku(sku))) bySku.set(nightlyCleanSku(sku), itemNumber);
  }
  if (!bySku.size) throw new Error(`WOH.xlsm worksheet “${selected.name}” was found with headers on row ${selected.headerRow + 1}, but it contains no rows with both an item number and SKU.`);
  return bySku;
};

type EbayInventoryRequirementSnapshot = { wohSku: string; itemNumber?: string; quantityPerListing: number; abcAvailable: number; stockFound?: boolean };
type EbayInventorySyncSnapshotItem = {
  key: string; listingId: string; ebaySku: string; title: string; workflowStatus: string;
  wohMakeBuy?: "Make" | "Buy" | "Local" | "3PL" | "Not set";
  currentQuantity: number; theoreticalQuantity: number; recommendedQuantity: number; difference: number;
  requirements: EbayInventoryRequirementSnapshot[]; sharedInventory: boolean; eligible: boolean;
  result: "Increase" | "Reduce" | "No change" | "Excluded" | "Review"; note: string;
  calculatedQuantity?: number; overrideId?: number; overrideReason?: string; overrideUpdatedAt?: string;
};

const refreshNightlyInventorySnapshot = async (env: Env, snapshotItems: EbayInventorySyncSnapshotItem[]) => {
  const connection = await googleDriveConnectionRecord(env).catch(() => null);
  if (!connection) throw new Error("Automatic Google Drive inventory refresh is not connected. Open Data Connections → Google Drive Nightly Access and connect it once.");
  const credentials = await decryptGoogleDriveCredentials(connection, env);
  const token = await getGoogleDriveAccessToken(credentials);
  const wohId = await liveWohFileId(token);
  const inventoryFile = await liveInventoryMovesFile(token);
  const [wohBuffer, inventoryBuffer] = await Promise.all([
    downloadGoogleDriveFile(token, wohId),
    downloadGoogleDriveFile(token, inventoryFile.id),
  ]);
  const itemBySku = readNightlyWohItems(wohBuffer);
  const unitsByItem = readNightlyEndPositionUnits(inventoryBuffer);
  const missing = new Set<string>();
  const refreshed = snapshotItems.map((item) => ({
    ...item,
    requirements: item.requirements.map((requirement) => {
      const itemNumber = requirement.itemNumber || itemBySku.get(nightlyCleanSku(requirement.wohSku)) || "";
      const quantity = itemNumber ? unitsByItem.get(nightlyClean(itemNumber)) : undefined;
      if (quantity === undefined) missing.add(requirement.wohSku);
      return { ...requirement, itemNumber, abcAvailable: quantity === undefined ? requirement.abcAvailable : Math.max(0, Math.floor(quantity)), stockFound: quantity !== undefined };
    }),
  }));
  if (missing.size) throw new Error(`The nightly inventory refresh could not calculate current stock for ${missing.size.toLocaleString()} WOH component${missing.size === 1 ? "" : "s"}: ${[...missing].slice(0, 12).join(", ")}${missing.size > 12 ? "…" : ""}. eBay data was not fetched.`);
  const refreshedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO ebay_inventory_sync_snapshot (id, rows_json, source_updated_at)
    VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET rows_json = excluded.rows_json, source_updated_at = excluded.source_updated_at`)
    .bind(JSON.stringify(refreshed), refreshedAt).run();
  await env.DB.prepare("UPDATE google_drive_connection SET updated_at = ?, last_tested_at = ? WHERE id = 1").bind(refreshedAt, refreshedAt).run();
  return { rows: refreshed, refreshedAt, wohFileId: wohId, inventoryFileId: inventoryFile.id, inventoryFileName: inventoryFile.name, inventoryFileModifiedTime: inventoryFile.modifiedTime || "", stockItemCount: unitsByItem.size };
};

const easternRunDate = (date = new Date()) => {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { runDate: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour || 0) };
};

const normalizeNightlyEbayListings = (input: unknown) => (Array.isArray(input) ? input : []).map((value, index) => {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const listingId = String(item.listingId ?? item.listing_id ?? item.itemId ?? "");
  const ebaySku = String(item.sku ?? item.listingSku ?? item.listing_sku ?? "");
  return {
    key: `${listingId}:${ebaySku || String(item.variation || index)}`,
    listingId, ebaySku, title: String(item.title || ""),
    currentQuantity: Math.max(0, Math.floor(Number(item.quantityAvailable ?? item.quantity_available ?? 0) || 0)),
    status: String(item.status || "Active"),
  };
}).filter((item) => item.listingId && (!item.status || item.status.toLowerCase() === "active"));

const saveEbayInventoryListingFetch = async (env: Env, input: unknown, source: string) => {
  const listings = Array.isArray(input) ? input.slice(0, 10_000) : [];
  if (!listings.length) throw new Error("The eBay inventory download did not contain any listings.");
  const fetchedAt = new Date().toISOString();
  const saved = await env.DB.prepare(`INSERT INTO ebay_inventory_listing_fetch
    (fetched_at, source, listing_count, rows_json) VALUES (?, ?, ?, ?)`)
    .bind(fetchedAt, source.slice(0, 120), listings.length, JSON.stringify(listings)).run();
  await env.DB.prepare(`DELETE FROM ebay_inventory_listing_fetch WHERE id NOT IN
    (SELECT id FROM ebay_inventory_listing_fetch ORDER BY fetched_at DESC, id DESC LIMIT 5)`).run();
  return { id: Number(saved.meta.last_row_id), fetchedAt, source, listingCount: listings.length, listings };
};

const calculateNightlyEbayInventorySync = (snapshotItems: EbayInventorySyncSnapshotItem[], liveInput: unknown) => {
  const liveListings = normalizeNightlyEbayListings(liveInput);
  const snapshotByIdentity = new Map<string, EbayInventorySyncSnapshotItem>();
  for (const item of snapshotItems) {
    snapshotByIdentity.set(`${item.listingId}:${item.ebaySku.trim().toLowerCase()}`, item);
    if (!snapshotByIdentity.has(item.listingId)) snapshotByIdentity.set(item.listingId, item);
  }
  const prepared = liveListings.map((live): EbayInventorySyncSnapshotItem => {
    const saved = snapshotByIdentity.get(`${live.listingId}:${live.ebaySku.trim().toLowerCase()}`) || snapshotByIdentity.get(live.listingId);
    if (!saved) return { ...live, workflowStatus: "Unmatched", theoreticalQuantity: 0, recommendedQuantity: live.currentQuantity, difference: 0, requirements: [], sharedInventory: false, eligible: false, result: "Review", note: "New active listing was not present in the latest WOH inventory-sync snapshot" };
    return { ...saved, key: live.key, listingId: live.listingId, ebaySku: live.ebaySku || saved.ebaySku, title: live.title || saved.title, currentQuantity: live.currentQuantity };
  });
  const eligible = prepared.filter((item) => item.eligible && item.wohMakeBuy !== "Local").sort((a, b) => a.ebaySku.localeCompare(b.ebaySku, undefined, { numeric: true, sensitivity: "base" }) || a.listingId.localeCompare(b.listingId, undefined, { numeric: true }));
  const stock = new Map<string, number>(), consumers = new Map<string, Set<string>>();
  for (const item of eligible) for (const requirement of item.requirements) {
    const key = requirement.wohSku.trim().toLowerCase();
    stock.set(key, Math.max(stock.get(key) || 0, Math.max(0, Math.floor(requirement.abcAvailable || 0))));
    consumers.set(key, new Set([...(consumers.get(key) || []), item.key]));
  }
  const allocated = new Map(eligible.map((item) => [item.key, 0])), remaining = new Map(stock);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of eligible) {
      const current = allocated.get(item.key) || 0;
      if (current >= 15 || !item.requirements.every((requirement) => (remaining.get(requirement.wohSku.trim().toLowerCase()) || 0) >= requirement.quantityPerListing)) continue;
      allocated.set(item.key, current + 1);
      for (const requirement of item.requirements) {
        const key = requirement.wohSku.trim().toLowerCase();
        remaining.set(key, (remaining.get(key) || 0) - requirement.quantityPerListing);
      }
      changed = true;
    }
  }
  return prepared.map((item): EbayInventorySyncSnapshotItem => {
    if (!item.eligible) return { ...item, difference: 0 };
    if (item.wohMakeBuy === "Local") {
      const recommendedQuantity = 5;
      return { ...item, calculatedQuantity: recommendedQuantity, recommendedQuantity, difference: recommendedQuantity - item.currentQuantity, sharedInventory: false,
        result: recommendedQuantity > item.currentQuantity ? "Increase" : recommendedQuantity < item.currentQuantity ? "Reduce" : "No change",
        note: "WOH Buy/Make is Local · fixed eBay quantity 5 · nightly safe review",
      };
    }
    const calculatedQuantity = allocated.get(item.key) || 0;
    const recommendedQuantity = item.overrideId ? Math.max(0, Math.min(15, Math.floor(item.recommendedQuantity))) : calculatedQuantity;
    const sharedInventory = item.requirements.some((requirement) => (consumers.get(requirement.wohSku.trim().toLowerCase())?.size || 0) > 1);
    return { ...item, calculatedQuantity, recommendedQuantity, difference: recommendedQuantity - item.currentQuantity, sharedInventory,
      result: recommendedQuantity > item.currentQuantity ? "Increase" : recommendedQuantity < item.currentQuantity ? "Reduce" : "No change",
      note: `${item.note.replace(/ · shared inventory distributed evenly across listings| · maximum 15| · nightly safe review/g, "")}${sharedInventory ? " · shared inventory distributed evenly across listings" : ""}${item.overrideId ? ` · active manual override ${recommendedQuantity}` : ""} · nightly safe review · maximum 15`,
    };
  }).sort((a, b) => a.result.localeCompare(b.result) || a.ebaySku.localeCompare(b.ebaySku, undefined, { numeric: true }));
};

const runNightlyEbayInventorySync = async (env: Env, requestedDate?: string) => {
  if (!env.STOCKLENS_SERVICE_KEY) throw new Error("The eBay connection is not configured.");
  const { runDate: currentEasternDate, hour } = easternRunDate();
  const runDate = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : currentEasternDate;
  if (!requestedDate && (hour < 21 || hour > 23)) throw new Error("The safe nightly trigger is available from 9 PM through midnight Eastern.");
  const existing = await env.DB.prepare("SELECT status, listing_count, change_count, review_count, completed_at FROM ebay_inventory_sync_run WHERE run_date = ?")
    .bind(runDate).first<{ status: string; listing_count: number; change_count: number; review_count: number; completed_at: string | null }>();
  if (existing?.status === "completed") return { runDate, status: "completed", alreadyCompleted: true, listingCount: existing.listing_count, changeCount: existing.change_count, reviewCount: existing.review_count, completedAt: existing.completed_at };
  const snapshot = await env.DB.prepare("SELECT rows_json, source_updated_at FROM ebay_inventory_sync_snapshot WHERE id = 1")
    .first<{ rows_json: string; source_updated_at: string }>();
  if (!snapshot?.rows_json) throw new Error("Run the eBay Inventory Sync manually once after this update so StockLens can save the initial WOH inventory snapshot.");
  const snapshotItems = JSON.parse(snapshot.rows_json) as EbayInventorySyncSnapshotItem[];
  if (!Array.isArray(snapshotItems) || !snapshotItems.length) throw new Error("The saved eBay inventory-sync snapshot is empty.");
  const startedAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO ebay_inventory_sync_run
    (run_date, status, started_at, completed_at, snapshot_updated_at, rows_json, listing_count, change_count, review_count, error, approved_at)
    VALUES (?, 'running', ?, NULL, ?, '[]', 0, 0, 0, '', NULL)
    ON CONFLICT(run_date) DO UPDATE SET status = 'running', started_at = excluded.started_at, completed_at = NULL,
    snapshot_updated_at = excluded.snapshot_updated_at, rows_json = '[]', listing_count = 0, change_count = 0,
    review_count = 0, error = '', approved_at = NULL`)
    .bind(runDate, startedAt, snapshot.source_updated_at).run();
  try {
    const inventoryRefresh = await refreshNightlyInventorySnapshot(env, snapshotItems);
    const upstream = await fetch("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/listings", { headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}` } });
    const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
    if (!upstream.ok || !Array.isArray(payload.listings)) throw new Error(typeof payload.error === "string" ? payload.error : `Live eBay listings could not be loaded (HTTP ${upstream.status}).`);
    await saveEbayInventoryListingFetch(env, payload.listings, "Nightly inventory review");
    const rows = calculateNightlyEbayInventorySync(inventoryRefresh.rows, payload.listings);
    const completedAt = new Date().toISOString(), changeCount = rows.filter((item) => item.result === "Increase" || item.result === "Reduce").length;
    const reviewCount = rows.filter((item) => item.result === "Excluded" || item.result === "Review").length;
    await env.DB.prepare(`UPDATE ebay_inventory_sync_run SET status = 'completed', completed_at = ?, rows_json = ?,
      listing_count = ?, change_count = ?, review_count = ?, error = '' WHERE run_date = ?`)
      .bind(completedAt, JSON.stringify(rows), rows.length, changeCount, reviewCount, runDate).run();
    return { runDate, status: "completed", listingCount: rows.length, changeCount, reviewCount, completedAt, snapshotUpdatedAt: inventoryRefresh.refreshedAt, inventoryRefreshedAt: inventoryRefresh.refreshedAt, inventoryItemCount: inventoryRefresh.stockItemCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The nightly inventory review could not be prepared.";
    await env.DB.prepare("UPDATE ebay_inventory_sync_run SET status = 'failed', completed_at = ?, error = ? WHERE run_date = ?")
      .bind(new Date().toISOString(), message, runDate).run();
    throw error;
  }
};

const googleDriveSetupPage = (options: { authorized: boolean; row?: GoogleDriveConnectionRow | null; message?: string; error?: string }) => {
  const connected = !!options.row?.account_email;
  const secretSaved = !!options.row?.credentials_ciphertext && !!options.row?.credentials_iv;
  const statusMessage = options.error || options.message || "";
  const progressSteps = [
    { label: "Administrator access", detail: options.authorized ? "Unlocked for this setup session." : "Waiting for the administrator key.", state: options.authorized ? "done" : "active" },
    { label: "OAuth client secret", detail: secretSaved ? "Received, encrypted, and saved." : options.authorized ? "Waiting for the OAuth client secret." : "Waiting for administrator access.", state: secretSaved ? "done" : options.authorized ? "active" : "waiting" },
    { label: "Open Google authorization", detail: connected ? "Google authorization completed." : secretSaved ? "Action required: continue with the saved secret and open Google." : "Waiting for the OAuth client secret.", state: connected ? "done" : secretSaved ? "active" : "waiting" },
    { label: "Google callback received", detail: connected ? "Google returned control to StockLens." : "No callback has reached StockLens yet.", state: connected ? "done" : "waiting" },
    { label: "Verify inventory sources", detail: connected ? "WOH.xlsm and the latest all inv adj.xlsx were opened successfully." : "Waiting to verify WOH.xlsm and all inv adj.xlsx.", state: connected ? "done" : "waiting" },
    { label: "Nightly access ready", detail: connected ? `Connected as ${options.row?.account_email}.` : "Waiting for all prior steps.", state: connected ? "done" : "waiting" },
  ];
  const progressHtml = progressSteps.map((step, index) => `<li class="${step.state}"><span>${step.state === "done" ? "✓" : step.state === "active" ? "…" : ""}</span><div><small>STEP ${index + 1}</small><strong>${htmlEscape(step.label)}</strong><em>${htmlEscape(step.detail)}</em></div></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive nightly access · StockLens</title><style>
  :root{color-scheme:light;--green:#123f2b;--lime:#d9ef42;--ink:#183126;--muted:#5e7067;--line:#d9e2dc;--bg:#eef3ef;--red:#9f2e21}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#e7f0ea,#f8faf8 45%,#edf3ef);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5}main{width:min(900px,calc(100% - 28px));margin:28px auto 60px}.top{display:flex;justify-content:space-between;gap:16px;margin-bottom:20px}.top a{color:var(--green);font-weight:900;text-decoration:none}.hero,.card{background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 40px rgba(23,57,41,.08)}.hero{padding:28px;background:linear-gradient(135deg,#123f2b,#1d5b3e);color:#fff}.hero small{font-weight:900;letter-spacing:.09em;color:var(--lime)}h1{margin:6px 0 8px;font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.1}.hero p{max-width:740px;margin:0;color:#dce9e1}.card{margin-top:18px;padding:22px}.card h2{margin:0 0 6px}.card p{color:var(--muted)}label{display:block;margin:15px 0 6px;font-weight:850}input{width:100%;min-height:48px;padding:11px 12px;border:2px solid #b8c8be;border-radius:10px;font:inherit}button,.button{display:inline-block;min-height:48px;margin-top:16px;padding:11px 18px;border:0;border-radius:10px;background:var(--lime);color:#163726;font:inherit;font-weight:900;cursor:pointer;text-decoration:none}.secondary{background:#e8f0eb}.notice{margin-top:18px;padding:14px 16px;border-radius:12px;font-weight:800}.notice.success{background:#e3f5e8;color:#146238}.notice.error{background:#fae8e5;color:#8f2b20}.status{padding:15px;border-radius:12px;background:${connected ? "#e3f5e8" : "#f2f4f2"}.steps{display:grid;gap:10px;margin:18px 0}.steps div{padding:12px 14px;border-left:4px solid var(--green);background:#f4f7f5}.steps strong,.steps span{display:block}.steps span{color:var(--muted);font-size:.9rem}.progress{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:9px}.progress li{display:grid;grid-template-columns:34px 1fr;gap:11px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#f7f9f7}.progress li>span{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#e1e7e3;color:#5d6b63;font-weight:950}.progress li.done>span{background:#dff3e5;color:#12623a}.progress li.active{border-color:#b6c52a;background:#fbfddd}.progress li.active>span{background:var(--lime);color:#173726}.progress small,.progress strong,.progress em{display:block}.progress small{color:var(--muted);font-weight:900;letter-spacing:.06em}.progress em{margin-top:2px;color:var(--muted);font-style:normal}.action-required{border-color:#b6c52a;background:#fbfddd}.action-required strong{display:block;font-size:1.1rem}.action-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.action-row .button{margin-top:12px}@media(max-width:650px){.hero,.card{padding:19px;border-radius:16px}.action-row{display:grid}.action-row .button{text-align:center}}
  </style></head><body><main><div class="top"><a href="/">StockLens</a><a href="/">← All tools</a></div><section class="hero"><small>REQUIRED FOR NIGHTLY EBAY REVIEW</small><h1>Google Drive nightly access</h1><p>Allow StockLens to securely refresh current ABC inventory from all inv adj.xlsx before it fetches eBay listings. This connection is used by the unattended nightly review only.</p></section>${statusMessage ? `<div class="notice ${options.error ? "error" : "success"}">${htmlEscape(statusMessage)}</div>` : ""}
  <section class="card"><small>LIVE CONNECTION PROGRESS</small><h2>${connected ? "All required steps completed" : "Current background status"}</h2><ol class="progress">${progressHtml}</ol></section>
  ${!options.authorized ? `<section class="card"><h2>Administrator access required</h2><p>Enter the StockLens administrator key to view or change this connection.</p><form method="post" action="/setup/google-drive" target="_top"><input type="hidden" name="action" value="unlock"><label for="adminKey">Administrator key</label><input id="adminKey" name="adminKey" type="password" required autofocus autocomplete="current-password"><button type="submit">Unlock Google Drive setup</button></form></section>` : `<section class="card"><h2>${connected ? "Nightly access connected" : secretSaved ? "Finish Google authorization" : "Connect nightly access"}</h2><div class="status"><strong>${connected ? `Connected as ${htmlEscape(options.row?.account_email)}` : secretSaved ? "OAuth client secret saved securely" : "Not connected"}</strong>${connected ? `<span>Last verified ${htmlEscape(new Date(options.row!.last_tested_at).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }))}</span>` : secretSaved ? `<span>The secret was received. Google account authorization still needs to be completed.</span>` : ""}</div><div class="steps"><div><strong>1 · Google Cloud</strong><span>Add this authorized redirect URI to the existing StockLens web OAuth client: ${htmlEscape("https://barcode-inventory-lookup.migua70576.chatgpt.site/setup/google-drive/callback")}</span></div><div><strong>2 · OAuth client secret</strong><span>${secretSaved ? "Already saved securely. Leave the field blank unless the secret changed." : "StockLens encrypts it before storage. It is never shown again."}</span></div><div><strong>3 · Authorize Google Drive</strong><span>Choose the account that can open WOH.xlsm and all inv adj.xlsx.</span></div></div><form method="post" action="/setup/google-drive" target="_top"><input type="hidden" name="action" value="connect"><label for="clientSecret">Google OAuth client secret ${secretSaved ? "(already saved · leave blank to reuse)" : ""}</label><input id="clientSecret" name="clientSecret" type="password" ${secretSaved ? "" : "required"} autocomplete="new-password"><button type="submit">${connected ? "Reconnect Google Drive" : secretSaved ? "Continue with saved secret" : "Save secret and continue to Google"}</button></form>${connected ? `<form method="post" action="/setup/google-drive" target="_top"><input type="hidden" name="action" value="test"><button type="submit">Test saved nightly access</button></form>` : ""}</section>`}</main></body></html>`;
};

const googleDriveAuthorizationProgressPage = (authorizeUrl: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue Google authorization · StockLens</title><style>
  :root{color-scheme:light;--green:#123f2b;--lime:#d9ef42;--ink:#183126;--muted:#5e7067;--line:#d9e2dc}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#e7f0ea,#f8faf8 45%,#edf3ef);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5}main{width:min(760px,calc(100% - 28px));margin:28px auto 60px}.card{padding:24px;background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 40px rgba(23,57,41,.08)}small{font-weight:900;letter-spacing:.08em;color:#607068}h1{margin:7px 0 10px;font-size:clamp(1.75rem,4vw,2.5rem);line-height:1.1}.status{margin:20px 0;padding:16px;border:1px solid #b6c52a;border-radius:13px;background:#fbfddd}.status strong,.status span{display:block}.status span{margin-top:4px;color:var(--muted)}ol{list-style:none;margin:18px 0;padding:0;display:grid;gap:9px}li{display:grid;grid-template-columns:32px 1fr;gap:11px;padding:11px;border:1px solid var(--line);border-radius:11px}li>span{display:grid;place-items:center;width:29px;height:29px;border-radius:50%;background:#e2e8e4;font-weight:900}li.done>span{background:#dff3e5;color:#12623a}li.active{background:#fbfddd;border-color:#b6c52a}li.active>span{background:var(--lime)}li strong,li em{display:block}li em{color:var(--muted);font-style:normal}.button{display:block;margin-top:20px;padding:14px 18px;border-radius:11px;background:var(--lime);color:#173726;text-decoration:none;text-align:center;font-weight:950}.secondary{background:#e8f0eb;margin-top:10px}p{color:var(--muted)}
  </style></head><body><main><section class="card"><small>LIVE CONNECTION PROGRESS</small><h1>Google authorization is ready</h1><div class="status"><strong>Action required</strong><span>StockLens received and encrypted the OAuth secret. No Google callback has arrived yet.</span></div><ol><li class="done"><span>✓</span><div><strong>Administrator access unlocked</strong><em>Complete</em></div></li><li class="done"><span>✓</span><div><strong>OAuth secret saved securely</strong><em>Complete</em></div></li><li class="active"><span>…</span><div><strong>Open Google authorization</strong><em>Waiting for you to open Google and approve Drive access.</em></div></li><li><span></span><div><strong>Google callback</strong><em>Waiting</em></div></li><li><span></span><div><strong>Verify WOH.xlsm and all inv adj.xlsx</strong><em>Waiting</em></div></li><li><span></span><div><strong>Nightly access connected</strong><em>Waiting</em></div></li></ol><a class="button" href="${htmlEscape(authorizeUrl)}" target="_blank" rel="noopener noreferrer">Open Google authorization in a new tab ↗</a><a class="button secondary" href="/setup/google-drive" target="_top">Check connection status</a><p>This page stays open so the stopping point remains visible. After Google finishes, the authorization tab returns to StockLens and verifies both inventory files.</p></section></main></body></html>`;

const amazonSetupPage = (options: {
  authorized: boolean;
  row?: AmazonConnectionRow | null;
  message?: string;
  error?: string;
}) => {
  const marketplaces = (() => {
    try { return JSON.parse(options.row?.marketplaces_json || "[]") as AmazonMarketplace[]; }
    catch { return []; }
  })();
  const connected = !!options.row;
  const statusTone = options.error ? "error" : options.message ? "success" : "";
  const statusMessage = options.error || options.message || "";
  const marketplaceRows = marketplaces.length ? marketplaces.map((marketplace) => `<tr>
    <td><strong>${htmlEscape(marketplace.name)}</strong><small>${htmlEscape(marketplace.id)}</small></td>
    <td>${htmlEscape(marketplace.countryCode || "—")}</td><td>${htmlEscape(marketplace.currencyCode || "—")}</td>
    <td><span class="pill ${marketplace.participating && !marketplace.suspended ? "good" : "warn"}">${marketplace.suspended ? "Suspended listings" : marketplace.participating ? "Participating" : "Not participating"}</span></td>
  </tr>`).join("") : `<tr><td colspan="4" class="empty">No marketplace details have been retrieved yet.</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amazon connection · StockLens</title><style>
    :root{color-scheme:light;--green:#123f2b;--lime:#d9ef42;--ink:#183126;--muted:#5e7067;--line:#d9e2dc;--bg:#eef3ef;--red:#9f2e21}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#e7f0ea,#f8faf8 45%,#edf3ef);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5}main{width:min(980px,calc(100% - 28px));margin:28px auto 60px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}.brand{color:var(--green);font-size:1.2rem;font-weight:900;text-decoration:none}.back{color:var(--green);font-weight:800;text-decoration:none}.hero,.card{background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 40px rgba(23,57,41,.08)}.hero{padding:28px;background:linear-gradient(135deg,#123f2b,#1d5b3e);color:#fff}.hero small{font-weight:900;letter-spacing:.09em;color:var(--lime)}h1{margin:6px 0 8px;font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.1}.hero p{max-width:720px;margin:0;color:#dce9e1}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px;margin-top:18px}.card{padding:22px}.card h2{margin:0 0 5px;font-size:1.25rem}.card>p{margin:0 0 18px;color:var(--muted)}label{display:block;margin:14px 0 5px;font-weight:800}label span{color:var(--red);font-size:.82rem}input{width:100%;min-height:48px;padding:11px 12px;border:2px solid #b8c8be;border-radius:10px;font:inherit}input:focus{outline:3px solid rgba(217,239,66,.5);border-color:var(--green)}button{min-height:48px;margin-top:18px;padding:11px 18px;border:0;border-radius:10px;background:var(--lime);color:#163726;font:inherit;font-weight:900;cursor:pointer}button.secondary{background:#e8f0eb}.notice{margin:18px 0 0;padding:13px 15px;border-radius:12px;font-weight:800}.notice.success{background:#e3f5e8;color:#146238}.notice.error{background:#fae8e5;color:#8f2b20}.status{display:flex;align-items:center;gap:10px;margin:14px 0 18px;padding:14px;border-radius:12px;background:${connected ? "#e3f5e8" : "#f2f4f2"}}.dot{width:12px;height:12px;border-radius:50%;background:${connected ? "#20a35a" : "#89978f"}}.status strong,.status small,td small{display:block}.status small,td small{color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;border-bottom:1px solid #e8ede9;text-align:left;vertical-align:top;font-size:.9rem}th{color:var(--muted);font-size:.78rem;text-transform:uppercase}.pill{display:inline-block;padding:4px 8px;border-radius:999px;font-size:.75rem;font-weight:900}.pill.good{background:#e3f5e8;color:#146238}.pill.warn{background:#fff2cf;color:#765a00}.empty{color:var(--muted);text-align:center}.security{margin-top:16px;padding:14px;border-radius:12px;background:#f4f7f5;color:var(--muted);font-size:.88rem}.locked{padding:22px}.locked label{font-size:1.05rem}.locked input{border-color:#667d70}.locked button{width:100%}@media(max-width:760px){.grid{grid-template-columns:1fr}.top{align-items:flex-start}.hero,.card{border-radius:16px;padding:19px}th:nth-child(3),td:nth-child(3){display:none}}
  </style></head><body><main><div class="top"><a class="brand" href="/">StockLens</a><a class="back" href="/">← All tools</a></div><section class="hero"><small>AMAZON SELLING PARTNER API</small><h1>Amazon connection</h1><p>Connect Alisse Intl to StockLens using the credentials and refresh token you generated in Seller Central. Credentials are verified with Amazon before they are encrypted and saved.</p></section>${statusMessage ? `<div class="notice ${statusTone}">${htmlEscape(statusMessage)}</div>` : ""}
  ${!options.authorized ? `<section class="card locked" style="margin-top:18px"><h2>Administrator access required</h2><p>Enter the StockLens administrator key to view or change the Amazon connection.</p><form method="post" action="/setup/amazon"><input type="hidden" name="action" value="unlock"><label for="adminKey">Administrator key <span>Required</span></label><input id="adminKey" name="adminKey" type="password" required autocomplete="current-password" autofocus placeholder="Enter administrator key"><button type="submit">Unlock Amazon setup</button></form></section>` : `<div class="grid"><section class="card"><h2>${connected ? "Update Amazon credentials" : "Connect Amazon"}</h2><p>Paste the three values from your Amazon app registration. Historical month-end reports require the Amazon Fulfillment role and a refresh token generated after that role was added.</p><form method="post" action="/setup/amazon"><input type="hidden" name="action" value="connect"><label for="clientId">LWA Client ID <span>Required</span></label><input id="clientId" name="clientId" required autocomplete="off" placeholder="amzn1.application-oa2-client…"><label for="clientSecret">LWA Client Secret <span>Required</span></label><input id="clientSecret" name="clientSecret" type="password" required autocomplete="new-password" placeholder="Enter client secret"><label for="refreshToken">Refresh token <span>Required</span></label><input id="refreshToken" name="refreshToken" type="password" required autocomplete="new-password" placeholder="Atzr|…"><button type="submit">Verify and ${connected ? "update" : "save"} connection</button></form><div class="security"><strong>Protected storage</strong><br>StockLens validates these values with Amazon first, then stores one AES-256-GCM encrypted record. Saved secrets are never displayed again.</div></section><section class="card"><h2>Connection status</h2><div class="status"><span class="dot"></span><div><strong>${connected ? "Connected" : "Not connected"}</strong><small>${connected ? `Last verified ${htmlEscape(new Date(options.row!.last_tested_at).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }))}` : "No credentials are stored"}</small></div></div>${connected ? `<form method="post" action="/setup/amazon"><input type="hidden" name="action" value="test"><button class="secondary" type="submit">Test saved connection</button></form>` : ""}<h2 style="margin-top:24px">Authorized marketplaces</h2><div style="overflow:auto"><table><thead><tr><th>Marketplace</th><th>Country</th><th>Currency</th><th>Status</th></tr></thead><tbody>${marketplaceRows}</tbody></table></div></section></div>`}
  </main></body></html>`;
};

const shopifySetupPage = (options: { authorized: boolean; row?: ShopifyConnectionRow | null; message?: string; error?: string }) => {
  const connected = !!options.row;
  let scopes: string[] = [];
  try { scopes = JSON.parse(options.row?.scopes_json || "[]") as string[]; } catch { scopes = []; }
  const missingScopes = SHOPIFY_REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  const statusMessage = options.error || options.message || "";
  const storeHandle = options.row?.shop_domain?.replace(/\.myshopify\.com$/i, "") || "";
  const permissionRows = [
    ["Products", "Read and update products", ["read_products", "write_products"]],
    ["Sales", "Read orders and sales transactions", ["read_orders"]],
    ["Traffic", "Read Shopify reports and analytics", ["read_reports"]],
    ["Inventory", "Read and update inventory at locations", ["read_inventory", "write_inventory", "read_locations"]],
  ].map(([name, description, required]) => {
    const requiredScopes = required as string[], ready = requiredScopes.every((scope) => scopes.includes(scope));
    return `<tr><td><strong>${name}</strong><small>${description}</small></td><td><span class="pill ${ready ? "good" : "warn"}">${ready ? "Ready" : connected ? "Permission missing" : "Not checked"}</span></td><td><small>${requiredScopes.map(htmlEscape).join(", ")}</small></td></tr>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shopify connection · StockLens</title><style>
    :root{color-scheme:light;--green:#123f2b;--lime:#d9ef42;--ink:#183126;--muted:#5e7067;--line:#d9e2dc;--bg:#eef3ef;--red:#9f2e21}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#e7f0ea,#f8faf8 45%,#edf3ef);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5}main{width:min(1040px,calc(100% - 28px));margin:28px auto 60px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}.brand,.back{color:var(--green);font-weight:900;text-decoration:none}.brand{font-size:1.2rem}.hero,.card{background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 40px rgba(23,57,41,.08)}.hero{padding:28px;background:linear-gradient(135deg,#123f2b,#1d5b3e);color:#fff}.hero small{font-weight:900;letter-spacing:.09em;color:var(--lime)}h1{margin:6px 0 8px;font-size:clamp(1.8rem,4vw,2.8rem);line-height:1.1}.hero p{max-width:760px;margin:0;color:#dce9e1}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.card{padding:22px}.card h2{margin:0 0 5px;font-size:1.25rem}.card>p{margin:0 0 16px;color:var(--muted)}label{display:block;margin:14px 0 5px;font-weight:800}label span{color:var(--red);font-size:.82rem}input{width:100%;min-height:48px;padding:11px 12px;border:2px solid #b8c8be;border-radius:10px;font:inherit}input:focus{outline:3px solid rgba(217,239,66,.5);border-color:var(--green)}button,.button{display:inline-block;min-height:48px;margin-top:18px;padding:11px 18px;border:0;border-radius:10px;background:var(--lime);color:#163726;font:inherit;font-weight:900;cursor:pointer;text-decoration:none}button.secondary{background:#e8f0eb}.notice{margin:18px 0 0;padding:13px 15px;border-radius:12px;font-weight:800}.notice.success{background:#e3f5e8;color:#146238}.notice.error{background:#fae8e5;color:#8f2b20}.status{display:flex;align-items:center;gap:10px;margin:14px 0 18px;padding:14px;border-radius:12px;background:${connected ? "#e3f5e8" : "#f2f4f2"}}.dot{width:12px;height:12px;border-radius:50%;background:${connected ? "#20a35a" : "#89978f"}}.status strong,.status small,td small{display:block}.status small,td small{color:var(--muted)}ol{padding-left:22px;color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;border-bottom:1px solid #e8ede9;text-align:left;vertical-align:top;font-size:.9rem}th{color:var(--muted);font-size:.78rem;text-transform:uppercase}.pill{display:inline-block;padding:4px 8px;border-radius:999px;font-size:.75rem;font-weight:900}.pill.good{background:#e3f5e8;color:#146238}.pill.warn{background:#fff2cf;color:#765a00}.security{margin-top:16px;padding:14px;border-radius:12px;background:#f4f7f5;color:var(--muted);font-size:.88rem}.locked{margin-top:18px}.locked input{border-color:#667d70}.locked button{width:100%}.missing{margin-top:12px;padding:12px;border-radius:10px;background:#fff2cf;color:#664f00;font-weight:750}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero,.card{border-radius:16px;padding:19px}th:nth-child(3),td:nth-child(3){display:none}}
  </style></head><body><main><div class="top"><a class="brand" href="/">StockLens</a><a class="back" href="/">← All tools</a></div><section class="hero"><small>SHOPIFY ADMIN API</small><h1>Shopify connection</h1><p>Connect StockLens to your Shopify store so product, order, traffic-report, and inventory tools can use one verified connection.</p></section>${statusMessage ? `<div class="notice ${options.error ? "error" : "success"}">${htmlEscape(statusMessage)}</div>` : ""}
  ${!options.authorized ? `<section class="card locked"><h2>Administrator access required</h2><p>Enter the StockLens administrator key before viewing or changing the Shopify connection.</p><form method="post" action="/setup/shopify"><input type="hidden" name="action" value="unlock"><label for="adminKey">Administrator key <span>Required</span></label><input id="adminKey" name="adminKey" type="password" required autocomplete="current-password" autofocus placeholder="Enter administrator key"><button type="submit">Unlock Shopify setup</button></form></section>` : `<div class="grid"><section class="card"><h2>${connected ? "Update Shopify connection" : "Connect Shopify"}</h2><p>Create and install a StockLens custom app in Shopify's Dev Dashboard, then enter its app credentials here.</p><ol><li>In Shopify Admin, open <strong>Settings → Apps → Develop apps → Build apps in Dev Dashboard</strong>.</li><li>Create and release an app version with the permissions shown on this page, then install it on your store.</li><li>Open the app's <strong>Settings</strong> in the Dev Dashboard and copy the Client ID and Client secret.</li></ol><form method="post" action="/setup/shopify"><input type="hidden" name="action" value="connect"><label for="shopDomain">Shopify store <span>Required</span></label><input id="shopDomain" name="shopDomain" required autocomplete="off" value="${htmlEscape(options.row?.shop_domain || "")}" placeholder="your-store.myshopify.com"><label for="clientId">Client ID <span>Required</span></label><input id="clientId" name="clientId" required autocomplete="off" placeholder="Enter Shopify Client ID"><label for="clientSecret">Client secret <span>Required</span></label><input id="clientSecret" name="clientSecret" type="password" required autocomplete="new-password" placeholder="Enter Shopify Client secret"><button type="submit">Verify and ${connected ? "update" : "save"} connection</button></form><div class="security"><strong>Protected storage</strong><br>StockLens exchanges the credentials for a short-lived Shopify access token, verifies the store, and encrypts the Client ID and secret with AES-256-GCM. Access tokens are renewed automatically.</div></section><section class="card"><h2>Connection status</h2><div class="status"><span class="dot"></span><div><strong>${connected ? htmlEscape(options.row?.shop_name || options.row?.shop_domain) : "Not connected"}</strong><small>${connected ? `${htmlEscape(options.row?.shop_domain)} · last verified ${htmlEscape(new Date(options.row!.last_tested_at).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }))}` : "No Shopify credentials are stored"}</small></div></div>${connected ? `<form method="post" action="/setup/shopify"><input type="hidden" name="action" value="test"><button class="secondary" type="submit">Test saved connection</button></form>${storeHandle ? `<a class="button" style="margin-left:8px;background:#e8f0eb" href="https://admin.shopify.com/store/${htmlEscape(storeHandle)}/settings/apps" target="_blank" rel="noreferrer">Open Shopify apps</a>` : ""}` : ""}<h2 style="margin-top:24px">Data permissions</h2><div style="overflow:auto"><table><thead><tr><th>Data</th><th>Status</th><th>Required permissions</th></tr></thead><tbody>${permissionRows}</tbody></table></div>${connected && missingScopes.length ? `<div class="missing">Missing: ${missingScopes.map(htmlEscape).join(", ")}. Add these scopes to a new app version, release it, approve the update on the store, then test again.</div>` : connected ? `<div class="notice success">Products, sales, reports, locations, and inventory permissions are ready.</div>` : ""}<p style="margin-top:15px;color:var(--muted);font-size:.88rem">Older order history may later require Shopify approval for <strong>read_all_orders</strong>; it is not required for this first connection.</p></section></div>`}
  </main></body></html>`;
};

const amazonHtmlResponse = (html: string, init: ResponseInit = {}) => new Response(html, {
  ...init,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(init.headers || {}),
  },
});

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/shopify/variants") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
      try {
        if (url.searchParams.get("source") === "saved") {
          const result = await env.DB.prepare(`SELECT variant_id, product_id, sku, title, product_title,
            product_status, barcode, imported_at FROM shopify_variant_snapshot ORDER BY product_title, title`).all();
          const variants = (result.results || []).map((row) => ({
            variantId: String(row.variant_id || ""), productId: String(row.product_id || ""), sku: String(row.sku || ""),
            title: String(row.title || ""), productTitle: String(row.product_title || ""), productStatus: String(row.product_status || ""), barcode: String(row.barcode || ""),
          }));
          return Response.json({ variants, importedAt: String(result.results?.[0]?.imported_at || ""), source: "saved" }, { headers: { "cache-control": "no-store" } });
        }
        return Response.json({ ...(await fetchShopifyVariants(env)), source: "live" }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Shopify variants could not be imported" }, { status: 502 });
      }
    }

    if (url.pathname === "/api/shopify/mappings") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      if (request.method === "GET") {
        const result = await env.DB.prepare(`SELECT variant_id, product_id, shopify_sku, woh_sku, workflow_status,
          confirmed, assembly_components, knowledge_source, updated_at FROM shopify_item_mapping ORDER BY variant_id`).all();
        return Response.json({ mappings: result.results || [] }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json() as { variantId?: string; productId?: string; shopifySku?: string; wohSku?: string; workflowStatus?: string; confirmed?: boolean; assemblyComponents?: Array<{ sku?: string; quantity?: number; wohSku?: string }>; knowledgeSource?: string };
        if (!payload.variantId || !payload.productId) return Response.json({ error: "Shopify variant identity is required" }, { status: 400 });
        const workflowStatus = ["Exact Matches", "Assemblies", "Assy Auto Matched", "Deferred", "Manually Matched", "Unmatched", "UPC error"].includes(payload.workflowStatus || "") ? payload.workflowStatus! : "Unmatched";
        const isAssembly = workflowStatus === "Assemblies" || workflowStatus === "Assy Auto Matched";
        const assemblyComponents = JSON.stringify({
          confirmed: isAssembly && payload.confirmed === true,
          components: (payload.assemblyComponents || []).slice(0, 10).map((component) => ({
            sku: String(component.sku || "").trim(), quantity: Math.max(0, Number(component.quantity) || 0), wohSku: String(component.wohSku || "").trim(),
          })),
        });
        const updatedAt = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO shopify_item_mapping
          (variant_id, product_id, shopify_sku, woh_sku, workflow_status, confirmed, assembly_components, knowledge_source, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(variant_id) DO UPDATE SET product_id = excluded.product_id, shopify_sku = excluded.shopify_sku,
          woh_sku = excluded.woh_sku, workflow_status = excluded.workflow_status, confirmed = excluded.confirmed,
          assembly_components = excluded.assembly_components, knowledge_source = excluded.knowledge_source, updated_at = excluded.updated_at`)
          .bind(payload.variantId, payload.productId, payload.shopifySku || "", payload.wohSku || "", workflowStatus,
            payload.confirmed === true ? 1 : 0, assemblyComponents, payload.knowledgeSource || "User review", updatedAt).run();
        return Response.json({ saved: true, updatedAt }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/setup/google-drive/callback" && request.method === "GET") {
      try {
        if (!env.STOCKLENS_ADMIN_KEY) throw new Error("Administrator access is not configured.");
        const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
        if (!(await validGoogleDriveState(state, env.STOCKLENS_ADMIN_KEY)) || !code)
          throw new Error(url.searchParams.get("error_description") || "The Google Drive authorization expired or was not accepted.");
        const row = await googleDriveConnectionRecord(env);
        if (!row) throw new Error("The pending Google Drive connection could not be found. Start the connection again.");
        const prior = await decryptGoogleDriveCredentials(row, env);
        const redirectUri = `${url.origin}/setup/google-drive/callback`;
        const exchanged = await exchangeGoogleDriveAuthorizationCode(prior.clientSecret, code, redirectUri);
        const refreshToken = exchanged.refreshToken || prior.refreshToken;
        if (!refreshToken) throw new Error("Google did not return long-lived access. Reconnect and approve access when prompted.");
        const verified = await verifyGoogleDriveAccess(exchanged.accessToken);
        const encrypted = await encryptGoogleDriveCredentials({ clientSecret: prior.clientSecret, refreshToken }, env);
        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE google_drive_connection SET credentials_ciphertext = ?, credentials_iv = ?, account_email = ?, updated_at = ?, last_tested_at = ? WHERE id = 1`)
          .bind(encrypted.ciphertext, encrypted.iv, verified.email, now, now).run();
        const expiresAt = Date.now() + EBAY_ADMIN_SESSION_MS;
        const sessionToken = await signAdminSession(expiresAt, env.STOCKLENS_ADMIN_KEY);
        return new Response(null, { status: 303, headers: { location: "/setup/google-drive?connected=1", "set-cookie": `${EBAY_ADMIN_COOKIE}=${sessionToken}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict` } });
      } catch (error) {
        return amazonHtmlResponse(googleDriveSetupPage({ authorized: false, error: error instanceof Error ? error.message : "Google Drive could not be connected." }), { status: 400 });
      }
    }

    if (url.pathname === "/setup/google-drive") {
      const sessionAuthorized = await hasEbayAdminAccess(request, env);
      if (request.method === "GET") {
        const row = sessionAuthorized ? await googleDriveConnectionRecord(env).catch(() => null) : null;
        const message = url.searchParams.get("connected") === "1" ? "Google Drive nightly access is connected. Inventory will refresh before every nightly eBay listing fetch." : url.searchParams.get("tested") === "1" ? "The saved Google Drive nightly access was verified successfully." : "";
        return amazonHtmlResponse(googleDriveSetupPage({ authorized: sessionAuthorized, row, message }));
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
      if (!env.STOCKLENS_ADMIN_KEY)
        return amazonHtmlResponse(googleDriveSetupPage({ authorized: false, error: "Administrator access is not configured." }), { status: 503 });
      const form = await request.formData().catch(() => null);
      const action = String(form?.get("action") || ""), submittedAdminKey = String(form?.get("adminKey") || "");
      const authorized = sessionAuthorized || submittedAdminKey === env.STOCKLENS_ADMIN_KEY;
      if (!authorized) return amazonHtmlResponse(googleDriveSetupPage({ authorized: false, error: "The administrator key was not accepted." }), { status: 403 });
      const expiresAt = Date.now() + EBAY_ADMIN_SESSION_MS;
      const sessionToken = await signAdminSession(expiresAt, env.STOCKLENS_ADMIN_KEY);
      const sessionCookie = `${EBAY_ADMIN_COOKIE}=${sessionToken}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`;
      const existingRow = await googleDriveConnectionRecord(env).catch(() => null);
      if (action === "unlock") return amazonHtmlResponse(googleDriveSetupPage({ authorized: true, row: existingRow }), { headers: { "set-cookie": sessionCookie } });
      try {
        if (action === "connect") {
          const prior = existingRow ? await decryptGoogleDriveCredentials(existingRow, env) : null;
          const clientSecret = String(form?.get("clientSecret") || "").trim() || prior?.clientSecret || "";
          if (!clientSecret) throw new Error("Enter the client secret from the existing StockLens Google OAuth web client.");
          const pending = await encryptGoogleDriveCredentials({ clientSecret, refreshToken: prior?.refreshToken || "" }, env);
          const now = new Date().toISOString();
          await env.DB.prepare(`INSERT INTO google_drive_connection
            (id, credentials_ciphertext, credentials_iv, account_email, connected_at, updated_at, last_tested_at)
            VALUES (1, ?, ?, '', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET credentials_ciphertext = excluded.credentials_ciphertext, credentials_iv = excluded.credentials_iv, account_email = '', updated_at = excluded.updated_at`)
            .bind(pending.ciphertext, pending.iv, existingRow?.connected_at || now, now, existingRow?.last_tested_at || now).run();
          const state = await signGoogleDriveState(Date.now() + 10 * 60 * 1000, env.STOCKLENS_ADMIN_KEY);
          const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
          authorize.search = new URLSearchParams({ client_id: GOOGLE_DRIVE_CLIENT_ID, redirect_uri: `${url.origin}/setup/google-drive/callback`, response_type: "code", scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
          return amazonHtmlResponse(googleDriveAuthorizationProgressPage(authorize.toString()), { headers: { "set-cookie": sessionCookie } });
        }
        if (action === "test") {
          if (!existingRow) throw new Error("Connect Google Drive nightly access before testing it.");
          const credentials = await decryptGoogleDriveCredentials(existingRow, env);
          const accessToken = await getGoogleDriveAccessToken(credentials);
          const verified = await verifyGoogleDriveAccess(accessToken), now = new Date().toISOString();
          await env.DB.prepare("UPDATE google_drive_connection SET account_email = ?, updated_at = ?, last_tested_at = ? WHERE id = 1")
            .bind(verified.email, now, now).run();
          return new Response(null, { status: 303, headers: { location: "/setup/google-drive?tested=1", "set-cookie": sessionCookie } });
        }
        throw new Error("Choose a valid Google Drive connection action.");
      } catch (error) {
        return amazonHtmlResponse(googleDriveSetupPage({ authorized: true, row: existingRow, error: error instanceof Error ? error.message : "Google Drive could not verify the connection." }), { status: 400, headers: { "set-cookie": sessionCookie } });
      }
    }

    if (url.pathname === "/setup/shopify") {
      const sessionAuthorized = await hasEbayAdminAccess(request, env);
      if (request.method === "GET") {
        const row = sessionAuthorized ? await shopifyConnectionRecord(env).catch(() => null) : null;
        const message = url.searchParams.get("connected") === "1"
          ? "Shopify verified the store and app credentials. The connection is encrypted and saved."
          : url.searchParams.get("tested") === "1" ? "The saved Shopify connection was verified successfully." : "";
        return amazonHtmlResponse(shopifySetupPage({ authorized: sessionAuthorized, row, message }));
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
      if (!env.STOCKLENS_ADMIN_KEY)
        return amazonHtmlResponse(shopifySetupPage({ authorized: false, error: "Administrator access is not configured." }), { status: 503 });
      const form = await request.formData().catch(() => null);
      const action = String(form?.get("action") || ""), submittedAdminKey = String(form?.get("adminKey") || "");
      const authorized = sessionAuthorized || submittedAdminKey === env.STOCKLENS_ADMIN_KEY;
      if (!authorized) return amazonHtmlResponse(shopifySetupPage({ authorized: false, error: "The administrator key was not accepted." }), { status: 403 });
      const expiresAt = Date.now() + EBAY_ADMIN_SESSION_MS;
      const sessionToken = await signAdminSession(expiresAt, env.STOCKLENS_ADMIN_KEY);
      const sessionCookie = `${EBAY_ADMIN_COOKIE}=${sessionToken}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`;
      const existingRow = await shopifyConnectionRecord(env).catch(() => null);
      if (action === "unlock") return amazonHtmlResponse(shopifySetupPage({ authorized: true, row: existingRow }), { headers: { "set-cookie": sessionCookie } });
      try {
        if (action === "connect") {
          const shopDomain = normalizeShopifyDomain(String(form?.get("shopDomain") || ""));
          const credentials = { clientId: String(form?.get("clientId") || "").trim(), clientSecret: String(form?.get("clientSecret") || "").trim() };
          if (!credentials.clientId || !credentials.clientSecret) throw new Error("Enter both the Shopify Client ID and Client secret.");
          const accessToken = await getShopifyAccessToken(shopDomain, credentials);
          const verified = await verifyShopifyConnection(shopDomain, accessToken);
          const encrypted = await encryptShopifyCredentials(credentials, env), now = new Date().toISOString();
          await env.DB.prepare(`INSERT INTO shopify_connection
            (id, shop_domain, shop_name, credentials_ciphertext, credentials_iv, scopes_json, connected_at, updated_at, last_tested_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET shop_domain = excluded.shop_domain, shop_name = excluded.shop_name,
            credentials_ciphertext = excluded.credentials_ciphertext, credentials_iv = excluded.credentials_iv,
            scopes_json = excluded.scopes_json, updated_at = excluded.updated_at, last_tested_at = excluded.last_tested_at`)
            .bind(verified.shopDomain, verified.shopName, encrypted.ciphertext, encrypted.iv, JSON.stringify(verified.scopes), existingRow?.connected_at || now, now, now).run();
          return new Response(null, { status: 303, headers: { location: "/setup/shopify?connected=1", "set-cookie": sessionCookie } });
        }
        if (action === "test") {
          if (!existingRow) throw new Error("Connect Shopify before testing saved credentials.");
          const credentials = await decryptShopifyCredentials(existingRow, env);
          const accessToken = await getShopifyAccessToken(existingRow.shop_domain, credentials);
          const verified = await verifyShopifyConnection(existingRow.shop_domain, accessToken), now = new Date().toISOString();
          await env.DB.prepare("UPDATE shopify_connection SET shop_domain = ?, shop_name = ?, scopes_json = ?, updated_at = ?, last_tested_at = ? WHERE id = 1")
            .bind(verified.shopDomain, verified.shopName, JSON.stringify(verified.scopes), now, now).run();
          return new Response(null, { status: 303, headers: { location: "/setup/shopify?tested=1", "set-cookie": sessionCookie } });
        }
        throw new Error("Choose a valid Shopify connection action.");
      } catch (error) {
        return amazonHtmlResponse(shopifySetupPage({ authorized: true, row: existingRow, error: error instanceof Error ? error.message : "Shopify could not verify the connection." }), { status: 400, headers: { "set-cookie": sessionCookie } });
      }
    }

    if (url.pathname === "/setup/amazon") {
      const sessionAuthorized = await hasEbayAdminAccess(request, env);
      if (request.method === "GET") {
        const row = sessionAuthorized ? await amazonConnectionRecord(env).catch(() => null) : null;
        const message = url.searchParams.get("connected") === "1"
          ? "Amazon verified the credentials. The connection is encrypted and saved."
          : url.searchParams.get("tested") === "1"
            ? "The saved Amazon connection was verified successfully."
            : "";
        return amazonHtmlResponse(amazonSetupPage({ authorized: sessionAuthorized, row, message }));
      }
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
      if (!env.STOCKLENS_ADMIN_KEY)
        return amazonHtmlResponse(amazonSetupPage({ authorized: false, error: "Administrator access is not configured." }), { status: 503 });

      const form = await request.formData().catch(() => null);
      const action = String(form?.get("action") || "");
      const submittedAdminKey = String(form?.get("adminKey") || "");
      const authorized = sessionAuthorized || submittedAdminKey === env.STOCKLENS_ADMIN_KEY;
      if (!authorized)
        return amazonHtmlResponse(amazonSetupPage({ authorized: false, error: "The administrator key was not accepted." }), { status: 403 });

      const expiresAt = Date.now() + EBAY_ADMIN_SESSION_MS;
      const sessionToken = await signAdminSession(expiresAt, env.STOCKLENS_ADMIN_KEY);
      const sessionCookie = `${EBAY_ADMIN_COOKIE}=${sessionToken}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`;
      if (action === "unlock") {
        const row = await amazonConnectionRecord(env).catch(() => null);
        return amazonHtmlResponse(amazonSetupPage({ authorized: true, row }), { headers: { "set-cookie": sessionCookie } });
      }

      const existingRow = await amazonConnectionRecord(env).catch(() => null);
      try {
        if (action === "connect") {
          const credentials = {
            clientId: String(form?.get("clientId") || "").trim(),
            clientSecret: String(form?.get("clientSecret") || "").trim(),
            refreshToken: String(form?.get("refreshToken") || "").trim(),
          };
          if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken)
            throw new Error("Enter the LWA Client ID, LWA Client Secret, and refresh token.");
          const marketplaces = await verifyAmazonConnection(credentials);
          const encrypted = await encryptAmazonCredentials(credentials, env);
          const now = new Date().toISOString();
          await env.DB.prepare(`INSERT INTO amazon_connection
            (id, credentials_ciphertext, credentials_iv, region, marketplaces_json, connected_at, updated_at, last_tested_at)
            VALUES (1, ?, ?, 'na', ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET credentials_ciphertext = excluded.credentials_ciphertext,
            credentials_iv = excluded.credentials_iv, region = excluded.region,
            marketplaces_json = excluded.marketplaces_json, updated_at = excluded.updated_at,
            last_tested_at = excluded.last_tested_at`)
            .bind(encrypted.ciphertext, encrypted.iv, JSON.stringify(marketplaces), existingRow?.connected_at || now, now, now).run();
          return new Response(null, { status: 303, headers: { location: "/setup/amazon?connected=1", "set-cookie": sessionCookie } });
        }
        if (action === "test") {
          if (!existingRow) throw new Error("Connect Amazon before testing saved credentials.");
          const credentials = await decryptAmazonCredentials(existingRow, env);
          const marketplaces = await verifyAmazonConnection(credentials);
          const now = new Date().toISOString();
          await env.DB.prepare("UPDATE amazon_connection SET marketplaces_json = ?, updated_at = ?, last_tested_at = ? WHERE id = 1")
            .bind(JSON.stringify(marketplaces), now, now).run();
          return new Response(null, { status: 303, headers: { location: "/setup/amazon?tested=1", "set-cookie": sessionCookie } });
        }
        throw new Error("Choose a valid Amazon connection action.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Amazon could not verify the connection.";
        return amazonHtmlResponse(amazonSetupPage({ authorized: true, row: existingRow, error: message }), {
          status: 400,
          headers: { "set-cookie": sessionCookie },
        });
      }
    }

    if (url.pathname === "/api/amazon/replenishment/start" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const row = await amazonConnectionRecord(env).catch(() => null);
      if (!row) return Response.json({ error: "Connect Amazon before loading replenishment recommendations" }, { status: 409 });
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const result = await startAmazonReplenishmentReport(row, env, String(body.marketplaceId || ""), body.forceRefresh === true);
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return amazonReportsErrorResponse(error, "Amazon replenishment recommendations could not be started");
      }
    }

    if (url.pathname === "/api/amazon/replenishment/status" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const row = await amazonConnectionRecord(env).catch(() => null);
      if (!row) return Response.json({ error: "Connect Amazon before loading replenishment recommendations" }, { status: 409 });
      const reportId = String(url.searchParams.get("reportId") || "");
      if (!reportId) return Response.json({ error: "Amazon report ID is required" }, { status: 400 });
      try {
        return Response.json(await getAmazonReplenishmentReport(row, env, reportId), { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return amazonReportsErrorResponse(error, "Amazon replenishment recommendations could not be loaded");
      }
    }

    if (url.pathname === "/api/amazon/replenishment/replacements") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") {
        const result = await env.DB.prepare(`SELECT id, target_woh_sku AS targetWohSku, source_woh_sku AS sourceWohSku,
          source_units_per_target AS sourceUnitsPerTarget, active, source_user AS sourceUser, updated_at AS updatedAt
          FROM amazon_replacement_decision ORDER BY updated_at DESC, id DESC`).all();
        return Response.json({ decisions: result.results || [] }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const targetWohSku = String(body.targetWohSku || "").trim();
        if (!targetWohSku) return Response.json({ error: "Target WOH SKU is required" }, { status: 400 });
        const requestedSources = Array.isArray(body.sources) ? body.sources : body.sourceWohSku ? [{ sourceWohSku: body.sourceWohSku, sourceUnitsPerTarget: body.sourceUnitsPerTarget }] : [];
        const uniqueSources = new Map<string, { sourceWohSku: string; sourceUnitsPerTarget: number }>();
        for (const value of requestedSources) {
          if (!value || typeof value !== "object") continue;
          const entry = value as Record<string, unknown>, sourceWohSku = String(entry.sourceWohSku || "").trim();
          if (!sourceWohSku || sourceWohSku.toLowerCase() === targetWohSku.toLowerCase()) continue;
          const requestedRatio = Number(entry.sourceUnitsPerTarget ?? 1);
          const sourceUnitsPerTarget = Number.isFinite(requestedRatio) && requestedRatio > 0
            ? Math.round(requestedRatio * 10_000) / 10_000
            : 1;
          uniqueSources.set(sourceWohSku.toLowerCase(), { sourceWohSku, sourceUnitsPerTarget });
        }
        const sources = [...uniqueSources.values()];
        if (sources.length > 2) return Response.json({ error: "Choose no more than two alternate WOH SKUs" }, { status: 400 });
        const now = new Date().toISOString();
        const statements = [env.DB.prepare("UPDATE amazon_replacement_decision SET active = 0 WHERE lower(target_woh_sku) = lower(?)").bind(targetWohSku)];
        for (const source of sources) statements.push(env.DB.prepare(`INSERT INTO amazon_replacement_decision
          (target_woh_sku, source_woh_sku, source_units_per_target, active, source_user, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)`).bind(targetWohSku, source.sourceWohSku, source.sourceUnitsPerTarget, String(body.sourceUser || "StockLens user"), now));
        await env.DB.batch(statements);
        const active = await env.DB.prepare(`SELECT id, target_woh_sku AS targetWohSku, source_woh_sku AS sourceWohSku,
          source_units_per_target AS sourceUnitsPerTarget, active, source_user AS sourceUser, updated_at AS updatedAt
          FROM amazon_replacement_decision WHERE lower(target_woh_sku) = lower(?) AND active = 1 ORDER BY id`)
          .bind(targetWohSku).all();
        return Response.json({ targetWohSku, decisions: active.results || [], cleared: sources.length === 0, updatedAt: now });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/amazon/replenishment/decisions") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") {
        const reportId = String(url.searchParams.get("reportId") || "").trim();
        if (!reportId) return Response.json({ error: "Amazon report ID is required" }, { status: 400 });
        const result = await env.DB.prepare(`SELECT id, report_id AS reportId, line_key AS lineKey, decision_type AS decisionType,
          value_json AS valueJson, active, source_user AS sourceUser, updated_at AS updatedAt
          FROM amazon_replenishment_item_decision WHERE report_id = ? ORDER BY updated_at DESC, id DESC`).bind(reportId).all();
        return Response.json({ decisions: result.results || [] }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const reportId = String(body.reportId || "").trim(), lineKey = String(body.lineKey || "").trim();
        const decisionType = String(body.decisionType || "quantity_override").trim();
        if (!reportId || !lineKey) return Response.json({ error: "Amazon report ID and line key are required" }, { status: 400 });
        if (decisionType !== "quantity_override") return Response.json({ error: "Unsupported replenishment decision type" }, { status: 400 });
        const value = body.value && typeof body.value === "object" ? body.value : {};
        const quantity = (value as Record<string, unknown>).quantity;
        const cleared = (value as Record<string, unknown>).cleared === true;
        if (!cleared && (!Number.isFinite(Number(quantity)) || Number(quantity) < 0)) return Response.json({ error: "Confirmed quantity must be zero or greater" }, { status: 400 });
        const valueJson = JSON.stringify(cleared ? { cleared: true } : { quantity: Math.floor(Number(quantity)) });
        const sourceUser = String(body.sourceUser || "StockLens user"), now = new Date().toISOString();
        const update = env.DB.prepare(`UPDATE amazon_replenishment_item_decision SET active = 0
          WHERE report_id = ? AND line_key = ? AND decision_type = ?`).bind(reportId, lineKey, decisionType);
        const insert = env.DB.prepare(`INSERT INTO amazon_replenishment_item_decision
          (report_id, line_key, decision_type, value_json, active, source_user, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)`).bind(reportId, lineKey, decisionType, valueJson, sourceUser, now);
        await env.DB.batch([update, insert]);
        return Response.json({ reportId, lineKey, decisionType, valueJson, active: true, sourceUser, updatedAt: now });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/amazon/replenishment/runs") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") {
        const id = String(url.searchParams.get("id") || "");
        if (id) {
          const run = await env.DB.prepare(`SELECT id, marketplace_id AS marketplaceId, report_id AS reportId,
            amazon_retrieved_at AS amazonRetrievedAt, master_versions_json AS masterVersionsJson,
            settings_json AS settingsJson, plan_json AS planJson, verification_json AS verificationJson,
            finalized, created_at AS createdAt, updated_at AS updatedAt FROM amazon_replenishment_run WHERE id = ?`).bind(id).first();
          return run ? Response.json({ run }, { headers: { "cache-control": "no-store" } }) : Response.json({ error: "Saved run was not found" }, { status: 404 });
        }
        const result = await env.DB.prepare(`SELECT id, marketplace_id AS marketplaceId, report_id AS reportId,
          amazon_retrieved_at AS amazonRetrievedAt, settings_json AS settingsJson, verification_json AS verificationJson,
          finalized, created_at AS createdAt, updated_at AS updatedAt FROM amazon_replenishment_run ORDER BY created_at DESC LIMIT 50`).all();
        return Response.json({ runs: result.results || [] }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const id = String(body.id || crypto.randomUUID()), now = new Date().toISOString();
        const plan = Array.isArray(body.plan) ? body.plan : [];
        const json = (value: unknown, fallback: unknown) => JSON.stringify(value ?? fallback);
        await env.DB.prepare(`INSERT INTO amazon_replenishment_run
          (id, marketplace_id, report_id, amazon_retrieved_at, master_versions_json, settings_json,
           plan_json, verification_json, finalized, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET master_versions_json = excluded.master_versions_json,
          settings_json = excluded.settings_json, plan_json = excluded.plan_json,
          verification_json = excluded.verification_json, finalized = excluded.finalized, updated_at = excluded.updated_at`)
          .bind(id, String(body.marketplaceId || ""), String(body.reportId || ""), String(body.amazonRetrievedAt || now),
            json(body.masterVersions, {}), json(body.settings, {}), json(plan, []), json(body.verification, {}), body.finalized === true ? 1 : 0, String(body.createdAt || now), now).run();
        return Response.json({ id, updatedAt: now, rowCount: plan.length });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/amazon/inventory-history/import" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const monthKey = String(body.monthKey || "");
        let marketplaceId = String(body.marketplaceId || "");
        const reportText = String(body.reportText || "");
        if (!/^2026-(0[1-9]|1[0-2])$/.test(monthKey)) throw new Error("A valid 2026 month is required.");
        if (!reportText || reportText.length > 5_000_000) throw new Error("The Amazon report is empty or exceeds the 5 MB import limit.");
        const parsed = parseAmazonInventoryLedger(reportText);
        const unexpectedMonths = [...new Set(parsed.rows.map((entry) => {
          const match = String(entry.date || "").match(/^(\d{1,2})\/(\d{4})$/);
          return match ? `${match[2]}-${match[1].padStart(2, "0")}` : "";
        }).filter((value) => value && value !== monthKey))];
        if (unexpectedMonths.length) throw new Error(`The selected file contains ${unexpectedMonths.join(", ")} data, not ${monthKey}.`);
        if (!marketplaceId) {
          const savedMarketplace = await env.DB.prepare("SELECT marketplace_id FROM amazon_inventory_report_job WHERE month_key = ? LIMIT 1")
            .bind(monthKey).first<{ marketplace_id: string }>();
          marketplaceId = savedMarketplace?.marketplace_id || "";
        }
        if (!marketplaceId) throw new Error("Select the Amazon marketplace before importing reports.");
        const existing = await env.DB.prepare("SELECT report_id FROM amazon_inventory_report_job WHERE month_key = ? AND marketplace_id = ?")
          .bind(monthKey, marketplaceId).first<{ report_id: string }>();
        const reportId = existing?.report_id || `manual-${marketplaceId}-${monthKey}`;
        const startDate = `${monthKey}-01T00:00:00.000Z`;
        const nextMonth = new Date(`${monthKey}-01T00:00:00.000Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
        const endDate = new Date(nextMonth.getTime() - 1).toISOString();
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO amazon_inventory_report_job
          (month_key, marketplace_id, start_date, end_date, report_id, processing_status, rate_limit, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'DONE', 'manual-upload', ?, ?)
          ON CONFLICT(month_key, marketplace_id) DO UPDATE SET report_id = excluded.report_id,
          processing_status = 'DONE', rate_limit = 'manual-upload', updated_at = excluded.updated_at`)
          .bind(monthKey, marketplaceId, startDate, endDate, reportId, now, now).run();
        const retrievedAt = await cacheAmazonInventoryLedger(env, reportId, monthKey, marketplaceId, parsed);
        return Response.json({ reportId, monthKey, processingStatus: "DONE", cached: true, imported: true,
          rawRowCount: parsed.rawRowCount, sellableRowCount: parsed.sellableRowCount,
          sellableUnits: parsed.sellableUnits, retrievedAt }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Amazon inventory report could not be imported" }, {
          status: 400, headers: { "cache-control": "no-store" },
        });
      }
    }

    if (url.pathname === "/api/amazon/inventory-history/start" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const row = await amazonConnectionRecord(env).catch(() => null);
      if (!row) return Response.json({ error: "Connect Amazon before loading inventory history" }, { status: 409 });
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const startDate = String(body.startDate || "2026-01-01T00:00:00.000Z");
        const endDate = String(body.endDate || new Date().toISOString());
        const result = await startAmazonInventoryLedgerReport(row, env, String(body.marketplaceId || ""), startDate, endDate, body.reuseOnly === true);
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return amazonReportsErrorResponse(error, "Amazon inventory history could not be started");
      }
    }

    if (url.pathname === "/api/amazon/inventory-history/status" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const row = await amazonConnectionRecord(env).catch(() => null);
      if (!row) return Response.json({ error: "Connect Amazon before loading inventory history" }, { status: 409 });
      const reportId = String(url.searchParams.get("reportId") || "");
      if (!reportId) return Response.json({ error: "Amazon report ID is required" }, { status: 400 });
      try {
        const result = await getAmazonInventoryLedgerReport(row, env, reportId);
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return amazonReportsErrorResponse(error, "Amazon inventory history could not be loaded");
      }
    }

    if (url.pathname === "/api/amazon/inbound-history" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const row = await amazonConnectionRecord(env).catch(() => null);
      if (!row) return Response.json({ error: "Connect Amazon before loading inbound shipment history" }, { status: 409 });
      try {
        const result = await getAmazonInboundHistory(
          row,
          env,
          String(url.searchParams.get("marketplaceId") || ""),
          String(url.searchParams.get("startDate") || "2026-01-01T00:00:00.000Z"),
          String(url.searchParams.get("endDate") || new Date().toISOString()),
          url.searchParams.get("forceRefresh") === "1",
        );
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Amazon inbound shipment history could not be loaded" }, {
          status: 502,
          headers: { "cache-control": "no-store" },
        });
      }
    }

    if (url.pathname === "/api/amazon/inventory" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const row = await amazonConnectionRecord(env).catch(() => null);
      if (!row)
        return Response.json({ error: "Connect Amazon before loading FBA inventory" }, { status: 409, headers: { "cache-control": "no-store" } });
      try {
        const data = await getAmazonInventory(row, env, String(url.searchParams.get("marketplaceId") || ""));
        return Response.json(data, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Amazon inventory could not be loaded" }, {
          status: 502,
          headers: { "cache-control": "no-store" },
        });
      }
    }

    if (url.pathname === "/api/ebay/admin-session") {
      if (request.method === "GET") {
        const expiresAt = await adminSessionExpiry(request, env);
        return Response.json({ authorized: expiresAt > Date.now(), expiresAt: expiresAt || null }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        if (!env.STOCKLENS_ADMIN_KEY) return Response.json({ error: "Administrator access is not configured" }, { status: 503 });
        const payload = await request.json().catch(() => ({})) as { key?: string };
        if (payload.key !== env.STOCKLENS_ADMIN_KEY)
          return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
        const expiresAt = Date.now() + EBAY_ADMIN_SESSION_MS;
        const token = await signAdminSession(expiresAt, env.STOCKLENS_ADMIN_KEY);
        return Response.json({ authorized: true, expiresAt }, {
          headers: {
            "cache-control": "no-store",
            "set-cookie": `${EBAY_ADMIN_COOKIE}=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`,
          },
        });
      }
      if (request.method === "DELETE") {
        return Response.json({ authorized: false, expiresAt: null }, {
          headers: {
            "cache-control": "no-store",
            "set-cookie": `${EBAY_ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
          },
        });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST, DELETE" } });
    }

    if (url.pathname === "/api/ebay/inventory/nightly-safe-trigger" && request.method === "GET") {
      try {
        const result = await runNightlyEbayInventorySync(env);
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ status: "failed", error: error instanceof Error ? error.message : "The safe nightly eBay review could not be prepared." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }

    if (url.pathname === "/api/inventory/current-ledger" && request.method === "GET") {
      const browserAuthorization = request.headers.get("authorization") || "";
      const browserToken = browserAuthorization.replace(/^Bearer\s+/i, "").trim();
      if (!browserToken)
        return Response.json({ error: "Connect Google Drive before opening the inventory ledger." }, { status: 401, headers: { "cache-control": "no-store" } });
      try {
        // A browser user may read the shared WOH master without having permission to
        // list the separate inventory-ledger folder. WOH access is the authorization
        // boundary for this read-only server fallback; the browser token is never saved.
        await googleDriveFetch(browserToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(WOH_FILE_ID)}?fields=id,name,trashed&supportsAllDrives=true`);
      } catch {
        return Response.json({ error: "This Google account cannot open the StockLens WOH master. Ask the administrator to share the WOH folder with this account, then reconnect Google Drive." }, { status: 403, headers: { "cache-control": "no-store" } });
      }
      try {
        const connection = await googleDriveConnectionRecord(env).catch(() => null);
        if (!connection) throw new Error("The central Google Drive inventory connection is not available.");
        const credentials = await decryptGoogleDriveCredentials(connection, env);
        const accessToken = await getGoogleDriveAccessToken(credentials);
        const inventoryFile = await liveInventoryMovesFile(accessToken);
        const buffer = await downloadGoogleDriveFile(accessToken, inventoryFile.id);
        return new Response(buffer, { headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "cache-control": "no-store",
          "x-stocklens-source-name": encodeURIComponent(inventoryFile.name),
          "x-stocklens-source-modified": inventoryFile.modifiedTime || "",
          "x-stocklens-source-mode": "central-drive",
        } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The current inventory ledger could not be loaded." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }

    if (url.pathname === "/api/ebay/inventory/nightly-run" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const result = await runNightlyEbayInventorySync(env, String(body.runDate || easternRunDate().runDate));
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ status: "failed", error: error instanceof Error ? error.message : "The safe eBay review could not be prepared." }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }

    if (url.pathname === "/api/ebay/inventory/snapshot" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      try {
        const body = await request.json().catch(() => ({})) as { rows?: EbayInventorySyncSnapshotItem[] };
        if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 10_000)
          return Response.json({ error: "A valid inventory-sync result is required." }, { status: 400, headers: { "cache-control": "no-store" } });
        const sourceUpdatedAt = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO ebay_inventory_sync_snapshot (id, rows_json, source_updated_at)
          VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET rows_json = excluded.rows_json, source_updated_at = excluded.source_updated_at`)
          .bind(JSON.stringify(body.rows), sourceUpdatedAt).run();
        return Response.json({ saved: body.rows.length, sourceUpdatedAt }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "The nightly WOH snapshot could not be saved." }, { status: 500, headers: { "cache-control": "no-store" } });
      }
    }

    if (url.pathname === "/api/ebay/inventory/nightly-status") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const runDate = String(body.runDate || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) return Response.json({ error: "A valid nightly run date is required." }, { status: 400 });
        const approvedAt = new Date().toISOString();
        const result = await env.DB.prepare("UPDATE ebay_inventory_sync_run SET approved_at = ? WHERE run_date = ? AND status = 'completed'")
          .bind(approvedAt, runDate).run();
        if (!result.meta.changes) return Response.json({ error: "The completed nightly review was not found." }, { status: 404 });
        return Response.json({ runDate, approvedAt, message: "Review approval recorded. No eBay quantity update was sent." }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET") {
        const snapshot = await env.DB.prepare("SELECT source_updated_at FROM ebay_inventory_sync_snapshot WHERE id = 1").first<{ source_updated_at: string }>();
        const googleDrive = await env.DB.prepare("SELECT account_email, last_tested_at FROM google_drive_connection WHERE id = 1").first<{ account_email: string; last_tested_at: string }>();
        const run = await env.DB.prepare(`SELECT run_date, status, started_at, completed_at, snapshot_updated_at,
          rows_json, listing_count, change_count, review_count, error, approved_at
          FROM ebay_inventory_sync_run ORDER BY run_date DESC LIMIT 1`).first<Record<string, unknown>>();
        const googleDriveStatus = { connected: Boolean(googleDrive?.account_email), accountEmail: googleDrive?.account_email || "", lastTestedAt: googleDrive?.last_tested_at || "" };
        if (!run) return Response.json({ snapshotUpdatedAt: snapshot?.source_updated_at || "", googleDrive: googleDriveStatus, run: null }, { headers: { "cache-control": "no-store" } });
        let rows: EbayInventorySyncSnapshotItem[] = [];
        try { rows = JSON.parse(String(run.rows_json || "[]")) as EbayInventorySyncSnapshotItem[]; } catch { rows = []; }
        return Response.json({ snapshotUpdatedAt: snapshot?.source_updated_at || "", googleDrive: googleDriveStatus, run: { runDate: run.run_date, status: run.status,
          startedAt: run.started_at, completedAt: run.completed_at, snapshotUpdatedAt: run.snapshot_updated_at,
          listingCount: run.listing_count, changeCount: run.change_count, reviewCount: run.review_count,
          error: run.error, approvedAt: run.approved_at, rows,
        } }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/inventory/quantity-overrides") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") {
        const result = await env.DB.prepare(`SELECT id, listing_id, ebay_sku, title, forced_quantity, active, reason, updated_at
          FROM ebay_inventory_quantity_override ORDER BY updated_at DESC, id DESC LIMIT 5000`).all<Record<string, unknown>>();
        return Response.json({ overrides: (result.results || []).map((row) => ({
          id: Number(row.id), listingId: String(row.listing_id || ""), ebaySku: String(row.ebay_sku || ""), title: String(row.title || ""),
          forcedQuantity: Number(row.forced_quantity || 0), active: Boolean(row.active), reason: String(row.reason || ""), updatedAt: String(row.updated_at || ""),
        })) }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
        const listingId = String(payload.listingId || "").trim().slice(0, 120), ebaySku = String(payload.ebaySku || "").trim().slice(0, 240);
        if (!listingId) return Response.json({ error: "An eBay listing ID is required." }, { status: 400 });
        const quantity = Number(payload.forcedQuantity), active = payload.active !== false;
        if (active && (!Number.isInteger(quantity) || quantity < 0 || quantity > 15))
          return Response.json({ error: "The forced eBay quantity must be a whole number from 0 through 15." }, { status: 400 });
        const forcedQuantity = active ? quantity : 0, updatedAt = new Date().toISOString();
        const result = await env.DB.prepare(`INSERT INTO ebay_inventory_quantity_override
          (listing_id, ebay_sku, title, forced_quantity, active, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(listingId, ebaySku, String(payload.title || "").trim().slice(0, 500), forcedQuantity, active ? 1 : 0, String(payload.reason || "").trim().slice(0, 1000), updatedAt).run();
        return Response.json({ override: { id: Number(result.meta.last_row_id), listingId, ebaySku, title: String(payload.title || "").trim().slice(0, 500), forcedQuantity, active, reason: String(payload.reason || "").trim().slice(0, 1000), updatedAt } }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    const reviewSnapshotMatch = url.pathname.match(/^\/api\/ebay\/inventory\/review-snapshot\/([^/]+)(\/download)?$/);
    if (url.pathname === "/api/ebay/inventory/review-snapshot" || reviewSnapshotMatch) {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "POST" && !reviewSnapshotMatch) {
        const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
        const reviewId = String(payload.reviewId || "").trim().slice(0, 100);
        const rows = (Array.isArray(payload.rows) ? payload.rows.slice(0, 10_000) : []) as EbayCommittedReviewRow[];
        const fingerprint = String(payload.fingerprint || "").trim().toUpperCase();
        if (!/^SL-\d{8}-[A-Z0-9]+$/.test(reviewId) || !rows.length)
          return Response.json({ error: "A valid reviewed eBay list is required." }, { status: 400, headers: { "cache-control": "no-store" } });
        if (rows.some((row) => !String(row.listingId || "").trim() || !Number.isInteger(Number(row.currentQuantity)) || !Number.isInteger(Number(row.recommendedQuantity))))
          return Response.json({ error: "Every committed review row requires a listing ID and whole before/requested quantities." }, { status: 400, headers: { "cache-control": "no-store" } });
        const calculatedFingerprint = ebayReviewFingerprint(rows);
        if (fingerprint !== calculatedFingerprint || !reviewId.endsWith(`-${calculatedFingerprint}`))
          return Response.json({ error: "The reviewed list fingerprint did not match its rows. Nothing was committed." }, { status: 409, headers: { "cache-control": "no-store" } });
        const existing = await env.DB.prepare("SELECT fingerprint, row_count, committed_at FROM ebay_inventory_review_snapshot WHERE review_id = ?")
          .bind(reviewId).first<{ fingerprint: string; row_count: number; committed_at: string }>();
        if (existing && (existing.fingerprint !== calculatedFingerprint || Number(existing.row_count) !== rows.length))
          return Response.json({ error: "This review ID is already committed with different rows. Lock the current review again to create a new ID." }, { status: 409, headers: { "cache-control": "no-store" } });
        const committedAt = existing?.committed_at || new Date().toISOString();
        if (!existing) await env.DB.prepare(`INSERT INTO ebay_inventory_review_snapshot
          (review_id, run_date, approved_at, committed_at, fingerprint, row_count, rows_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
            reviewId, String(payload.runDate || "").slice(0, 10), String(payload.approvedAt || committedAt), committedAt,
            calculatedFingerprint, rows.length, JSON.stringify(rows),
          ).run();
        return Response.json({ reviewId, fingerprint: calculatedFingerprint, rowCount: rows.length, committedAt, permanent: true }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "GET" && reviewSnapshotMatch) {
        const reviewId = decodeURIComponent(reviewSnapshotMatch[1]);
        const snapshot = await env.DB.prepare(`SELECT review_id, run_date, approved_at, committed_at, fingerprint, row_count, rows_json
          FROM ebay_inventory_review_snapshot WHERE review_id = ?`).bind(reviewId).first<Record<string, unknown>>();
        if (!snapshot) return Response.json({ error: "The committed eBay review was not found." }, { status: 404, headers: { "cache-control": "no-store" } });
        let rows: EbayCommittedReviewRow[] = [];
        try { rows = JSON.parse(String(snapshot.rows_json || "[]")) as EbayCommittedReviewRow[]; } catch { rows = []; }
        if (reviewSnapshotMatch[2]) return csvDownload(`stocklens-ebay-reviewed-list-${reviewId}.csv`,
          ["Review ID", "Run Date", "Approved At", "Committed At", "Row", "eBay Item ID", "eBay SKU", "Title", "Before Quantity", "Requested Quantity", "Difference", "Result"],
          rows.map((row, index) => [reviewId, snapshot.run_date, snapshot.approved_at, snapshot.committed_at, index + 1, row.listingId, row.ebaySku, row.title || "", row.currentQuantity, row.recommendedQuantity, Number(row.recommendedQuantity) - Number(row.currentQuantity), row.result || ""]));
        return Response.json({ snapshot: { reviewId, runDate: snapshot.run_date, approvedAt: snapshot.approved_at, committedAt: snapshot.committed_at,
          fingerprint: snapshot.fingerprint, rowCount: snapshot.row_count, rows } }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/inventory/upload-result/download" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const reviewId = String(url.searchParams.get("reviewId") || "").trim();
      const result = reviewId
        ? await env.DB.prepare(`SELECT id, review_id, run_date, file_name, uploaded_at, total_rows, succeeded_rows, failed_rows, unreported_rows, rows_json
            FROM ebay_inventory_upload_result WHERE review_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 1`).bind(reviewId).first<Record<string, unknown>>()
        : await env.DB.prepare(`SELECT id, review_id, run_date, file_name, uploaded_at, total_rows, succeeded_rows, failed_rows, unreported_rows, rows_json
            FROM ebay_inventory_upload_result ORDER BY uploaded_at DESC, id DESC LIMIT 1`).first<Record<string, unknown>>();
      if (!result) return Response.json({ error: "The saved eBay upload result was not found." }, { status: 404, headers: { "cache-control": "no-store" } });
      let rows: Array<Record<string, unknown>> = [];
      try { rows = JSON.parse(String(result.rows_json || "[]")) as Array<Record<string, unknown>>; } catch { rows = []; }
      const savedReviewId = String(result.review_id || reviewId || "unlinked-review");
      return csvDownload(`stocklens-ebay-post-upload-result-${savedReviewId}.csv`,
        ["Review ID", "Uploaded At", "Row", "Status", "eBay Item ID", "eBay SKU", "Before Quantity", "Requested Quantity", "Verified After Quantity", "Error Code", "Message"],
        rows.map((row, index) => [savedReviewId, result.uploaded_at, index + 1, row.status, row.itemId, row.ebaySku, row.beforeQuantity ?? "", row.requestedQuantity ?? "", row.verifiedQuantity ?? "", row.errorCode, row.message]));
    }

    if (url.pathname === "/api/ebay/inventory/upload-result") {
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") {
        const reviewId = String(url.searchParams.get("reviewId") || "").trim();
        const result = reviewId ? await env.DB.prepare(`SELECT id, review_id, run_date, file_name, uploaded_at, total_rows,
          succeeded_rows, failed_rows, unreported_rows, rows_json
          FROM ebay_inventory_upload_result WHERE review_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 1`).bind(reviewId).first<Record<string, unknown>>() : await env.DB.prepare(`SELECT id, review_id, run_date, file_name, uploaded_at, total_rows,
          succeeded_rows, failed_rows, unreported_rows, rows_json
          FROM ebay_inventory_upload_result ORDER BY uploaded_at DESC, id DESC LIMIT 1`).first<Record<string, unknown>>();
        if (!result) return Response.json({ result: null }, { headers: { "cache-control": "no-store" } });
        let rows: unknown[] = [];
        try { rows = JSON.parse(String(result.rows_json || "[]")) as unknown[]; } catch { rows = []; }
        return Response.json({ result: {
          id: result.id, reviewId: result.review_id, runDate: result.run_date, fileName: result.file_name, uploadedAt: result.uploaded_at,
          totalRows: result.total_rows, succeededRows: result.succeeded_rows, failedRows: result.failed_rows,
          unreportedRows: result.unreported_rows, rows,
        } }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
        const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 10_000) : [];
        if (!String(payload.fileName || "").trim() || !rows.length)
          return Response.json({ error: "A valid eBay upload-result file is required." }, { status: 400 });
        const uploadedAt = new Date().toISOString();
        const reviewId = String(payload.reviewId || "").trim().slice(0, 100);
        if (!reviewId || !(await env.DB.prepare("SELECT review_id FROM ebay_inventory_review_snapshot WHERE review_id = ?").bind(reviewId).first()))
          return Response.json({ error: "The permanent reviewed list was not found. Upload results cannot be saved without their review ID." }, { status: 409, headers: { "cache-control": "no-store" } });
        const result = await env.DB.prepare(`INSERT INTO ebay_inventory_upload_result
          (review_id, run_date, file_name, uploaded_at, total_rows, succeeded_rows, failed_rows, unreported_rows, rows_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            reviewId, String(payload.runDate || ""), String(payload.fileName || "").slice(0, 240), uploadedAt,
            Math.max(0, Number(payload.totalRows) || 0), Math.max(0, Number(payload.succeededRows) || 0),
            Math.max(0, Number(payload.failedRows) || 0), Math.max(0, Number(payload.unreportedRows) || 0),
            JSON.stringify(rows),
          ).run();
        return Response.json({ saved: true, id: result.meta.last_row_id, uploadedAt }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/inventory/listing-fetches") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "eBay import is not configured" }, { status: 503, headers: { "cache-control": "no-store" } });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") {
        const fetchId = Number(url.searchParams.get("id") || 0);
        if (fetchId) {
          const row = await env.DB.prepare(`SELECT id, fetched_at, source, listing_count, rows_json
            FROM ebay_inventory_listing_fetch WHERE id = ?`).bind(fetchId).first<Record<string, unknown>>();
          if (!row) return Response.json({ error: "The selected eBay inventory fetch was not found." }, { status: 404, headers: { "cache-control": "no-store" } });
          let listings: unknown[] = [];
          try { listings = JSON.parse(String(row.rows_json || "[]")) as unknown[]; } catch { listings = []; }
          return Response.json({ fetch: { id: Number(row.id), fetchedAt: String(row.fetched_at || ""), source: String(row.source || ""), listingCount: Number(row.listing_count || 0), listings } }, { headers: { "cache-control": "no-store" } });
        }
        const result = await env.DB.prepare(`SELECT id, fetched_at, source, listing_count
          FROM ebay_inventory_listing_fetch ORDER BY fetched_at DESC, id DESC LIMIT 5`).all<Record<string, unknown>>();
        return Response.json({ fetches: (result.results || []).map((row) => ({ id: Number(row.id), fetchedAt: String(row.fetched_at || ""), source: String(row.source || ""), listingCount: Number(row.listing_count || 0) })) }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        try {
          const upstream = await fetch("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/listings", { headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}` } });
          const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
          if (!upstream.ok || !Array.isArray(payload.listings))
            return Response.json({ error: typeof payload.error === "string" ? payload.error : `Live eBay listings could not be loaded (HTTP ${upstream.status}).` }, { status: upstream.status || 502, headers: { "cache-control": "no-store" } });
          return Response.json({ fetch: await saveEbayInventoryListingFetch(env, payload.listings, "Manual inventory sync") }, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "The new eBay inventory download could not be saved." }, { status: 502, headers: { "cache-control": "no-store" } });
        }
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/listings" && request.method === "GET") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY) {
        return Response.json({ error: "eBay import is not configured" }, { status: 503 });
      }
      if (!(await hasEbayAdminAccess(request, env))) {
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      }
      const upstream = await fetch("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/listings", {
        headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}` },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/inventory/update-quantity" && request.method === "POST") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "The eBay quantity update connection is not configured" }, { status: 503 });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
      const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
      const reviewId = String(payload.reviewId || "").trim().slice(0, 100);
      const rowIndex = Number(payload.rowIndex);
      if (!reviewId || !Number.isInteger(rowIndex) || rowIndex < 0)
        return Response.json({ error: "A permanent review ID and row number are required." }, { status: 400, headers: { "cache-control": "no-store" } });
      const review = await env.DB.prepare("SELECT fingerprint, row_count, rows_json FROM ebay_inventory_review_snapshot WHERE review_id = ?")
        .bind(reviewId).first<{ fingerprint: string; row_count: number; rows_json: string }>();
      if (!review) return Response.json({ error: "The permanent reviewed list was not found. Nothing was sent to eBay." }, { status: 404, headers: { "cache-control": "no-store" } });
      let rows: EbayCommittedReviewRow[] = [];
      try { rows = JSON.parse(review.rows_json) as EbayCommittedReviewRow[]; } catch { rows = []; }
      const row = rows[rowIndex];
      if (!row || Number(review.row_count) !== rows.length || ebayReviewFingerprint(rows) !== review.fingerprint)
        return Response.json({ error: "The permanent reviewed list failed verification. Nothing was sent to eBay." }, { status: 409, headers: { "cache-control": "no-store" } });
      const upstreamPayload = JSON.stringify({
        listingId: row.listingId,
        sku: row.ebaySku,
        expectedCurrentQuantity: row.currentQuantity,
        newQuantity: row.recommendedQuantity,
      });
      const upstream = await fetch("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/inventory/update-quantity", {
        method: "POST",
        headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}`, "content-type": "application/json" },
        body: upstreamPayload,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/profitability" && request.method === "GET") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "eBay profitability is not configured" }, { status: 503 });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const months = [3, 6, 9, 12, 15, 18, 21, 24].includes(Number(url.searchParams.get("months"))) ? Number(url.searchParams.get("months")) : 24;
      const upstream = await fetch(`https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/profitability?months=${months}`, {
        headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}` },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/profitability/finance-page" && request.method === "GET") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "eBay profitability is not configured" }, { status: 503 });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const upstreamUrl = new URL("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/profitability/finance-page");
      for (const key of ["start", "end", "offset"]) {
        const value = url.searchParams.get(key);
        if (value !== null) upstreamUrl.searchParams.set(key, value);
      }
      const upstream = await fetch(upstreamUrl, { headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}` } });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/profitability/orders-page" && request.method === "GET") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "eBay profitability is not configured" }, { status: 503 });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const upstreamUrl = new URL("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/profitability/orders-page");
      for (const key of ["start", "end", "offset"]) {
        const value = url.searchParams.get(key);
        if (value !== null) upstreamUrl.searchParams.set(key, value);
      }
      const upstream = await fetch(upstreamUrl, { headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}` } });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/profitability/order-batch" && request.method === "POST") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "eBay profitability is not configured" }, { status: 503 });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const upstream = await fetch("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/profitability/order-batch", {
        method: "POST",
        headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}`, "content-type": "application/json" },
        body: await request.text(),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/profitability/fulfillment-batch" && request.method === "POST") {
      if (!env.STOCKLENS_SERVICE_KEY || !env.STOCKLENS_ADMIN_KEY)
        return Response.json({ error: "eBay profitability is not configured" }, { status: 503 });
      if (!(await hasEbayAdminAccess(request, env)))
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const upstream = await fetch("https://ebay-account-deletion.migua70576.chatgpt.site/api/ebay/profitability/fulfillment-batch", {
        method: "POST",
        headers: { authorization: `Bearer ${env.STOCKLENS_SERVICE_KEY}`, "content-type": "application/json" },
        body: await request.text(),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/ebay/mappings") {
      if (!(await hasEbayAdminAccess(request, env))) {
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      }
      if (request.method === "GET") {
        const result = await env.DB.prepare("SELECT listing_key, listing_id, ebay_sku, woh_sku, assembly, deferred, workflow_status, assembly_components, knowledge_source, decision_locked, updated_at FROM ebay_item_mapping ORDER BY listing_key").all();
        return Response.json({ mappings: result.results || [] }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json() as { listingKey?: string; listingId?: string; ebaySku?: string; wohSku?: string; workflowStatus?: string; assemblyConfirmed?: boolean; assemblyComponents?: Array<{ sku?: string; quantity?: number; wohSku?: string; wohDescription?: string }>; assemblyLaborCost?: number; knowledgeSource?: string; decisionLocked?: boolean; changeSource?: "user" | "automatic"; sessionId?: string };
        if (!payload.listingKey || !payload.listingId) return Response.json({ error: "Listing identity is required" }, { status: 400 });
        if (!payload.sessionId) return Response.json({ error: "Start or resume a mapping session first" }, { status: 409 });
        const session = await env.DB.prepare("SELECT id FROM ebay_mapping_session WHERE id = ? AND status = 'active'").bind(payload.sessionId).first();
        if (!session) return Response.json({ error: "The mapping session is no longer active" }, { status: 409 });
        const previous = await env.DB.prepare("SELECT woh_sku, workflow_status, assembly_components FROM ebay_item_mapping WHERE listing_key = ?").bind(payload.listingKey).first();
        const updatedAt = new Date().toISOString();
        const workflowStatus = ["Exact Matches", "Assemblies", "Assy Auto Matched", "Deferred", "Manually Matched", "Unmatched", "UPC error"].includes(payload.workflowStatus || "") ? payload.workflowStatus : "Unmatched";
        const isAssembly = workflowStatus === "Assemblies" || workflowStatus === "Assy Auto Matched";
        const assemblyComponents = JSON.stringify({
          confirmed: isAssembly && payload.assemblyConfirmed === true,
          laborCost: Math.max(0, Number.isFinite(Number(payload.assemblyLaborCost)) ? Number(payload.assemblyLaborCost) : 2),
          components: (payload.assemblyComponents || []).slice(0, 10).map((component) => ({ sku: String(component.sku || "").trim(), quantity: Math.max(0, Number(component.quantity) || 0), wohSku: String(component.wohSku || "").trim(), wohDescription: String(component.wohDescription || "").trim() })),
        });
        const oldValue = JSON.stringify({ wohSku: previous?.woh_sku || "", workflowStatus: previous?.workflow_status || "Unmatched", assemblyComponents: previous?.assembly_components || "[]" });
        const newValue = JSON.stringify({ wohSku: payload.wohSku || "", workflowStatus, assemblyComponents });
        const statements = [env.DB.prepare(`INSERT INTO ebay_item_mapping (listing_key, listing_id, ebay_sku, woh_sku, assembly, deferred, workflow_status, assembly_components, knowledge_source, decision_locked, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(listing_key) DO UPDATE SET listing_id = excluded.listing_id, ebay_sku = excluded.ebay_sku,
          woh_sku = excluded.woh_sku, assembly = excluded.assembly, deferred = excluded.deferred,
          workflow_status = excluded.workflow_status, assembly_components = excluded.assembly_components,
          knowledge_source = excluded.knowledge_source, decision_locked = excluded.decision_locked, updated_at = excluded.updated_at`)
          .bind(payload.listingKey, payload.listingId, payload.ebaySku || "", payload.wohSku || "", isAssembly ? 1 : 0, workflowStatus === "Deferred" ? 1 : 0, workflowStatus, assemblyComponents, payload.knowledgeSource || "", payload.decisionLocked === true ? 1 : 0, updatedAt)];
        if (oldValue !== newValue) statements.push(env.DB.prepare("INSERT INTO ebay_mapping_change (session_id, listing_key, action, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(payload.sessionId, payload.listingKey, payload.changeSource === "automatic" ? "automatic_rule_updated" : "user_mapping_updated", oldValue, newValue, updatedAt));
        if (oldValue !== newValue) statements.push(env.DB.prepare(`INSERT INTO ebay_cost_snapshot_state (id, dirty, pending_count, dirty_at, last_exported_at, cost_master_file_id, last_error)
          VALUES (1, 1, 1, ?, '', '', '')
          ON CONFLICT(id) DO UPDATE SET dirty = 1, pending_count = ebay_cost_snapshot_state.pending_count + 1, dirty_at = excluded.dirty_at, last_error = ''`).bind(updatedAt));
        await env.DB.batch(statements);
        return Response.json({ saved: true, changed: oldValue !== newValue, updatedAt, snapshotPending: oldValue !== newValue }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/cost-index") {
      if (!(await hasEbayAdminAccess(request, env))) return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      if (request.method === "GET") {
        const [count, state] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS row_count, MAX(updated_at) AS updated_at FROM woh_cost_index").first(),
          env.DB.prepare("SELECT dirty, pending_count, dirty_at, last_exported_at, cost_master_file_id, last_error FROM ebay_cost_snapshot_state WHERE id = 1").first(),
        ]);
        return Response.json({ rowCount: Number(count?.row_count || 0), updatedAt: String(count?.updated_at || ""), snapshot: state || null }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json() as {
          action?: "finalize";
          sourceVersion?: string;
          rows?: Array<{ wohKey?: string; wohSku?: string; itemNumber?: string; description?: string; unitCostLanded?: number | string; sourceVersion?: string }>;
          mappings?: Array<{ listing_key?: string; listing_id?: string; ebay_sku?: string; woh_sku?: string; workflow_status?: string; assembly_components?: string; knowledge_source?: string; decision_locked?: boolean | number | string; updated_at?: string }>;
        };
        const now = new Date().toISOString();
        if (payload.action === "finalize" && payload.sourceVersion) {
          const result = await env.DB.prepare("DELETE FROM woh_cost_index WHERE source_version != ?").bind(payload.sourceVersion).run();
          return Response.json({ finalized: true, removed: Number(result.meta?.changes || 0) }, { headers: { "cache-control": "no-store" } });
        }
        const statements: D1PreparedStatement[] = [];
        for (const row of (payload.rows || []).slice(0, 150)) {
          const wohKey = String(row.wohKey || row.itemNumber || row.wohSku || "").trim().toLowerCase();
          if (!wohKey) continue;
          statements.push(env.DB.prepare(`INSERT INTO woh_cost_index (woh_key, woh_sku, item_number, description, unit_cost_landed, source_version, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(woh_key) DO UPDATE SET woh_sku = excluded.woh_sku, item_number = excluded.item_number,
            description = excluded.description, unit_cost_landed = excluded.unit_cost_landed,
            source_version = excluded.source_version, updated_at = excluded.updated_at`)
            .bind(wohKey, String(row.wohSku || "").trim(), String(row.itemNumber || "").trim(), String(row.description || "").trim(), String(row.unitCostLanded ?? 0), String(row.sourceVersion || ""), now));
        }
        for (const mapping of (payload.mappings || []).slice(0, 150)) {
          const listingKey = String(mapping.listing_key || "").trim();
          if (!listingKey) continue;
          const workflowStatus = String(mapping.workflow_status || "Unmatched");
          statements.push(env.DB.prepare(`INSERT INTO ebay_item_mapping (listing_key, listing_id, ebay_sku, woh_sku, assembly, deferred, workflow_status, assembly_components, knowledge_source, decision_locked, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(listing_key) DO UPDATE SET listing_id = excluded.listing_id, ebay_sku = excluded.ebay_sku,
            woh_sku = excluded.woh_sku, assembly = excluded.assembly, deferred = excluded.deferred,
            workflow_status = excluded.workflow_status, assembly_components = excluded.assembly_components,
            knowledge_source = excluded.knowledge_source, decision_locked = excluded.decision_locked, updated_at = excluded.updated_at
            WHERE excluded.updated_at >= ebay_item_mapping.updated_at`)
            .bind(listingKey, String(mapping.listing_id || ""), String(mapping.ebay_sku || ""), String(mapping.woh_sku || ""), /^(Assemblies|Assy Auto Matched)$/.test(workflowStatus) ? 1 : 0, workflowStatus === "Deferred" ? 1 : 0, workflowStatus, String(mapping.assembly_components || "[]"), String(mapping.knowledge_source || ""), mapping.decision_locked === true || Number(mapping.decision_locked || 0) === 1 || String(mapping.decision_locked || "").toLowerCase() === "yes" ? 1 : 0, String(mapping.updated_at || now)));
        }
        if (statements.length) await env.DB.batch(statements);
        return Response.json({ saved: statements.length }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/cost-items" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env))) return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const exactSku = String(url.searchParams.get("sku") || "").trim().toLowerCase();
      const keyword = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const exporting = url.searchParams.get("export") === "1";
      const limit = Math.min(exporting ? 20000 : 200, Math.max(1, Number(url.searchParams.get("limit") || (exactSku ? 20 : 50))));
      let sql = `SELECT m.listing_key, m.listing_id, m.ebay_sku, m.woh_sku, m.assembly, m.deferred, m.workflow_status,
        m.assembly_components, m.knowledge_source, m.decision_locked, m.updated_at,
        COALESCE(s.title, '') AS title, COALESCE(s.variation, '') AS variation, COALESCE(s.status, 'Saved') AS listing_status
        FROM ebay_item_mapping m LEFT JOIN ebay_listing_snapshot s ON s.listing_key = m.listing_key`;
      const binds: Array<string | number> = [];
      if (exactSku) { sql += " WHERE lower(m.ebay_sku) = ?"; binds.push(exactSku); }
      else if (keyword) {
        const tokens = keyword.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 8);
        const clauses: string[] = [];
        for (const token of tokens) {
          clauses.push(`(lower(m.ebay_sku) LIKE ? OR lower(m.listing_id) LIKE ? OR lower(m.woh_sku) LIKE ?
            OR lower(m.assembly_components) LIKE ? OR lower(COALESCE(s.title, '')) LIKE ? OR lower(COALESCE(s.variation, '')) LIKE ?
            OR EXISTS (SELECT 1 FROM woh_cost_index w WHERE lower(w.description) LIKE ? AND (
              lower(w.woh_sku) = lower(m.woh_sku) OR lower(w.item_number) = lower(m.woh_sku)
              OR lower(m.assembly_components) LIKE '%' || lower(w.woh_sku) || '%' OR lower(m.assembly_components) LIKE '%' || lower(w.item_number) || '%')))`);
          for (let index = 0; index < 7; index += 1) binds.push(`%${token}%`);
        }
        sql += ` WHERE ${clauses.join(" AND ")}`;
      } else if (!exporting) sql += " WHERE 1 = 0";
      sql += " ORDER BY m.updated_at DESC, m.listing_key LIMIT ?"; binds.push(limit);
      const mappingsResult = await env.DB.prepare(sql).bind(...binds).all();
      const mappings = (mappingsResult.results || []) as Array<Record<string, unknown>>;
      const refs = new Set<string>();
      for (const mapping of mappings) {
        const direct = String(mapping.woh_sku || "").trim().toLowerCase(); if (direct) refs.add(direct);
        try {
          const parsed = JSON.parse(String(mapping.assembly_components || "[]"));
          const components = Array.isArray(parsed) ? parsed : parsed.components || [];
          for (const component of components) for (const value of [component.wohSku, component.sku]) { const key = String(value || "").trim().toLowerCase(); if (key) refs.add(key); }
        } catch { /* Incomplete legacy rows remain visible for correction. */ }
      }
      let costs: Array<Record<string, unknown>> = [];
      if (exporting) costs = ((await env.DB.prepare("SELECT woh_key, woh_sku, item_number, description, unit_cost_landed, source_version, updated_at FROM woh_cost_index ORDER BY woh_key").all()).results || []) as Array<Record<string, unknown>>;
      else if (refs.size) {
        const values = [...refs].slice(0, 1000), costByKey = new Map<string, Record<string, unknown>>();
        for (let index = 0; index < values.length; index += 25) {
          const batch = values.slice(index, index + 25), placeholders = batch.map(() => "?").join(",");
          const result = await env.DB.prepare(`SELECT woh_key, woh_sku, item_number, description, unit_cost_landed, source_version, updated_at FROM woh_cost_index WHERE lower(woh_key) IN (${placeholders}) OR lower(woh_sku) IN (${placeholders}) OR lower(item_number) IN (${placeholders})`).bind(...batch, ...batch, ...batch).all();
          for (const row of (result.results || []) as Array<Record<string, unknown>>) costByKey.set(String(row.woh_key || row.item_number || row.woh_sku), row);
        }
        costs = [...costByKey.values()];
      }
      const [state, indexCount] = await Promise.all([
        env.DB.prepare("SELECT dirty, pending_count, dirty_at, last_exported_at, cost_master_file_id, last_error FROM ebay_cost_snapshot_state WHERE id = 1").first(),
        env.DB.prepare("SELECT COUNT(*) AS row_count FROM woh_cost_index").first(),
      ]);
      return Response.json({ mappings, costs, costIndexRows: Number(indexCount?.row_count || 0), snapshot: state || null }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/ebay/woh-costs" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env))) return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const keyword = String(url.searchParams.get("q") || "").trim().toLowerCase();
      if (!keyword) return Response.json({ rows: [] }, { headers: { "cache-control": "no-store" } });
      const tokens = keyword.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 8);
      const clauses: string[] = [], binds: string[] = [];
      for (const token of tokens) { clauses.push("(lower(woh_sku) LIKE ? OR lower(item_number) LIKE ? OR lower(description) LIKE ?)"); binds.push(`%${token}%`, `%${token}%`, `%${token}%`); }
      const result = await env.DB.prepare(`SELECT woh_key, woh_sku, item_number, description, unit_cost_landed, source_version, updated_at FROM woh_cost_index WHERE ${clauses.join(" AND ")} ORDER BY woh_sku, item_number LIMIT 60`).bind(...binds).all();
      return Response.json({ rows: result.results || [] }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/ebay/cost-snapshot" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env))) return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      const payload = await request.json() as { status?: "clean" | "failed"; exportedAt?: string; costMasterFileId?: string; error?: string };
      const now = payload.exportedAt || new Date().toISOString();
      if (payload.status === "clean") await env.DB.prepare(`INSERT INTO ebay_cost_snapshot_state (id, dirty, pending_count, dirty_at, last_exported_at, cost_master_file_id, last_error)
        VALUES (1, 0, 0, '', ?, ?, '') ON CONFLICT(id) DO UPDATE SET dirty = 0, pending_count = 0, dirty_at = '', last_exported_at = excluded.last_exported_at, cost_master_file_id = CASE WHEN excluded.cost_master_file_id != '' THEN excluded.cost_master_file_id ELSE ebay_cost_snapshot_state.cost_master_file_id END, last_error = ''`).bind(now, payload.costMasterFileId || "").run();
      else await env.DB.prepare(`INSERT INTO ebay_cost_snapshot_state (id, dirty, pending_count, dirty_at, last_exported_at, cost_master_file_id, last_error)
        VALUES (1, 1, 0, ?, '', '', ?) ON CONFLICT(id) DO UPDATE SET dirty = 1, dirty_at = CASE WHEN ebay_cost_snapshot_state.dirty_at = '' THEN excluded.dirty_at ELSE ebay_cost_snapshot_state.dirty_at END, last_error = excluded.last_error`).bind(now, payload.error || "Snapshot update failed").run();
      return Response.json({ saved: true }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/ebay/mapping-session") {
      if (!(await hasEbayAdminAccess(request, env))) {
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      }
      if (request.method === "GET") {
        const session = await env.DB.prepare(`SELECT s.id, s.status, s.started_at, s.ended_at,
          (SELECT COUNT(*) FROM ebay_mapping_change c WHERE c.session_id = s.id) AS change_count
          FROM ebay_mapping_session s ORDER BY s.started_at DESC LIMIT 1`).first();
        return Response.json({ session: session || null }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json() as { action?: "start" | "resume" | "end"; sessionId?: string };
        const now = new Date().toISOString();
        if (payload.action === "start") {
          const active = await env.DB.prepare("SELECT id, status, started_at, ended_at FROM ebay_mapping_session WHERE status = 'active' ORDER BY started_at DESC LIMIT 1").first();
          if (active) return Response.json({ session: { ...active, change_count: 0 } });
          const id = crypto.randomUUID();
          await env.DB.prepare("INSERT INTO ebay_mapping_session (id, status, started_at, ended_at) VALUES (?, 'active', ?, NULL)").bind(id, now).run();
          return Response.json({ session: { id, status: "active", started_at: now, ended_at: null, change_count: 0 } });
        }
        if (payload.action === "resume") {
          const active = await env.DB.prepare(`SELECT s.id, s.status, s.started_at, s.ended_at,
            (SELECT COUNT(*) FROM ebay_mapping_change c WHERE c.session_id = s.id) AS change_count
            FROM ebay_mapping_session s WHERE s.status = 'active' ORDER BY s.started_at DESC LIMIT 1`).first();
          return active ? Response.json({ session: active }) : Response.json({ error: "No session is available to resume" }, { status: 404 });
        }
        if (payload.action === "end" && payload.sessionId) {
          await env.DB.prepare("UPDATE ebay_mapping_session SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'").bind(now, payload.sessionId).run();
          return Response.json({ ended: true, endedAt: now });
        }
        return Response.json({ error: "Invalid session action" }, { status: 400 });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/ebay/mapping-history" && request.method === "GET") {
      if (!(await hasEbayAdminAccess(request, env))) {
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      }
      const result = await env.DB.prepare(`SELECT c.id, c.session_id, s.status AS session_status,
        s.started_at, s.ended_at, c.listing_key, c.action, c.old_value, c.new_value, c.changed_at
        FROM ebay_mapping_change c
        LEFT JOIN ebay_mapping_session s ON s.id = c.session_id
        ORDER BY c.id`).all();
      return Response.json({ changes: result.results || [] }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/ebay/listing-snapshot") {
      if (!(await hasEbayAdminAccess(request, env))) {
        return Response.json({ error: "Administrator access key was not accepted" }, { status: 403 });
      }
      if (request.method === "GET") {
        const result = await env.DB.prepare(`SELECT listing_key, listing_id, title, listing_sku, sku, variation,
          price, currency, quantity_available, quantity_sold, listing_type, status, imported_at
          FROM ebay_listing_snapshot ORDER BY listing_key`).all();
        const latest = await env.DB.prepare("SELECT MAX(imported_at) AS imported_at FROM ebay_listing_snapshot").first() as { imported_at?: string } | null;
        return Response.json({ importedAt: latest?.imported_at || "", listings: result.results || [] }, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const payload = await request.json() as { replace?: boolean; importedAt?: string; listings?: Array<Record<string, unknown>> };
        if (!Array.isArray(payload.listings) || payload.listings.length > 100) return Response.json({ error: "A snapshot batch must contain 100 listings or fewer" }, { status: 400 });
        const importedAt = payload.importedAt || new Date().toISOString();
        const statements = payload.listings.map((item, index) => {
          const listingId = String(item.listingId || "");
          const sku = String(item.sku || "");
          const variation = String(item.variation || "");
          const listingKey = String(item.key || `${listingId}:${sku || variation || index}`);
          return env.DB.prepare(`INSERT INTO ebay_listing_snapshot (listing_key, listing_id, title, listing_sku, sku, variation,
            price, currency, quantity_available, quantity_sold, listing_type, status, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(listing_key) DO UPDATE SET listing_id = excluded.listing_id, title = excluded.title,
            listing_sku = excluded.listing_sku, sku = excluded.sku, variation = excluded.variation, price = excluded.price,
            currency = excluded.currency, quantity_available = excluded.quantity_available, quantity_sold = excluded.quantity_sold,
            listing_type = excluded.listing_type, status = excluded.status, imported_at = excluded.imported_at`)
            .bind(listingKey, listingId, String(item.title || ""), String(item.listingSku || ""), sku, variation,
              String(item.price || 0), String(item.currency || "USD"), Number(item.quantityAvailable || 0),
              Number(item.quantitySold || 0), String(item.listingType || ""), String(item.status || "Active"), importedAt);
        });
        if (payload.replace) statements.unshift(env.DB.prepare("UPDATE ebay_listing_snapshot SET status = 'Not in latest fetch'"));
        if (statements.length) await env.DB.batch(statements);
        return Response.json({ saved: payload.listings.length, importedAt }, { headers: { "cache-control": "no-store" } });
      }
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    if (url.pathname === "/api/client-diagnostic" && request.method === "POST") {
      if (!(await hasEbayAdminAccess(request, env))) return Response.json({ error: "Administrator access required" }, { status: 403 });
      const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
      const diagnostic = {
        type: String(payload.type || "client-diagnostic").slice(0, 80),
        key: String(payload.key || "").slice(0, 80),
        status: String(payload.status || "").slice(0, 40),
        detail: String(payload.detail || "").slice(0, 4000),
        at: String(payload.at || new Date().toISOString()).slice(0, 80),
      };
      if (diagnostic.type === "abc-stage") console.log("STOCKLENS_CLIENT_STAGE", JSON.stringify(diagnostic));
      else console.error("STOCKLENS_CLIENT_ERROR", JSON.stringify(diagnostic));
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

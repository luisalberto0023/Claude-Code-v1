/* =====================================================================
   RiskForge — registration function (gated sample delivery)
   ---------------------------------------------------------------------
   The two free tools POST their lead JSON here. This function:
     1. Validates email + product ("pci" | "nist").
     2. Signs a JWT that binds the email + product + expiry.
     3. Builds a per-user download URL on our own domain.
     4. Upserts the subscriber in MailerLite, writing the URL into the
        `download_link` custom field and adding them to the product group.
   MailerLite's automation for that group then emails the matching sample,
   interpolating {$fields.download_link} into the download button.

   The MailerLite token and JWT secret are read from Netlify environment
   variables and are NEVER sent to the browser.

   Required Netlify environment variables:
     JWT_SECRET             — random 32+ char string (openssl rand -base64 32)
     SITE_URL               — https://riskforge.tech  (no trailing slash)
     MAILERLITE_API_TOKEN   — MailerLite API token (Account -> Integrations -> API)
     MAILERLITE_GROUP_PCI   — group ID that receives PCI leads
     MAILERLITE_GROUP_NIST  — group ID that receives NIST leads
   Optional:
     SAMPLE_FILE_KEY_PCI / SAMPLE_FILE_KEY_NIST — Blobs keys (default = filenames)
   ===================================================================== */

import jwt from "jsonwebtoken";

const ML_ENDPOINT = "https://connect.mailerlite.com/api/subscribers";

// Single source of truth for product routing. Add a product here and the
// download function's matching config, and the rest just works.
const PRODUCTS = {
  pci: {
    groupId: () => process.env.MAILERLITE_GROUP_PCI,
    downloadFilename: "RiskForge_PCI_DSS_v4_SAQ_SAMPLE.xlsx"
  },
  nist: {
    groupId: () => process.env.MAILERLITE_GROUP_NIST,
    downloadFilename: "RiskForge_NIST_CSF2_Gap_Assessment_SAMPLE.xlsx"
  }
};

export default async (req) => {
  if (req.method === "OPTIONS") return cors(new Response("", { status: 204 }));
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!process.env.JWT_SECRET) return json(500, { error: "Lead capture is not configured (missing JWT_SECRET)." });
  const token = process.env.MAILERLITE_API_TOKEN;
  if (!token) return json(500, { error: "Lead capture is not configured (missing MAILERLITE_API_TOKEN)." });

  let data;
  try { data = await req.json(); }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const email = String(data.email || "").trim();
  const name  = String(data.name  || "").trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(400, { error: "A valid email is required." });
  }

  // Resolve product: explicit field first, then fall back to source/framework text.
  let product = String(data.product || "").toLowerCase();
  if (!PRODUCTS[product]) {
    const hint = (String(data.source || "") + " " + String(data.framework || "")).toLowerCase();
    if (hint.includes("pci") || hint.includes("saq")) product = "pci";
    else if (hint.includes("nist")) product = "nist";
  }
  if (!PRODUCTS[product]) return json(400, { error: "Invalid or missing product." });

  const cfg = PRODUCTS[product];
  const groupId = cfg.groupId();

  // Token valid 72h — product baked in so the download is deterministic and
  // tamper-proof (a user can't swap the product in the URL).
  const jwtToken = jwt.sign(
    { email, product, purpose: "sample-download" },
    process.env.JWT_SECRET,
    { expiresIn: "72h" }
  );

  const site = String(process.env.SITE_URL || data.site || "https://riskforge.tech").replace(/\/+$/, "");
  const downloadUrl = `${site}/.netlify/functions/download?token=${jwtToken}`;

  // Rich fields first; if MailerLite rejects unknown custom fields (422),
  // retry with only the safe defaults + download_link so the lead and the
  // sample-delivery link are never lost.
  const fullFields = {
    name,
    company:     String(data.company || "").trim(),
    role:        String(data.role || "").trim(),
    download_link: downloadUrl,
    lead_source: String(data.source || ""),
    framework:   String(data.framework || ""),
    saq_result:  String(data.saq_label || data.saq || ""),
    nist_level:  String(data.level || ""),
    nist_score:  String(data.overall || "")
  };
  const minimalFields = {
    name,
    company: String(data.company || "").trim(),
    download_link: downloadUrl
  };

  const groups = groupId ? [String(groupId)] : [];

  let r = await postSubscriber(token, email, fullFields, groups);
  if (r.status === 422) r = await postSubscriber(token, email, minimalFields, groups);

  if (r.ok) return json(200, { ok: true });
  console.error("MailerLite error:", r.status, JSON.stringify(r.detail));
  return json(r.status || 502, { error: "Could not register." });
};

async function postSubscriber(token, email, fields, groups) {
  const body = { email, fields, status: "active" };
  if (groups.length) body.groups = groups;
  try {
    const res = await fetch(ML_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });
    let detail = null;
    try { detail = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, detail };
  } catch (e) {
    return { ok: false, status: 502, detail: String(e) };
  }
}

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return res;
}

function json(status, obj) {
  return cors(new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

/* =====================================================================
   RiskForge — download function (gated sample delivery)
   ---------------------------------------------------------------------
   Validates the JWT minted by register.js, reads the `product` claim,
   pulls the matching .xlsx from the private "samples" Netlify Blobs store,
   and streams it with the correct filename. The product is bound inside
   the signed token, so a user cannot tamper the URL to grab a different
   sample. Every download is logged to the "download-logs" store.

   Required Netlify environment variables:
     JWT_SECRET   — same secret used by register.js
   Optional:
     SAMPLE_FILE_KEY_PCI / SAMPLE_FILE_KEY_NIST — Blobs keys (default = filenames)
   ===================================================================== */

import jwt from "jsonwebtoken";
import { getStore } from "@netlify/blobs";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Mirror of the product config in register.js. Keep filenames in sync.
const PRODUCTS = {
  pci: {
    fileKey: () => process.env.SAMPLE_FILE_KEY_PCI || "RiskForge_PCI_DSS_v4_SAQ_SAMPLE.xlsx",
    downloadFilename: "RiskForge_PCI_DSS_v4_SAQ_SAMPLE.xlsx"
  },
  nist: {
    fileKey: () => process.env.SAMPLE_FILE_KEY_NIST || "RiskForge_NIST_CSF2_Gap_Assessment_SAMPLE.xlsx",
    downloadFilename: "RiskForge_NIST_CSF2_Gap_Assessment_SAMPLE.xlsx"
  }
};

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return new Response("Missing token", { status: 400 });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return new Response(
      errorPage("This download link is invalid or has expired. Please run the tool again to get a fresh link."),
      { status: 401, headers: { "Content-Type": "text/html" } }
    );
  }

  if (payload.purpose !== "sample-download") {
    return new Response("Invalid token", { status: 401 });
  }

  const cfg = PRODUCTS[payload.product];
  if (!cfg) return new Response("Invalid token: unknown product", { status: 401 });

  // Log the download (best-effort — never block delivery on a logging error).
  try {
    const logStore = getStore("download-logs");
    await logStore.set(
      `${payload.email}-${Date.now()}`,
      JSON.stringify({ email: payload.email, product: payload.product, at: new Date().toISOString() })
    );
  } catch (_) { /* ignore */ }

  const sampleStore = getStore("samples");
  const file = await sampleStore.get(cfg.fileKey(), { type: "arrayBuffer" });
  if (!file) return new Response("Sample file not found", { status: 404 });

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${cfg.downloadFilename}"`,
      "Cache-Control": "private, no-store"
    }
  });
};

function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Link unavailable — RiskForge</title>
    <style>
      body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; max-width: 480px;
             margin: 80px auto; padding: 0 24px; color: #14151a; line-height: 1.6; }
      h2 { margin: 0 0 12px; }
      a { color: #14151a; font-weight: 600; }
    </style>
  </head>
  <body>
    <h2>Link unavailable</h2>
    <p>${message}</p>
    <p><a href="/">Return to riskforge.tech</a></p>
  </body>
</html>`;
}

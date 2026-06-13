/* =====================================================================
   RiskForge — one-time upload of sample workbooks to Netlify Blobs
   ---------------------------------------------------------------------
   Place the two .xlsx files in the repo root (do NOT commit them), then run
   WITH Netlify site context so Blobs is authenticated:

       netlify link                       # one time — pick the riskforge site
       netlify dev:exec node scripts/upload-samples.js

   Re-run any time you update a sample — same key overwrites the old file.
   The keys default to the filenames but can be overridden with the
   SAMPLE_FILE_KEY_PCI / SAMPLE_FILE_KEY_NIST env vars (keep them in sync
   with the download function).
   ===================================================================== */

import { getStore } from "@netlify/blobs";
import { readFileSync, existsSync } from "node:fs";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const files = [
  {
    localPath: "./RiskForge_PCI_DSS_v4_SAQ_SAMPLE.xlsx",
    key: process.env.SAMPLE_FILE_KEY_PCI || "RiskForge_PCI_DSS_v4_SAQ_SAMPLE.xlsx"
  },
  {
    localPath: "./RiskForge_NIST_CSF2_Gap_Assessment_SAMPLE.xlsx",
    key: process.env.SAMPLE_FILE_KEY_NIST || "RiskForge_NIST_CSF2_Gap_Assessment_SAMPLE.xlsx"
  }
];

// When run via `netlify dev:exec`, the CLI injects NETLIFY_SITE_ID and
// NETLIFY_AUTH_TOKEN but doesn't auto-wire the Blobs context. Pass them
// explicitly so the SDK can authenticate against the live Blobs API.
const siteID = process.env.NETLIFY_SITE_ID;
const token  = process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error("ERROR: NETLIFY_SITE_ID or NETLIFY_AUTH_TOKEN not found.");
  console.error("Run via: netlify dev:exec node scripts/upload-samples.js");
  process.exit(1);
}
const store = getStore({ name: "samples", siteID, token });

let uploaded = 0;
for (const { localPath, key } of files) {
  if (!existsSync(localPath)) {
    console.error(`MISSING: ${localPath} — put the file in the repo root and re-run.`);
    continue;
  }
  const buf = readFileSync(localPath);
  await store.set(key, buf, { metadata: { contentType: XLSX_MIME } });
  console.log(`Uploaded ${localPath}  ->  blobs:samples/${key}  (${buf.length} bytes)`);
  uploaded++;
}

console.log(`\nDone. ${uploaded}/${files.length} sample(s) uploaded.`);
if (uploaded < files.length) process.exitCode = 1;

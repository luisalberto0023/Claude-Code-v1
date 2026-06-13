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

// Resolve site ID: env var first, then the known RiskForge site ID.
// Resolve token: try all names the Netlify CLI uses across versions, then
// fall back to NETLIFY_TOKEN which the user can set manually (see below).
const KNOWN_SITE_ID = "63ae3e3b-bbc5-4734-a870-fb4deb57d2f4";
const siteID = process.env.NETLIFY_SITE_ID || KNOWN_SITE_ID;
const token  =
  process.env.NETLIFY_AUTH_TOKEN  ||
  process.env.NETLIFY_ACCESS_TOKEN ||
  process.env.NETLIFY_TOKEN;

if (!token) {
  console.error("ERROR: no Netlify auth token found.\n");
  console.error("Set NETLIFY_TOKEN to your personal access token, then re-run:\n");
  console.error("  PowerShell:  $env:NETLIFY_TOKEN='<token>'; node scripts/upload-samples.js");
  console.error("  Cmd:         set NETLIFY_TOKEN=<token> && node scripts/upload-samples.js");
  console.error("  Mac/Linux:   NETLIFY_TOKEN=<token> node scripts/upload-samples.js\n");
  console.error("Get a token: Netlify dashboard -> your avatar -> User settings -> Applications -> Personal access tokens -> New access token");
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

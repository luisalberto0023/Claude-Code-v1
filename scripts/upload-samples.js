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

const store = getStore("samples");

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

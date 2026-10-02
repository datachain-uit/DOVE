const path = require("path");

const ONCHAIN_DIR = path.join(__dirname, "..", "..");
const BATCH_DIR = path.join(ONCHAIN_DIR, "zkp", "batch");
const DEFAULT_MANIFEST = path.join(BATCH_DIR, "batch_manifest.json");
const DEFAULT_LATEST_DEPLOYMENT = path.join(ONCHAIN_DIR, "results", "latest-deployment.json");

module.exports = { BATCH_DIR, DEFAULT_MANIFEST, DEFAULT_LATEST_DEPLOYMENT };

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { writeCsv } = require("./io");

function numericStats(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, x) => a + (x - avg) ** 2, 0) / values.length;
  return { avg, min, max, std: Math.sqrt(variance) };
}

function summarizeRows(rows) {
  const success = rows.filter((r) => r.status === "SUCCESS");
  if (success.length === 0) {
    return {
      rounds: rows.length,
      success: 0,
      gas: null,
      time: null,
      gasCostEthTotal: "0.0",
      gasCostEthAvg: "0.0",
    };
  }

  const gas = numericStats(success.map((r) => Number(r.gasUsed)));
  const time = numericStats(success.map((r) => Number(r.timeSec)));
  const feeWei = success.map((r) => hre.ethers.parseEther(r.gasCostEth));
  const totalFee = feeWei.reduce((a, b) => a + b, 0n);
  return {
    rounds: rows.length,
    success: success.length,
    gas: {
      avg: Number(gas.avg.toFixed(2)),
      min: gas.min,
      max: gas.max,
      std: Number(gas.std.toFixed(2)),
    },
    time: {
      avg: Number(time.avg.toFixed(6)),
      min: Number(time.min.toFixed(6)),
      max: Number(time.max.toFixed(6)),
      std: Number(time.std.toFixed(6)),
    },
    gasCostEthTotal: hre.ethers.formatEther(totalFee),
    gasCostEthAvg: hre.ethers.formatEther(totalFee / BigInt(success.length)),
  };
}

function flushResults(resultDir, variantRows, prepRows, metadata) {
  for (const [variant, rows] of Object.entries(variantRows)) {
    writeCsv(path.join(resultDir, `${variant}.csv`), rows);
  }
  writeCsv(path.join(resultDir, "registry_prep.csv"), prepRows);

  const summary = {
    ...metadata,
    variants: Object.fromEntries(
      Object.entries(variantRows).map(([variant, rows]) => [variant, summarizeRows(rows)])
    ),
  };
  fs.writeFileSync(path.join(resultDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

module.exports = {
  numericStats,
  summarizeRows,
  flushResults,
};

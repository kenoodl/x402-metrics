#!/usr/bin/env node
// x402-metrics v0.1 validator. Zero dependencies, Node 18+.
// Usage: node validate.mjs <file-or-url>
// Exit 0: valid (warnings allowed). Exit 1: invalid. Exit 2: usage or read error.
// Checks are hand-rolled against the rules in x402-metrics.schema.json,
// plus cross-field arithmetic a JSON Schema engine cannot express.

import { readFile } from "node:fs/promises";

const SPEC_VERSION = "0.1";
const SOURCE_CLASSES = ["organic", "verifier", "prearranged", "self", "scanner", "unknown"];
const EXCLUSION_CLASSES = ["self", "prearranged", "verifier", "scanner"];
const FAILURE_CLASSES = [
  "upstream_timeout",
  "upstream_error",
  "settlement_verified_but_no_delivery",
  "malformed_payment",
  "insufficient_amount",
  "replay_rejected",
  "rate_limited",
  "sandbox_failure",
  "other",
];
const ABANDONMENT_CAUSES = ["funding", "policy", "retry_handling", "receipt_handling", "unknown"];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const errors = [];
const warnings = [];
const err = (path, msg) => errors.push(`${path}: ${msg}`);
const warn = (path, msg) => warnings.push(`${path}: ${msg}`);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);


// challenge_correlation: optional, but if present it must be coherent, and it is
// the only field that can justify a non-null challenges_abandoned.
function checkCorrelation(m, path) {
  const c = m?.challenge_correlation;
  if (c === undefined) {
    if (m?.challenges_abandoned !== null && m?.challenges_abandoned !== undefined)
      warn(`${path}.challenges_abandoned`, `reported without challenge_correlation. Say how the challenge was linked to the attempt, or report null. Inferring from IP or user-agent is not linking.`);
    return;
  }
  if (typeof c !== "object" || c === null || Array.isArray(c))
    return err(`${path}.challenge_correlation`, `must be an object`);
  checkKeys(c, `${path}.challenge_correlation`, ["method", "quote_id_issued", "quote_id_returned", "median_seconds_challenge_to_attempt"]);
  if (!["quote_id", "none"].includes(c.method))
    err(`${path}.challenge_correlation.method`, `must be "quote_id" or "none", got ${JSON.stringify(c.method)}`);
  if (c.method === "none" && m?.challenges_abandoned !== null && m?.challenges_abandoned !== undefined)
    err(`${path}.challenges_abandoned`, `must be null when challenge_correlation.method is "none". Without a correlation token this number is a guess.`);
  if (Number.isInteger(c.quote_id_issued) && Number.isInteger(c.quote_id_returned) && c.quote_id_returned > c.quote_id_issued)
    err(`${path}.challenge_correlation.quote_id_returned`, `${c.quote_id_returned} exceeds quote_id_issued (${c.quote_id_issued}), a token cannot come back more often than it went out`);
}

function checkKeys(obj, path, allowed) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) err(`${path}.${k}`, `unknown field, not in spec v${SPEC_VERSION}. Extra data belongs under "extensions".`);
  }
}

function parseDate(v, path) {
  if (typeof v !== "string") {
    err(path, "must be an ISO 8601 date-time string");
    return null;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    err(path, `"${v}" is not a parseable ISO 8601 date-time`);
    return null;
  }
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) warn(path, `"${v}" has no timezone offset, use UTC with a trailing Z`);
  return t;
}

function checkCount(obj, path, field, required = true) {
  if (!(field in obj)) {
    if (required) err(`${path}.${field}`, "required field is missing");
    return null;
  }
  if (!isCount(obj[field])) {
    err(`${path}.${field}`, `must be a non-negative integer, got ${JSON.stringify(obj[field])}`);
    return null;
  }
  return obj[field];
}

function checkBreakdown(obj, path, field, expectedTotal, totalName) {
  if (!(field in obj)) return null;
  const b = obj[field];
  if (!isObj(b)) {
    err(`${path}.${field}`, "must be an object with counts per source class");
    return null;
  }
  checkKeys(b, `${path}.${field}`, SOURCE_CLASSES);
  let sum = 0;
  let ok = true;
  for (const c of SOURCE_CLASSES) {
    const v = checkCount(b, `${path}.${field}`, c);
    if (v === null) ok = false;
    else sum += v;
  }
  if (ok && expectedTotal !== null && sum !== expectedTotal) {
    err(`${path}.${field}`, `classes sum to ${sum} but ${totalName} is ${expectedTotal}, the breakdown must account for every one`);
  }
  return ok ? b : null;
}

function checkFailures(obj, path) {
  const f = obj.paid_retry_failures;
  if (f === undefined) {
    err(`${path}.paid_retry_failures`, "required field is missing");
    return;
  }
  if (!isObj(f)) {
    err(`${path}.paid_retry_failures`, "must be an object with total and by_class");
    return;
  }
  const p = `${path}.paid_retry_failures`;
  checkKeys(f, p, ["total", "by_class"]);
  const total = checkCount(f, p, "total");
  if (!Array.isArray(f.by_class)) {
    err(`${p}.by_class`, "required, must be an array (empty when total is 0)");
    return;
  }
  const seen = new Set();
  let sum = 0;
  f.by_class.forEach((row, i) => {
    const rp = `${p}.by_class[${i}]`;
    if (!isObj(row)) return err(rp, "must be an object with class and count");
    checkKeys(row, rp, ["class", "count", "note"]);
    if (!FAILURE_CLASSES.includes(row.class)) {
      err(`${rp}.class`, `"${row.class}" is not a defined failure class. Allowed: ${FAILURE_CLASSES.join(", ")}`);
    } else if (seen.has(row.class)) {
      err(`${rp}.class`, `duplicate class "${row.class}", one entry per class`);
    } else {
      seen.add(row.class);
    }
    if (!Number.isInteger(row.count) || row.count < 1) {
      err(`${rp}.count`, `must be an integer >= 1, got ${JSON.stringify(row.count)}`);
    } else {
      sum += row.count;
    }
    if (row.class === "other" && (typeof row.note !== "string" || row.note.trim() === "")) {
      err(`${rp}.note`, 'class "other" requires a non-empty note explaining what it was, so "other" cannot become a dumping ground');
    }
  });
  if (total !== null && sum !== total) {
    err(`${p}`, `by_class sums to ${sum} but total is ${total}, every failure must be classified`);
  }
}

const METRIC_FIELDS = [
  "challenges_served",
  "challenges_abandoned",
  "payment_attempts",
  "paid_calls",
  "unique_payers",
  "repeat_payers",
  "revenue_usdc_net_of_own_wallets",
  "paid_retry_failures",
  "paid_calls_by_source_class",
  "challenges_by_source_class",
  "abandonment_causes",
  "challenge_correlation",
];

function checkMetrics(obj, path, { requirePaidBreakdown }) {
  const m = {};
  m.challenges_served = checkCount(obj, path, "challenges_served");

  // challenges_abandoned: required but nullable. null means "cannot attribute retries to challenges", never a guess.
  if (!("challenges_abandoned" in obj)) {
    err(`${path}.challenges_abandoned`, "required field is missing (report null if you cannot attribute retries to challenges)");
    m.challenges_abandoned = null;
  } else if (obj.challenges_abandoned === null) {
    m.challenges_abandoned = null;
  } else if (!isCount(obj.challenges_abandoned)) {
    err(`${path}.challenges_abandoned`, `must be a non-negative integer or null, got ${JSON.stringify(obj.challenges_abandoned)}`);
    m.challenges_abandoned = null;
  } else {
    m.challenges_abandoned = obj.challenges_abandoned;
  }

  m.payment_attempts = checkCount(obj, path, "payment_attempts", false);
  m.paid_calls = checkCount(obj, path, "paid_calls");
  m.unique_payers = checkCount(obj, path, "unique_payers");
  m.repeat_payers = checkCount(obj, path, "repeat_payers");

  if (!("revenue_usdc_net_of_own_wallets" in obj)) {
    err(`${path}.revenue_usdc_net_of_own_wallets`, "required field is missing");
  } else if (!isNum(obj.revenue_usdc_net_of_own_wallets) || obj.revenue_usdc_net_of_own_wallets < 0) {
    err(`${path}.revenue_usdc_net_of_own_wallets`, `must be a non-negative number, got ${JSON.stringify(obj.revenue_usdc_net_of_own_wallets)}`);
  } else {
    m.revenue = obj.revenue_usdc_net_of_own_wallets;
  }

  checkFailures(obj, path);

  if (requirePaidBreakdown && !("paid_calls_by_source_class" in obj)) {
    err(`${path}.paid_calls_by_source_class`, "required in totals: paid calls must be classified by source");
  }
  m.paidBreakdown = checkBreakdown(obj, path, "paid_calls_by_source_class", m.paid_calls, "paid_calls");
  checkBreakdown(obj, path, "challenges_by_source_class", m.challenges_served, "challenges_served");

  // Funnel arithmetic.
  if (m.challenges_abandoned !== null && m.challenges_served !== null && m.challenges_abandoned > m.challenges_served) {
    err(`${path}.challenges_abandoned`, `${m.challenges_abandoned} exceeds challenges_served (${m.challenges_served})`);
  }
  if (m.payment_attempts !== null && m.paid_calls !== null && m.paid_calls > m.payment_attempts) {
    err(`${path}.paid_calls`, `${m.paid_calls} exceeds payment_attempts (${m.payment_attempts}), a settled call implies a payment attempt`);
  }
  if (m.payment_attempts !== null && m.challenges_abandoned !== null && m.challenges_served !== null) {
    const minAbandoned = m.challenges_served - m.payment_attempts;
    if (m.challenges_abandoned < minAbandoned) {
      err(`${path}.challenges_abandoned`, `${m.challenges_abandoned} is impossible: with ${m.payment_attempts} payment_attempts, at least ${minAbandoned} of ${m.challenges_served} challenges got no attempt`);
    }
  }
  if (m.unique_payers !== null && m.paid_calls !== null && m.unique_payers > m.paid_calls) {
    err(`${path}.unique_payers`, `${m.unique_payers} exceeds paid_calls (${m.paid_calls}), each payer needs at least one paid call`);
  }
  if (m.repeat_payers !== null && m.unique_payers !== null && m.repeat_payers > m.unique_payers) {
    err(`${path}.repeat_payers`, `${m.repeat_payers} exceeds unique_payers (${m.unique_payers}). Reminder: repeat_payers counts wallets paying on at least 2 distinct UTC days, not repeated calls`);
  }
  if (m.paidBreakdown && m.unique_payers !== null) {
    const plausible = m.paidBreakdown.organic + m.paidBreakdown.unknown;
    if (m.unique_payers > plausible) {
      warn(`${path}.unique_payers`, `${m.unique_payers} exceeds organic + unknown paid calls (${plausible}). unique_payers excludes declared wallets, so it should be covered by organic or unknown paid calls`);
    }
  }

  // abandonment_causes.
  if ("abandonment_causes" in obj) {
    const a = obj.abandonment_causes;
    const p = `${path}.abandonment_causes`;
    if (!isObj(a)) {
      err(p, "must be an object with counts per cause");
    } else {
      checkKeys(a, p, ABANDONMENT_CAUSES);
      let sum = 0;
      let ok = true;
      for (const c of ABANDONMENT_CAUSES) {
        const v = checkCount(a, p, c);
        if (v === null) ok = false;
        else sum += v;
      }
      if (m.challenges_abandoned === null) {
        err(p, "present but challenges_abandoned is null. You cannot classify abandonment you did not measure");
      } else if (ok && sum !== m.challenges_abandoned) {
        err(p, `causes sum to ${sum} but challenges_abandoned is ${m.challenges_abandoned}. Put the unevidenced remainder in "unknown", never guess`);
      }
    }
  }
  return m;
}

function checkDedupTotal(field, totalVal, endpointVals, path) {
  if (totalVal === null || endpointVals.some((v) => v === null)) return;
  const sum = endpointVals.reduce((a, b) => a + b, 0);
  const max = endpointVals.length ? Math.max(...endpointVals) : 0;
  if (totalVal > sum) err(`${path}.${field}`, `${totalVal} exceeds the sum of endpoint values (${sum})`);
  if (totalVal < max) err(`${path}.${field}`, `${totalVal} is below the largest endpoint value (${max}), dedup across endpoints cannot shrink below that`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node validate.mjs <file-or-url>");
    process.exit(2);
  }

  let text;
  try {
    if (/^https?:\/\//.test(arg)) {
      const res = await fetch(arg, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      text = await res.text();
    } else {
      text = await readFile(arg, "utf8");
    }
  } catch (e) {
    console.error(`FAIL: could not read ${arg}: ${e.message}`);
    process.exit(2);
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    console.error(`FAIL: ${arg} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!isObj(doc)) {
    console.error("FAIL: root must be a JSON object");
    process.exit(1);
  }

  checkKeys(doc, "$", [
    "spec_version", "generated_at", "seller", "protocol", "window",
    "endpoints", "totals", "declared_exclusions", "receipt_linkage", "notes", "extensions",
  ]);

  if (doc.spec_version !== SPEC_VERSION) {
    err("$.spec_version", `must be "${SPEC_VERSION}", got ${JSON.stringify(doc.spec_version)}`);
  }
  parseDate(doc.generated_at, "$.generated_at");

  if (!isObj(doc.seller)) {
    err("$.seller", "required object with at least a name");
  } else {
    checkKeys(doc.seller, "$.seller", ["name", "url"]);
    if (typeof doc.seller.name !== "string" || doc.seller.name.trim() === "") err("$.seller.name", "required non-empty string");
  }

  if (typeof doc.protocol !== "string" || doc.protocol.trim() === "") {
    err("$.protocol", 'required non-empty string, e.g. "x402/v2"');
  }

  if (!isObj(doc.window)) {
    err("$.window", "required object with start, end, hours");
  } else {
    checkKeys(doc.window, "$.window", ["start", "end", "hours"]);
    const start = parseDate(doc.window.start, "$.window.start");
    const end = parseDate(doc.window.end, "$.window.end");
    if (!isNum(doc.window.hours) || doc.window.hours <= 0) {
      err("$.window.hours", `must be a positive number, got ${JSON.stringify(doc.window.hours)}`);
    } else if (start !== null && end !== null) {
      if (end <= start) err("$.window.end", "must be after window.start");
      else {
        const actual = (end - start) / 3600000;
        const tolerance = Math.max(0.02, actual * 0.01);
        if (Math.abs(actual - doc.window.hours) > tolerance) {
          err("$.window.hours", `declared ${doc.window.hours} but end minus start is ${actual.toFixed(2)} hours, the window must be honest`);
        }
      }
    }
  }

  // Endpoints.
  const rows = [];
  if (!Array.isArray(doc.endpoints) || doc.endpoints.length === 0) {
    err("$.endpoints", "required non-empty array of endpoint rows (an array, not a map keyed by URL)");
  } else {
    doc.endpoints.forEach((ep, i) => {
      const p = `$.endpoints[${i}]`;
      if (!isObj(ep)) return err(p, "must be an object");
      checkKeys(ep, p, ["route", "method", "price_usdc", "notes", ...METRIC_FIELDS]);
    checkCorrelation(ep, p);
      if (typeof ep.route !== "string" || !ep.route.startsWith("/")) {
        err(`${p}.route`, `required string starting with "/", got ${JSON.stringify(ep.route)}`);
      }
      if ("price_usdc" in ep && (!isNum(ep.price_usdc) || ep.price_usdc < 0)) {
        err(`${p}.price_usdc`, "must be a non-negative number when present");
      }
      rows.push(checkMetrics(ep, p, { requirePaidBreakdown: false }));
    });
    const routes = doc.endpoints.map((e) => isObj(e) ? `${e.method ?? "POST"} ${e.route}` : null);
    routes.forEach((r, i) => {
      if (r !== null && routes.indexOf(r) !== i) err(`$.endpoints[${i}].route`, `duplicate row for ${r}, one row per endpoint`);
    });
  }

  // Totals.
  if (!isObj(doc.totals)) {
    err("$.totals", "required object with seller-level totals");
  } else {
    checkKeys(doc.totals, "$.totals", METRIC_FIELDS);
  checkCorrelation(doc.totals, "$.totals");
    const t = checkMetrics(doc.totals, "$.totals", { requirePaidBreakdown: true });
    if (rows.length > 0) {
      for (const [field, key] of [["challenges_served", "challenges_served"], ["paid_calls", "paid_calls"]]) {
        const vals = rows.map((r) => r[key]);
        if (t[key] !== null && !vals.some((v) => v === null)) {
          const sum = vals.reduce((a, b) => a + b, 0);
          if (t[key] !== sum) err(`$.totals.${field}`, `${t[key]} does not equal the sum of endpoint rows (${sum})`);
        }
      }
      if (t.revenue !== undefined && !rows.some((r) => r.revenue === undefined)) {
        const sum = rows.reduce((a, r) => a + r.revenue, 0);
        if (Math.abs(t.revenue - sum) > 0.000001) {
          err("$.totals.revenue_usdc_net_of_own_wallets", `${t.revenue} does not equal the sum of endpoint rows (${sum.toFixed(6)})`);
        }
      }
      checkDedupTotal("unique_payers", t.unique_payers, rows.map((r) => r.unique_payers), "$.totals");
      checkDedupTotal("repeat_payers", t.repeat_payers, rows.map((r) => r.repeat_payers), "$.totals");
      const abVals = rows.map((r) => r.challenges_abandoned);
      if (t.challenges_abandoned !== null) {
        if (!abVals.some((v) => v === null)) {
          const sum = abVals.reduce((a, b) => a + b, 0);
          if (t.challenges_abandoned !== sum) err("$.totals.challenges_abandoned", `${t.challenges_abandoned} does not equal the sum of endpoint rows (${sum})`);
        } else {
          warn("$.totals.challenges_abandoned", "a non-null total over endpoints reporting null cannot be checked, state the method in notes");
        }
      }
      const paVals = rows.map((r) => r.payment_attempts);
      if (t.payment_attempts !== null && !paVals.some((v) => v === null)) {
        const sum = paVals.reduce((a, b) => a + b, 0);
        if (t.payment_attempts !== sum) err("$.totals.payment_attempts", `${t.payment_attempts} does not equal the sum of endpoint rows (${sum})`);
      }
      if (t.paidBreakdown && !rows.some((r) => r.paidBreakdown === null)) {
        const allPresent = rows.every((r) => r.paidBreakdown);
        if (allPresent) {
          for (const c of SOURCE_CLASSES) {
            const sum = rows.reduce((a, r) => a + r.paidBreakdown[c], 0);
            if (t.paidBreakdown[c] !== sum) {
              err(`$.totals.paid_calls_by_source_class.${c}`, `${t.paidBreakdown[c]} does not equal the sum of endpoint rows (${sum})`);
            }
          }
        }
      }
    }
    // Zero-organic honesty is legal, silence about it is not required. No check needed, the field speaks.
  }

  // Declared exclusions.
  if (!Array.isArray(doc.declared_exclusions)) {
    err("$.declared_exclusions", "required array (empty array is a positive claim that no seller-linked wallets exist)");
  } else {
    const seen = new Set();
    doc.declared_exclusions.forEach((x, i) => {
      const p = `$.declared_exclusions[${i}]`;
      if (!isObj(x)) return err(p, "must be an object with address, source_class, evidence");
      checkKeys(x, p, ["address", "source_class", "evidence", "label"]);
      if (typeof x.address !== "string" || !EVM_ADDRESS.test(x.address)) {
        err(`${p}.address`, `must be an EVM address (0x + 40 hex), got ${JSON.stringify(x.address)}`);
      } else {
        const a = x.address.toLowerCase();
        if (seen.has(a)) err(`${p}.address`, `duplicate exclusion for ${x.address}`);
        seen.add(a);
      }
      if (!EXCLUSION_CLASSES.includes(x.source_class)) {
        err(`${p}.source_class`, `must be one of ${EXCLUSION_CLASSES.join(", ")} (never "organic" or "unknown": you cannot exclude what you claim not to know)`);
      }
      if (typeof x.evidence !== "string" || x.evidence.trim() === "") {
        err(`${p}.evidence`, "required non-empty string: how a third party can confirm this classification");
      }
    });
  }

  // Receipt linkage.
  if (!isObj(doc.receipt_linkage)) {
    err("$.receipt_linkage", "required object: without it the report is a press release, not a checkable claim");
  } else {
    const r = doc.receipt_linkage;
    const p = "$.receipt_linkage";
    checkKeys(r, p, ["address", "chain", "asset", "settlement_tx_hashes", "block_range"]);
    if (typeof r.address !== "string" || !EVM_ADDRESS.test(r.address)) {
      err(`${p}.address`, `must be the seller's receiving EVM address (0x + 40 hex), got ${JSON.stringify(r.address)}`);
    }
    if (typeof r.chain !== "string" || r.chain.trim() === "") {
      err(`${p}.chain`, 'required non-empty string, CAIP-2 form recommended, e.g. "eip155:8453" for Base');
    } else if (!/^[a-z0-9-]+:[a-zA-Z0-9._-]+$/.test(r.chain)) {
      warn(`${p}.chain`, `"${r.chain}" is not CAIP-2 shaped (namespace:reference), aggregators may not match it`);
    }
    if (typeof r.asset !== "string" || r.asset.trim() === "") {
      err(`${p}.asset`, "required non-empty string, the asset contract address on the declared chain");
    }
    const hasHashes = "settlement_tx_hashes" in r;
    const hasRange = "block_range" in r;
    if (!hasHashes && !hasRange) {
      err(p, "at least one of settlement_tx_hashes or block_range is required so an auditor can reconstruct the revenue on-chain");
    }
    if (hasHashes) {
      if (!Array.isArray(r.settlement_tx_hashes) || r.settlement_tx_hashes.length === 0) {
        err(`${p}.settlement_tx_hashes`, "must be a non-empty array of tx hashes when present");
      } else {
        r.settlement_tx_hashes.forEach((h, i) => {
          if (typeof h !== "string" || !TX_HASH.test(h)) err(`${p}.settlement_tx_hashes[${i}]`, `must be a tx hash (0x + 64 hex), got ${JSON.stringify(h)}`);
        });
      }
    }
    if (hasRange) {
      if (!isObj(r.block_range)) {
        err(`${p}.block_range`, "must be an object with from and to");
      } else {
        checkKeys(r.block_range, `${p}.block_range`, ["from", "to"]);
        const from = checkCount(r.block_range, `${p}.block_range`, "from");
        const to = checkCount(r.block_range, `${p}.block_range`, "to");
        if (from !== null && to !== null && from > to) err(`${p}.block_range`, `from (${from}) must be <= to (${to})`);
      }
    }
    if (!hasHashes && isObj(doc.totals) && isCount(doc.totals.paid_calls) && doc.totals.paid_calls <= 100) {
      warn(`${p}.settlement_tx_hashes`, `paid_calls is ${doc.totals.paid_calls}: at this volume listing every settlement tx hash is expected, block_range alone is the high-volume concession`);
    }
  }

  if ("notes" in doc && typeof doc.notes !== "string") err("$.notes", "must be a string when present");
  if ("extensions" in doc && !isObj(doc.extensions)) err("$.extensions", "must be an object when present");

  // Report.
  for (const w of warnings) console.error(`WARN  ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR ${e}`);
    console.error(`\nFAIL: ${arg}: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`OK: ${arg} is a valid x402-metrics v${SPEC_VERSION} document (${warnings.length} warning(s))`);
}

main();

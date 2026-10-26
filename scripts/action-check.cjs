// Reads prodlint's result for the GitHub Action (action.yml) and decides whether the check
// fails: on critical findings (unless fail-on-critical is false), on a score below
// threshold, and whenever prodlint didn't produce a result. A failed scan used to read as
// a score of 0 with no criticals, so by default it passed.
//
// Usage:
//   node scripts/action-check.cjs outputs <prodlint-result.json>  # score/critical/scanned lines for $GITHUB_OUTPUT
//   node scripts/action-check.cjs check <prodlint-result.json>    # ::error:: lines; exits 1 if the check fails
// `check` reads SCAN_EXIT_CODE, INPUT_THRESHOLD and INPUT_FAIL_ON_CRITICAL from the environment.

const fs = require('fs');

/** The parsed result, or null when prodlint didn't write one (it crashed, or npx couldn't run it) */
function readResult(path) {
  try {
    const result = JSON.parse(fs.readFileSync(path, 'utf8'));
    return result && typeof result === 'object' && result.summary ? result : null;
  } catch {
    return null;
  }
}

function readInputs(env) {
  return {
    exitCode: Number.parseInt(env.SCAN_EXIT_CODE ?? '', 10),
    threshold: Number.parseInt(env.INPUT_THRESHOLD ?? '', 10) || 0,
    failOnCritical: !/^(false|no|off|0)$/i.test((env.INPUT_FAIL_ON_CRITICAL ?? '').trim()),
  };
}

/** Why the check fails; empty when it passes */
function failures(result, { exitCode, threshold, failOnCritical }) {
  // prodlint exits 0 without criticals and 1 with them; anything else means the scan failed
  if (!result || (exitCode !== 0 && exitCode !== 1)) {
    return [`prodlint didn't finish the scan (exit code ${Number.isNaN(exitCode) ? 'unknown' : exitCode}). See the "Run prodlint" step's log.`];
  }

  const errors = [];
  const critical = Number(result.summary.critical) || 0;
  const score = Number(result.overallScore) || 0;
  if (failOnCritical && critical > 0) {
    const them = critical === 1 ? 'it' : 'them';
    errors.push(`prodlint found ${critical} critical issue${critical === 1 ? '' : 's'}. Fix ${them}, or set fail-on-critical: false to report ${them} without failing.`);
  }
  if (score < threshold) {
    errors.push(`Prodlint score (${score}) is below threshold (${threshold})`);
  }
  return errors;
}

if (require.main === module) {
  const [mode, resultPath] = process.argv.slice(2);
  const result = readResult(resultPath);

  if (mode === 'outputs') {
    console.log(`score=${result ? Number(result.overallScore) || 0 : 0}`);
    console.log(`critical=${result ? Number(result.summary.critical) || 0 : 0}`);
    console.log(`scanned=${result ? 'true' : 'false'}`);
  } else if (mode === 'check') {
    const errors = failures(result, readInputs(process.env));
    for (const error of errors) console.log(`::error::${error}`);
    process.exit(errors.length > 0 ? 1 : 0);
  } else {
    console.error('Usage: action-check.cjs outputs|check <prodlint-result.json>');
    process.exit(2);
  }
}

module.exports = { failures, readInputs, readResult };

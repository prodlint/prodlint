// Builds the PR comment that the GitHub Action (action.yml) posts.
//
// This used to be an inline `node -e "..."` in action.yml, where bash's double-quote
// processing quietly rewrote the escaper's regex and dropped the backslash from it.
// Anything here that comes from the scanned repo — file paths, and finding messages that
// echo import names, table names and the like — is untrusted. It's flattened to one line
// so it can't open new markdown blocks, and rendered as inline code, where GitHub doesn't
// autolink, @-mention or render HTML.
//
// Usage: node scripts/action-comment.cjs <prodlint-result.json> <comment.md>

const fs = require('fs');

const MAX_CRITICALS = 10;
const MAX_FIELD_LENGTH = 300;

// Control characters (newlines included) and the Unicode line and paragraph separators.
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

function singleLine(value) {
  const flat = String(value).replace(CONTROL_CHARS, ' ').trim();
  return flat.length > MAX_FIELD_LENGTH ? `${flat.slice(0, MAX_FIELD_LENGTH)}…` : flat;
}

// A code span only closes on a backtick run as long as its fence, so the fence is one
// backtick longer than the longest run inside. Content touching a fence gets padded.
function inlineCode(value) {
  const text = singleLine(value);
  const longestRun = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

// For table cells: escape every character with markdown meaning, backslash first.
function plain(value) {
  return singleLine(value).replace(/[\\`*_{}[\]()<>#|~!&]/g, '\\$&');
}

function scoreIcon(score) {
  if (score >= 80) return '✅';
  if (score >= 60) return '⚠️';
  return '🚨';
}

function categoryIcon(score) {
  if (score >= 80) return '🟢';
  if (score >= 60) return '🟡';
  return '🔴';
}

function buildComment(result) {
  const score = Number(result.overallScore) || 0;
  const lines = [
    `## ${scoreIcon(score)} Production Readiness: **${score}/100**`,
    '',
    '| Category | Score | Issues |',
    '|----------|-------|--------|',
  ];

  for (const c of result.categoryScores || []) {
    const categoryScore = Number(c.score) || 0;
    lines.push(`| ${categoryIcon(categoryScore)} ${plain(c.category)} | ${categoryScore}/100 | ${Number(c.findingCount) || 0} |`);
  }

  const criticals = (result.findings || []).filter((f) => f.severity === 'critical');
  if (criticals.length > 0) {
    lines.push('', '### Critical Issues', '');
    for (const f of criticals.slice(0, MAX_CRITICALS)) {
      lines.push(`- ${inlineCode(f.ruleId)} ${inlineCode(`${f.file}:${Number(f.line) || 0}`)} — ${inlineCode(f.message)}`);
    }
    if (criticals.length > MAX_CRITICALS) {
      lines.push(`- ...and ${criticals.length - MAX_CRITICALS} more`);
    }
  }

  lines.push('', '---');
  lines.push(`*Scanned ${Number(result.filesScanned) || 0} files in ${Number(result.scanDurationMs) || 0}ms · [prodlint](https://prodlint.com)*`);
  return lines.join('\n');
}

if (require.main === module) {
  const [resultPath, outputPath] = process.argv.slice(2);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  fs.writeFileSync(outputPath, buildComment(result) + '\n');
}

module.exports = { buildComment, inlineCode, singleLine };

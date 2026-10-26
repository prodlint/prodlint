import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'

// Commonly hallucinated packages that AI suggests but don't exist or are wrong, each with
// the package usually meant. Source: https://snyk.io/articles/package-hallucinations/ +
// community reports. Checked against the npm registry on 2026-10-26: every name is missing,
// unpublished, an npm security placeholder, deprecated, or an old package that isn't the one
// people mean. (gpt-tokenizer used to be listed; it's a real, maintained tokenizer.)
const PHANTOM_PACKAGES = new Map<string, string[]>([
  ['huggingface-cli', ['@huggingface/hub']],        // a Python CLI; an npm placeholder
  ['flask-hierarchical', []],                       // not on npm
  ['beautifulsoup', ['cheerio']],                   // a Python library (beautifulsoup4); not on npm
  ['python-dotenv', ['dotenv']],                    // a Python library; an npm placeholder
  ['openai-sdk', ['openai']],                       // unpublished
  ['anthropic-sdk', ['@anthropic-ai/sdk']],         // an npm placeholder
  ['langchain-core', ['@langchain/core']],          // deprecated
  ['react-native-utils', []],                       // a 2015 native module
  ['next-middleware', []],                          // a 2017 0.0.1; Next.js has middleware built in
  ['supabase-client', ['@supabase/supabase-js']],   // unpublished
  ['stripe-sdk', ['stripe']],                       // not on npm
  ['prisma-client', ['@prisma/client']],            // an empty 0.0.0 placeholder
  ['tailwind-utils', []],                           // a 2021 alpha
  ['express-validator-v2', ['express-validator']],  // not on npm
  ['node-postgres-pool', ['pg']],                   // not on npm
  ['mongo-client', ['mongodb']],                    // a 2013 wrapper
  ['redis-client', ['redis', 'ioredis']],           // a 2015 client
  ['aws-s3-upload', ['@aws-sdk/client-s3']],        // a 2018 0.0.2
])

// Real, established packages the name patterns below would flag (checked on npm)
const KNOWN_PACKAGES = new Set([
  // 2-char names
  'pg', 'ws', 'ms', 'qs', 'ip', 'is', 'he', 'ky', 'bl', 'rc', 'io', 'db', 'fp', 'rx',
  // -js suffix
  'crypto-js', 'chroma-js', 'libphonenumber-js', 'ua-parser-js', 'keycloak-js', 'pusher-js',
  'matter-js', 'amplitude-js',
  // Vanity prefixes
  'fast-glob', 'fast-deep-equal', 'fast-json-stable-stringify', 'fast-xml-parser',
  'fast-levenshtein', 'fast-safe-stringify', 'fast-uri', 'fast-equals', 'fast-csv',
  'fast-check', 'fast-diff', 'simple-git', 'simple-peer', 'simple-icons',
])

// Suspicious patterns in package names (typosquatting indicators)
const SUSPICIOUS_PATTERNS = [
  /^[a-z]{1,2}$/, // 1-2 char names
  /-js$/, // redundant -js suffix often hallucinated
  /^(the|my|simple|easy|fast|super|mega|ultra)-/, // vanity prefixes
]

/** `"a"`, or `"a" or "b"` */
function quoteList(names: string[]): string {
  return names.map(n => `"${n}"`).join(' or ')
}

export const phantomDependencyRule: Rule = {
  id: 'phantom-dependency',
  name: 'Phantom Dependency',
  description: 'Detects commonly hallucinated or suspicious package names — slopsquatting prevention',
  category: 'security',
  severity: 'warning',
  fileExtensions: [],

  check(): Finding[] {
    return []
  },

  checkProject(_files: FileContext[], project: ProjectContext): Finding[] {
    if (!project.packageJson) return []

    const findings: Finding[] = []
    const deps = {
      ...((project.packageJson as Record<string, unknown>).dependencies as Record<string, string> ?? {}),
      ...((project.packageJson as Record<string, unknown>).devDependencies as Record<string, string> ?? {}),
    }

    for (const [name, _version] of Object.entries(deps)) {
      const meant = PHANTOM_PACKAGES.get(name)
      if (meant) {
        findings.push({
          ruleId: 'phantom-dependency',
          file: 'package.json',
          line: 1,
          column: 1,
          message: meant.length > 0
            ? `"${name}" is a commonly hallucinated package name — did you mean ${quoteList(meant)}?`
            : `"${name}" is a commonly hallucinated package name — verify it exists and is the correct package`,
          severity: 'warning',
          category: 'security',
          fix: meant.length > 0
            ? `Check "${name}" on npm before relying on it. If you meant ${quoteList(meant)}, install that instead and update the code that imports "${name}"`
            : `Check "${name}" on npm before relying on it — it may not exist, or may not be the package you meant`,
        })
      }

      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(name) && !name.startsWith('@') && !KNOWN_PACKAGES.has(name)) {
          findings.push({
            ruleId: 'phantom-dependency',
            file: 'package.json',
            line: 1,
            column: 1,
            message: `"${name}" has a suspicious package name pattern — verify it's legitimate`,
            severity: 'info',
            category: 'security',
            fix: 'Verify the package on npm — suspicious names may indicate typosquatting or hallucination',
          })
          break
        }
      }
    }

    return findings
  },
}

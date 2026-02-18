import type { Rule, Finding, FileContext, ProjectContext } from '../types.js'

// Commonly hallucinated packages that AI suggests but don't exist or are wrong
// Source: https://snyk.io/articles/package-hallucinations/ + community reports
const PHANTOM_PACKAGES = new Set([
  'huggingface-cli',       // hallucinated, real: huggingface_hub
  'flask-hierarchical',    // hallucinated
  'beautifulsoup',         // real is beautifulsoup4
  'python-dotenv',         // real is python-dotenv (this one exists but confusable)
  'openai-sdk',            // hallucinated, real: openai
  'anthropic-sdk',         // hallucinated, real: @anthropic-ai/sdk
  'langchain-core',        // confusable with @langchain/core
  'react-native-utils',    // hallucinated generic
  'next-middleware',        // hallucinated
  'supabase-client',       // hallucinated, real: @supabase/supabase-js
  'stripe-sdk',            // hallucinated, real: stripe
  'prisma-client',         // hallucinated, real: @prisma/client
  'tailwind-utils',        // hallucinated
  'express-validator-v2',  // hallucinated
  'node-postgres-pool',    // hallucinated, real: pg
  'mongo-client',          // hallucinated, real: mongodb
  'redis-client',          // hallucinated, real: redis or ioredis
  'aws-s3-upload',         // hallucinated
  'gpt-tokenizer',         // exists but often confused
])

// Suspicious patterns in package names (typosquatting indicators)
const SUSPICIOUS_PATTERNS = [
  /^[a-z]{1,2}$/, // 1-2 char names
  /-js$/, // redundant -js suffix often hallucinated
  /^(the|my|simple|easy|fast|super|mega|ultra)-/, // vanity prefixes
]

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
      if (PHANTOM_PACKAGES.has(name)) {
        findings.push({
          ruleId: 'phantom-dependency',
          file: 'package.json',
          line: 1,
          column: 1,
          message: `"${name}" is a commonly hallucinated package name — verify it exists and is the correct package`,
          severity: 'warning',
          category: 'security',
        })
      }

      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(name) && !name.startsWith('@')) {
          findings.push({
            ruleId: 'phantom-dependency',
            file: 'package.json',
            line: 1,
            column: 1,
            message: `"${name}" has a suspicious package name pattern — verify it's legitimate`,
            severity: 'info',
            category: 'security',
          })
          break
        }
      }
    }

    return findings
  },
}

import { describe, it, expect } from 'vitest'
import { missingLoadingStateRule } from '../../src/rules/missing-loading-state.js'
import { makeFile, makeProject } from '../helpers.js'

const project = makeProject()

describe('missing-loading-state rule', () => {
  it('detects useEffect+fetch without loading state', () => {
    const file = makeFile([
      "'use client'",
      'export default function Users() {',
      '  const [users, setUsers] = useState([])',
      '  useEffect(() => {',
      '    fetch("/api/users").then(r => r.json()).then(setUsers)',
      '  }, [])',
      '  return <div>{users.length}</div>',
      '}',
    ].join('\n'), { relativePath: 'components/Users.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('loading')
  })

  it('ignores when loading state exists', () => {
    const file = makeFile([
      "'use client'",
      'export default function Users() {',
      '  const [users, setUsers] = useState([])',
      '  const [loading, setLoading] = useState(true)',
      '  useEffect(() => {',
      '    fetch("/api/users").then(r => r.json()).then(d => { setUsers(d); setLoading(false) })',
      '  }, [])',
      '  return <div>{loading ? "..." : users.length}</div>',
      '}',
    ].join('\n'), { relativePath: 'components/Users.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores when isLoading state exists', () => {
    const file = makeFile([
      "'use client'",
      'export default function Users() {',
      '  const [isLoading, setIsLoading] = useState(true)',
      '  useEffect(() => { fetch("/api") }, [])',
      '  return <div>{isLoading ? "..." : "done"}</div>',
      '}',
    ].join('\n'), { relativePath: 'components/Users.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores server components', () => {
    const file = makeFile([
      'export default async function Users() {',
      '  const res = await fetch("/api/users")',
      '  return <div>Server</div>',
      '}',
    ].join('\n'), { relativePath: 'app/users/page.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores when useSWR is used', () => {
    const file = makeFile([
      "'use client'",
      'export default function Users() {',
      '  useEffect(() => { fetch("/api") }, [])',
      '  const { data } = useSWR("/api/users")',
      '  return <div>{data}</div>',
      '}',
    ].join('\n'), { relativePath: 'components/Users.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores when Skeleton component is used', () => {
    const file = makeFile([
      "'use client'",
      'export default function Users() {',
      '  useEffect(() => { fetch("/api") }, [])',
      '  return <Skeleton />',
      '}',
    ].join('\n'), { relativePath: 'components/Users.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(0)
  })

  it('ignores files without useEffect', () => {
    const file = makeFile([
      "'use client'",
      'export default function Static() {',
      '  return <div>No fetch</div>',
      '}',
    ].join('\n'), { relativePath: 'components/Static.tsx', ext: 'tsx' })
    const findings = missingLoadingStateRule.check(file, project)
    expect(findings).toHaveLength(0)
  })
})

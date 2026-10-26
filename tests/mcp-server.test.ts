import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const MCP_PATH = join(__dirname, '..', 'dist', 'mcp.js')
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version

interface RpcResponse {
  id?: number
  result?: {
    content?: { type: string; text: string }[]
    isError?: boolean
    [key: string]: unknown
  }
  error?: { code: number; message: string }
}

// Talks to the built server the way an MCP client does: newline-delimited JSON-RPC
// over the child's stdin/stdout.
class StdioClient {
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, (msg: RpcResponse) => void>()
  stderr = ''

  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (!line) continue
        let msg: RpcResponse
        try {
          msg = JSON.parse(line)
        } catch {
          // Anything but JSON-RPC on stdout corrupts the protocol for real clients.
          this.stderr += `\n[non-JSON line on stdout] ${line}`
          continue
        }
        if (msg.id !== undefined) {
          this.pending.get(msg.id)?.(msg)
          this.pending.delete(msg.id)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<RpcResponse> {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`No response to ${method} within ${timeoutMs}ms. Server stderr: ${this.stderr || '(empty)'}`))
      }, timeoutMs)
      this.pending.set(id, msg => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  callTool(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
    return this.request('tools/call', { name, arguments: args })
  }
}

const textOf = (res: RpcResponse) => res.result?.content?.[0]?.text ?? ''

describe('MCP server over stdio (dist/mcp.js)', () => {
  let child: ChildProcessWithoutNullStreams
  let client: StdioClient
  let project: string
  let init: RpcResponse

  beforeAll(async () => {
    if (!existsSync(MCP_PATH)) {
      throw new Error(`${MCP_PATH} is missing; run \`npm run build\` before \`npm test\`.`)
    }

    // The scan tool only accepts paths inside the server's working directory, so the
    // server runs from a throwaway project with one deliberate SQL injection.
    project = join(tmpdir(), `prodlint-mcp-test-${Date.now()}`)
    mkdirSync(join(project, 'app', 'api', 'users'), { recursive: true })
    writeFileSync(join(project, 'package.json'), '{ "name": "fixture", "private": true }\n')
    writeFileSync(
      join(project, 'app', 'api', 'users', 'route.ts'),
      [
        'export async function GET(req: Request) {',
        '  const id = new URL(req.url).searchParams.get("id")',
        '  const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`)',
        '  return Response.json(rows)',
        '}',
        '',
      ].join('\n'),
    )

    child = spawn(process.execPath, [MCP_PATH], { cwd: project, stdio: 'pipe' })
    client = new StdioClient(child)
    init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'prodlint-test', version: '0.0.0' },
    })
    client.notify('notifications/initialized')
  }, 30000)

  afterAll(async () => {
    // Wait for the exit: on Windows the server's working directory can't be removed
    // while the process is still alive.
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        child.once('exit', resolve)
        child.kill()
      })
    }
    if (project) rmSync(project, { recursive: true, force: true })
  })

  it('identifies itself as prodlint at the package version', () => {
    expect(init.error).toBeUndefined()
    expect(init.result?.serverInfo).toMatchObject({ name: 'prodlint', version: VERSION })
  })

  it('lists the scan and scan-web tools with their required inputs', async () => {
    const res = await client.request('tools/list', {})
    const tools = (res.result?.tools ?? []) as { name: string; inputSchema: { required?: string[] } }[]
    expect(tools.map(t => t.name).sort()).toEqual(['scan', 'scan-web'])
    expect(tools.find(t => t.name === 'scan')?.inputSchema.required).toEqual(['path'])
    expect(tools.find(t => t.name === 'scan-web')?.inputSchema.required).toEqual(['url'])
  })

  it('scans a project inside its working directory and reports findings', async () => {
    const res = await client.callTool('scan', { path: project })
    expect(res.result?.isError).toBeFalsy()
    expect(textOf(res)).toContain('## Production Readiness:')
    expect(textOf(res)).toContain('`sql-injection`')
  })

  it('rejects arguments that fail the input schema', async () => {
    const res = await client.callTool('scan', { path: 123 })
    // SDK versions differ on whether this comes back as a JSON-RPC error or an isError result.
    expect(res.error !== undefined || res.result?.isError === true).toBe(true)
  })

  it('refuses to scan outside its working directory', async () => {
    const res = await client.callTool('scan', { path: dirname(project) })
    expect(res.result?.isError).toBe(true)
    expect(textOf(res)).toContain('must be within the current working directory')
  })

  it('reports a missing directory instead of scanning it', async () => {
    const res = await client.callTool('scan', { path: join(project, 'missing') })
    expect(res.result?.isError).toBe(true)
    expect(textOf(res)).toContain('does not exist')
  })

  it('refuses private and loopback hosts in scan-web', async () => {
    for (const url of ['http://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'http://localhost.']) {
      const res = await client.callTool('scan-web', { url })
      expect(res.result?.isError, url).toBe(true)
      expect(textOf(res), url).toContain('Cannot scan private or internal hosts')
    }
  })
})

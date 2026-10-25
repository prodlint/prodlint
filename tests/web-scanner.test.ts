import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import { gzipSync } from 'node:zlib'
import {
  isPrivateHost,
  isPrivateAddress,
  resolvesToPrivateAddress,
  guardedLookup,
  guardedGet,
  normalizeUrl,
} from '../src/web-scanner/index.js'

describe('isPrivateHost', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '[::1]', '[::]', '[fe80::1]', '[fd00::1]', '[fc00::1]',
    // IPv6 forms that route to private IPv4: mapped, NAT64, 6to4
    '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[64:ff9b::a9fe:a9fe]', '[2002:7f00:1::1]',
    'localhost', 'localhost.', 'app.localhost', 'metadata.google.internal', 'metadata.google.internal.',
  ])('blocks %s', (host) => {
    expect(isPrivateHost(host)).toBe(true)
  })

  it.each([
    'example.com', 'fdic.gov', 'fcc.gov', 'fd.io', 'fcbarcelona.com', 'fe80.example.com',
    '8.8.8.8', '[2606:4700:4700::1111]', '[::ffff:808:808]', '[64:ff9b::808:808]',
  ])('allows %s', (host) => {
    expect(isPrivateHost(host)).toBe(false)
  })

  it("sees through the URL parser's IPv4 shorthands", () => {
    for (const input of ['2130706433', '0x7f.1', '127.1', '[::ffff:169.254.169.254]']) {
      expect(isPrivateHost(new URL(normalizeUrl(input)).hostname)).toBe(true)
    }
  })
})

describe('isPrivateAddress', () => {
  it('handles dotted-quad tails and zone ids', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })

  it('ignores anything that is not an IP address', () => {
    expect(isPrivateAddress('fd.io')).toBe(false)
    expect(isPrivateAddress('')).toBe(false)
  })
})

describe('resolvesToPrivateAddress', () => {
  it('flags names that resolve to loopback', async () => {
    expect(await resolvesToPrivateAddress('localhost')).toBe(true)
  })

  it('passes public IP literals', async () => {
    expect(await resolvesToPrivateAddress('8.8.8.8')).toBe(false)
  })
})

describe('guardedLookup', () => {
  it('refuses to hand out private addresses', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((done) => {
      guardedLookup('localhost', {}, (e) => done(e))
    })
    expect(err?.code).toBe('EPRIVATEADDR')
  })
})

describe('guardedGet', () => {
  // The real lookup refuses loopback, so point a public-looking name at the test server.
  const toLoopback: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
    else callback(null, '127.0.0.1', 4)
  }

  let server: Server | undefined
  const seen: string[] = []

  async function listen(handler: RequestListener): Promise<string> {
    seen.length = 0
    server = createServer((req, res) => {
      seen.push(req.url ?? '')
      handler(req, res)
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    return `http://scanner-test.example:${(server.address() as AddressInfo).port}`
  }

  afterEach(() => {
    server?.closeAllConnections()
    server?.close()
    server = undefined
  })

  it('applies the deadline to the body, not just the headers', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200)
      res.write('partial') // never ends
    })
    const started = Date.now()
    expect(await guardedGet(`${base}/`, 300, toLoopback)).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('stops reading at the body size cap', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200)
      const chunk = 'x'.repeat(64 * 1024)
      let open = true
      res.on('close', () => { open = false })
      const pump = () => {
        while (open && res.write(chunk)) { /* keep writing until backpressure */ }
        if (open) res.once('drain', pump)
      }
      pump()
    })
    const result = await guardedGet(`${base}/`, 10_000, toLoopback)
    expect(result?.body.length).toBe(5 * 1024 * 1024)
  })

  it('re-checks every redirect hop', async () => {
    let port = 0
    const base = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/internal` })
        res.end()
        return
      }
      res.end('reached')
    })
    port = Number(new URL(base).port)
    expect(await guardedGet(`${base}/start`, 2000, toLoopback)).toBeNull()
    expect(seen).toEqual(['/start'])
  })

  it('follows redirects to public hosts', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(301, { location: '/final' })
        res.end()
        return
      }
      res.writeHead(200, { 'ai-disclosure': 'none' })
      res.end('ok')
    })
    const result = await guardedGet(`${base}/start`, 2000, toLoopback)
    expect(result).toMatchObject({ status: 200, body: 'ok', headers: { 'ai-disclosure': 'none' } })
  })

  it('gives up on redirect loops', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(302, { location: '/loop' })
      res.end()
    })
    expect(await guardedGet(`${base}/loop`, 2000, toLoopback)).toBeNull()
    expect(seen.length).toBe(6) // the first request plus five redirects
  })

  it('decompresses gzip responses', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      res.end(gzipSync('User-agent: GPTBot\nDisallow: /\n'))
    })
    const result = await guardedGet(`${base}/robots.txt`, 2000, toLoopback)
    expect(result?.body).toContain('GPTBot')
  })

  it('refuses private hosts before connecting', async () => {
    const base = await listen((_req, res) => res.end('reached'))
    const { port } = new URL(base)
    expect(await guardedGet(`http://127.0.0.1:${port}/`, 2000)).toBeNull()
    expect(await guardedGet(`http://[::ffff:7f00:1]:${port}/`, 2000)).toBeNull()
    expect(seen).toEqual([])
  })
})

#!/usr/bin/env node

import { type SocketAddress, createConnection } from 'node:net'
import open from 'open'
import * as fs from 'node:fs'
import { resolve, join } from 'node:path'
import yargs from 'yargs/yargs'
import { type IncomingMessage, STATUS_CODES, ServerResponse, createServer } from 'node:http'
import accepts from 'accepts'
import serv, { type NextFunc } from './static'
import etag from 'etag'
import mus from 'mustache'

//#region YARGS

const argv = yargs(process.argv.splice(2))

.scriptName('serve')
.usage('$0 [options...]')
.alias('h', 'help')
.alias('v', 'version')
.group('h', 'General Options:')
.epilogue('You can add "//" to the start of URL path to force directory list instead of "--si" argument fallback. Example: "http://example.com//file/path/".')
.detectLocale(false)
.strict(true)

.options({
	p: {
		alias: 'port',
		group: 'General Options:',
		desc: 'Server port',
		type: 'number',
		default: 80
	},
	o: {
		alias: 'open',
		group: 'General Options:',
		desc: 'Open in browser',
		type: 'boolean',
		default: false
	},
	i: {
		alias: 'init',
		group: 'General Options:',
		desc: 'Init serve project',
		type: 'boolean',
		default: false
	},
	t: {
		alias: 'template-page',
		group: 'General Options:',
		desc: 'Path to the file used as the status page template. Priority: specific page > arg > ./.status.html > SCRIPT_DIR/assets/status.html',
		type: 'string',
		default: './.status.html'
	},
	e: {
		alias: 'err-page',
		group: 'General Options:',
		desc: 'Path to the file that server will respond with if an Internal Server Error occurs. Priority: arg > ./.500.html',
		type: 'string',
		default: './.500.html'
	},
	n: {
		alias: 'not-found-page',
		group: 'General Options:',
		desc: 'Path to the file that server will respond with if requested path is not found. Priority: arg > ./.404.html',
		type: 'string',
		default: './.404.html'
	},
	f: {
		alias: 'forbidden-page',
		group: 'General Options:',
		desc: 'Path to the file that server will respond with if request is forbidden. Priority: arg > ./.403.html',
		type: 'string',
		default: './.403.html'
	},
	r: {
		alias: 'routes',
		group: 'General Options:',
		desc: 'Path to routes map. Priority: arg > ./.routes',
		type: 'string',
		default: './.routes'
	},
	'sd': {
		alias: 's-dotfiles',
		group: 'Static Options:',
		desc: 'Determines how dotfiles (files or directories that begin with a dot ".") are treated',
		type: 'string',
		choices: ['allow', 'ignore', 'deny'],
		default: 'ignore',
		coerce(arg: string) {
			if (!['allow', 'ignore', 'deny'].includes(arg))
				throw new Error('Param "--s-dotfiles" must be one of the following: "allow" | "ignore" | "deny"')
			return arg as 'allow' | 'ignore' | 'deny'
		}
	},
	'st': {
		alias: 's-etag',
		group: 'Static Options:',
		desc: 'ETag generation. Use "--no-st" to disable it',
		type: 'boolean',
		default: true
	},
	'sl': {
		alias: 's-last-modified',
		group: 'Static Options:',
		desc: 'Last-Modified generation. Use "--no-sl" to disable it',
		type: 'boolean',
		default: true
	},
	'sx': {
		alias: 's-extensions',
		group: 'Static Options:',
		desc: 'Sets file extension fallbacks: If a file is not found, search for files with the specified extensions and serve the first one found',
		type: 'string',
		array: true,
		default: null,
		defaultDescription: 'false'
	},
	'si': {
		alias: 's-index',
		group: 'Static Options:',
		desc: 'Sends the specified directory index file. Use "--no-si" to disable directory indexing',
		type: 'string',
		default: 'index.html'
	},
	'sa': {
		alias: 's-max-age',
		group: 'Static Options:',
		desc: 'Sets the max-age property of the Cache-Control header',
		type: 'number',
		default: 0,
		coerce(arg: number) {
			if (!(0 <= arg && arg < Infinity))
				throw new Error('Param "--s-max-age" must be a finite positive value')
			return arg
		}
	}
})
.check((argv) => {
	if (!Number.isInteger(argv.p))
		throw new Error('Port must be an integer')

	if (argv.p < 0 || argv.p > 65535)
		throw new Error('Port must be in range [0-65535]')

	return true
})
.parseSync()

//#endregion
//#region TYPES

interface Route {
	redirect: boolean
	try(path: string): string | undefined
}

type RequestListener = (req: IncomingMessage, res: CustomResponse) => void

//#endregion
//#region PROCESSING ARGS

process.stdout.write(`Root: ${resolve('./')}\nStatus template page: `)

let tPath = argv.t
if (!fs.existsSync(tPath)) {
	tPath = resolve(__dirname + '/assets/status.html')

	if (!fs.existsSync(tPath)) {
		tPath = ''
		console.log('asset is missing!')
	} else console.log('built-in')
} else console.log(tPath)

process.stdout.write('Error page: ')

let errorPath = argv.e
if (!fs.existsSync(errorPath)) {
	errorPath = ''
	console.log('from template')
} else console.log(errorPath)

process.stdout.write('Not Found page: ')

let nfPath = argv.n
if (!fs.existsSync(nfPath)) {
	nfPath = ''
	console.log('from template')
} else console.log(nfPath)

process.stdout.write('Forbidden page: ')

let fPath = argv.f
if (!fs.existsSync(fPath)) {
	fPath = ''
	console.log('from template')
} else console.log(fPath)

process.stdout.write('Routes list: ')

let routesPath = argv.r
if (!fs.existsSync(routesPath)) {
	routesPath = ''
	console.log('not found')
} else console.log('found')

const DOTFILES = argv.sd
const ETAG = argv.st
const LAST_MODIFIED = argv.sl
const EXTENSIONS = argv.sx ?? false
const INDEX = argv.si
const MAX_AGE = argv.sa

const OPEN_IN_BROWSER = argv.o
const TEMPLATE_PAGE = tPath ? fs.readFileSync(tPath, { encoding: 'utf-8' })
	: `<h1>{{code}} | {{desc}}</h1>
Script asset "${resolve(__dirname + '/assets/status.html')}" is missing`
const ERROR_PAGE = errorPath ? fs.readFileSync(errorPath) : undefined
const NOT_FOUND_PAGE = nfPath ? fs.readFileSync(nfPath) : undefined
const FORBIDDEN_PAGE = fPath ? fs.readFileSync(fPath) : undefined
const ROUTES_FILE = routesPath ? fs.readFileSync(routesPath).toString() : ''
const ROUTES_TEMPLATE_PATH = resolve(__dirname + '/assets/routes')
const ROUTES_TEMPLATE = fs.existsSync(ROUTES_TEMPLATE_PATH)
	? fs.readFileSync(ROUTES_TEMPLATE_PATH)
	: `# Script asset "${resolve(__dirname + '/assets/routes')}" is missing`

if (argv.i) {
	fs.writeFileSync('./.routes', ROUTES_TEMPLATE)

	process.exit()
}

//#endregion
//#region ROUTES

const route = (path: string): [redirect: boolean, path: string] => {
	for (const r of ROUTES) {
		const p = r.try(path)
		if (typeof p === 'string') return [r.redirect, p.replace(/\/+$/, '/')]
	}

	return [false, path]
}

const ROUTES = ROUTES_FILE.split('\n').map((line, i) => {
	line = line.split('#')[0]
	line = line.trim()
	if (!line) return null

	function err() { throw new Error(`Malformed route at line ${i + 1}:\n${line}`) }

	const s = /^(?<q>&?&?)\s*(?<req>\/\S*?)\s*(?<op>[:=>])\s*(?<res>\S*?)$/.exec(line)
	if (!s) err()
	const g = s!.groups!
	if (g.q && !g.req.endsWith('/')) err()

	return {
		redirect: g.op === '>',
		try: g.q
		? (p, r = new RegExp(`${g.req.startsWith('^') ? '' : '^'}${g.req.slice(0, -1)}`, g.q === '&' ? 'i' : undefined)) =>
			r.test(p) ? p.replace(r, g.res) : undefined
		: p => p.startsWith(g.req + (g.f ?? '')) ? p.replace(g.req, g.res) : undefined
	} as Route
}).filter(v => v) as Route[]

//#endregion
//#region UTILITY
const MIME_MAP = {
	html: 'text/html',
	json: 'application/json',
	text: 'text/plain'
}

mus.parse(TEMPLATE_PAGE)

const genStatusPage = (code: number, options: { font?: number, width?: number } = {}) => mus.render(TEMPLATE_PAGE, {
	font: 10,
	width: 70,
	...options,
	code,
	desc: STATUS_CODES[code],
	color: code < 500 ? '#f6b411' : '#e64227'
})

const STATUS_PAGES: Record<number, string | Buffer> = {
	403: FORBIDDEN_PAGE ?? genStatusPage(403, { font: 8.9 }),
	404: NOT_FOUND_PAGE ?? genStatusPage(404, { width: 52 }),
	405: NOT_FOUND_PAGE ?? genStatusPage(405),
	412: NOT_FOUND_PAGE ?? genStatusPage(412, { font: 7.6 }),
	416: NOT_FOUND_PAGE ?? genStatusPage(416),
	500: ERROR_PAGE ?? genStatusPage(500),
}

const isPortFree = (port: number) => new Promise<boolean>((res, rej) => {
	const client = createConnection({port}, () => {
		client.destroy()
		res(false)
	}).once('error', (err: NodeJS.ErrnoException) => {
		client.destroy()
		if (err.code === 'ECONNREFUSED') res(true)
		else rej(err)
	})
})

const getPath = (url: string) => url.split('?')[0]

const ETX = Buffer.of(3)
const EOT = Buffer.of(4)
const LOG1024 = Math.log(1024)
const LSYMS = ['_/‾', '/‾\\', '‾\\_', '\\_/']
const LIST_STYLE = '<style>table{border-spacing:2em .5em}' +
	'body{font-family:monospace;font-size:1.5em;color:#fff;background-color:#222231;white-space-collapse:preserve}' +
	'a{font-weight:bold;color:#54cbc0}a:not(:hover){text-decoration:none}' +
	'td:nth-child(n+2){text-align:right;text-wrap:nowrap}</style>'
const LIST_HEADER = '<tr><th>Name</th><th>Date modified</th><th>Size</th></tr>'

const pendingRequests: Map<IncomingMessage, [number, number]> = new Map()
const latestLogs: number[] = []

const getDataSizeUnit = (n: number) => n ? Math.trunc(Math.log(Math.abs(n)) / LOG1024) : 0
const movePendingRequests = (n: number) => pendingRequests.forEach((v, k) => pendingRequests.set(k, [v[0], v[1] + n]))
const updateStatus = (status: string, [col, row]: [number, number]) => {
	let dy = 0
	const latLogLen = latestLogs.length
	const termWidth = process.stdout.columns
	const indexLine = latLogLen - row
	for (let i = latLogLen - 1; i >= indexLine; i--) {
		dy += Math.ceil(latestLogs[i] / termWidth)
	}

	dy -= Math.floor(col / termWidth)

	const dx = col % termWidth

	process.stdout.moveCursor(dx, -dy)
	process.stdout.write(`${status}\x1b[${dy}E`)
}

const etagRegex = /^\s*(W\/)?"[^"]+"(\s*,\s*(W\/)?"[^"]+")*\s*$/
const gmtRegex = /^\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\s*$/

const ifMatch = (header: string, etag: string) => header.trim() === '*' || etagRegex.test(header) && header.includes(etag)
const ifNoneMatch = (header: string, etag: string) => etagRegex.test(header) && !header.includes(etag)
const ifModifiedSince = (header: string, modified: number) => gmtRegex.test(header) && Date.parse(header) < modified
const ifUnmodifiedSince = (header: string, modified: number) => gmtRegex.test(header) && Date.parse(header) >= modified
const ifRange = (header: string, etag: string, modified: number) => header.trim() === etag || ifUnmodifiedSince(header, modified)

export class CustomResponse extends ServerResponse {
	readonly locals = new Map()

	#etag(stats: string | Buffer | etag.StatsLike): string {
		return this.getHeaderOrInsert('ETag', etag(stats)) as string
	}
	#lastModified(stats: fs.Stats): number {
		return Date.parse(this.getHeaderOrInsert('Last-Modified', stats.mtime.toUTCString()) as string)
	}

	constructor(...args: ConstructorParameters<typeof ServerResponse>) {
		super(...args)

		this.once('finish', this.log)
	}

	log(): this { return reqLog(this.req, this) }
	getHeaderOrInsert(name: string, value: string | number | string[]): string | number | string[] {
		return this.getHeader(name) ?? (this.setHeader(name, value) && value)
	}
	typeLen(type: string, len: number): this {
		return this
		.setHeader('Content-Type', `${type}; charset=utf-8`)
		.setHeader('Content-Length', len)
	}
	send(type: string, body: string | Buffer): true {
		this.typeLen(type, body.length).end(this.req.method === 'HEAD' ? undefined : body)
		return true
	}
	status(code: number): this {
		this.statusCode = code
		return this
	}
	sendStatus(code: number): true {
		this.status(code).end()
		return true
	}
	format(map: { [key: string]: string | Buffer | (() => string | Buffer) }): true {
		const mimeTypes = Object.keys(map)
		let acceptType = accepts(this.req).type(mimeTypes)

		if (!acceptType) {
			const body = JSON.stringify({
				code: 'UnsupportedType',
				message: 'Only attached content types are supported.',
				types: mimeTypes
			})

			return this.status(406).send('application/json', body)
		}
		acceptType = typeof acceptType === 'string' ? acceptType : acceptType[0]
		const content = map[acceptType]

		return this.send(MIME_MAP[acceptType as 'html'] ?? acceptType, content instanceof Function ? content() : content)
	}
	sendError(code: number, msg = STATUS_CODES[code] ?? 'Unknown Error'): true {
		return this.cacheControl(MAX_AGE)
		.status(code).format({
			html: STATUS_PAGES[code] ?? genStatusPage(code),
			json: `{"error":"${msg}"}`,
			text: msg
		})
	}
	redirect(location: string): this {
		return this.writeHead(302, { location }).end()
	}
	cacheControl(maxAge: number): this {
		return this.setHeader('Cache-Control', `public, max-age=${maxAge}`)
	}
	checkConditionals(stats: fs.Stats): boolean {
		const hMatch = this.req.headers['if-match']
		const hNoneMatch = this.req.headers['if-none-match']
		const hModifiedSince = this.req.headers['if-modified-since']
		const hUnmodifiedSince = this.req.headers['if-unmodified-since']

		const etagValue = ETAG && this.#etag(stats)
		const lastModValue = LAST_MODIFIED && this.#lastModified(stats)

		if (etagValue) {
			if (hMatch && !ifMatch(hMatch, etagValue)) return this.sendError(412)
			if (hNoneMatch && !ifNoneMatch(hNoneMatch, etagValue)) return this.sendStatus(304)
		}

		if (lastModValue) {
			if (!hNoneMatch && hModifiedSince && !ifModifiedSince(hModifiedSince, lastModValue)) return this.sendStatus(304)
			if (hUnmodifiedSince && !ifUnmodifiedSince(hUnmodifiedSince, lastModValue)) return this.sendError(412)
		}

		return false
	}
	checkRange(stats: fs.Stats): boolean {
		if (!ETAG || !LAST_MODIFIED) return false

		const etagValue = this.#etag(stats)
		const lastModValue = this.#lastModified(stats)

		const hRange = this.req.headers['if-range']?.toString()

		return Boolean(hRange && this.req.headers['range'] && !ifRange(hRange, etagValue, lastModValue))
	}
	acceptRanges(is: boolean): this {
		return this.setHeader('Accept-Ranges', is ? 'bytes' : 'none')
	}
}

//#endregion
//#region LOGGER

let lSymbol = 0
setInterval(() => {
	process.stdout.write('\x1b7')
	pendingRequests.forEach((d, r) => {
		if (r.closed) pendingRequests.delete(r)

		updateStatus(LSYMS[lSymbol], d)
	})

	process.stdout.write(`\x1b8\x1b[1K\r${pendingRequests.size} request${pendingRequests.size === 1 ? '' : 's'} pending\r`) // \x1b[K

	lSymbol = (lSymbol + 1) % LSYMS.length
}, 4e2)

process.stdout.write('\x1b[?25l')

const reqLog = <Req extends IncomingMessage, Res extends ServerResponse>(req: Req, res: Res) => { //? Logger
	const h = req.socket.remoteAddress ?? '-'
	const r = `${req.method} ${req.url} HTTP/${req.httpVersion}`
	const b = res.getHeader('Content-Length') ?? '-'
	const ref = req.headers['referer'] ?? '-'
	const ua = req.headers['user-agent'] ?? '-'

	const afterStatus = `${b} "${ref}" "${ua}"`
	const line = `[${new Date().toISOString()}] ${h} - - "${r}" --- ${afterStatus}`

	latestLogs.push(line.length)
	console.log(line)

	movePendingRequests(1)
	pendingRequests.set(req, [line.length - afterStatus.length - 4, 1])

	res.once('close', () => {
		const d = pendingRequests.get(req) as [number, number]
		pendingRequests.delete(req)

		updateStatus(`${res.statusCode}`, d)

		const maxY = [...pendingRequests.values()].reduce((t, [_, y]) => Math.max(y, t), 0)
		latestLogs.splice(0, latestLogs.length - maxY)
	})

	return res
}

//#endregion
//#region SERVER

const exStatic = serv('./', {
	dotfiles: DOTFILES,
	extensions: EXTENSIONS,
	index: INDEX,
	maxAge: MAX_AGE,
})

const genHandler: RequestListener = (req, res) => { //? General handler
	const reqPath = getPath(req.url!)
	let path = decodeURI(reqPath)
	if (!['GET', 'HEAD'].includes(req.method!)) return res.sendError(405)
	if (reqPath.startsWith('//')) {
		res.locals.set('fs', true)
		path = path.slice(1)
		return fileHandler(req, res)
	}

	let [redir, newPath] = route(path)
	req.url = newPath + req.url!.split('?').splice(1).join('?')

	if (redir) return res.redirect(req.url)

	const nx: NextFunc = (err) => {
		if (err) {
			res.locals.set('err', err)

			errorHandler(req, res)
		}
		else fileHandler(req, res)
	}

	exStatic(req, res, nx)
}

const fileHandler: RequestListener = async (req, res) => { //? File handler
	if (res.statusCode === 404) res.status(200)
	else if (res.statusCode >= 500) return errorHandler(req, res)
	else if (res.statusCode < 200 || res.statusCode >= 300) return res.sendError(res.statusCode)

	const path = decodeURI(getPath(req.url!))
	if (path === '/favicon.ico') {
		const faviconPath = resolve(__dirname + '/assets/favicon.ico')

		if (fs.existsSync(faviconPath)) {
			const stats = fs.statSync(faviconPath)

			res
			.cacheControl(MAX_AGE)
			.typeLen('image/x-icon', stats.size)

			if (res.checkConditionals(stats)) return

			if (req.method === 'HEAD') return res.end()

			return fs.createReadStream(faviconPath).pipe(res)
		}
	}

	const fpath = resolve(`.${decodeURI(path)}`)
	if (path.endsWith('/') && !path.includes('/.') && fs.existsSync(fpath)) {
		const plist = (await fs.promises.readdir(fpath)).filter(p => !p.startsWith('.'))

		const flist = (await Promise.all(plist.map(f => fs.promises.stat(join(fpath, f)))))
			.map((f, i) => ({
				name: plist[i] + (f.isDirectory() ? '/' : ''),
				size: f.size,
				ctime: f.birthtime,
				mtime: f.mtime,
				toString() { return this.name }
			}))
		return res.format({
			html() {
				const up = path === '/' ? '' : `<tr><td><a href="..">..</a></td></tr>`
				const list = flist.map(f => {
					const dsu = getDataSizeUnit(f.size)
					const dsc = ' KMGTPEZY'[dsu] + (dsu ? 'i' : ' ') + 'B'

					return `<tr><td><a href="./${f}">${f}</a></td>` +
					`<td>${f.mtime.toLocaleString().replace(',', '')}</td>` +
					(f.size ? `<td>${Math.trunc(f.size / 1024**dsu * 10) / 10} ${dsc}</td>` : '') +
					'</tr>'
				}).join('')

				return `<!DOCTYPE html>${LIST_STYLE}<table>${LIST_HEADER}${up}${list}</table>`
			},
			json: () => JSON.stringify(flist),
			text: () => flist.join()
		})
	}

	return res.sendError(404)
}

const errorHandler: RequestListener = (req, res) => { //? Error handler
	const err = res.locals.get('err') as Error
	const errMsg = `We got some error here [${req.method} ${decodeURI(req.url!)}]:\n${err.stack}`
	console.error(errMsg)

	latestLogs.push(...errMsg.split('\n').map(v => v.length))

	movePendingRequests(errMsg.split('\n').length)

	res.sendError(500)
}

const ex = createServer({ ServerResponse: CustomResponse }, (req, res) => {
	res.setHeader('X-Powered-By', 'urobbyu/serve')
	genHandler(req, res)
})

let PORT = argv.p
isPortFree(PORT).then(isFree => {
	if (!isFree) {
		console.error(`Port ${PORT} is already in use. Switching to random free port.`)
		PORT = 0
	}

	const server = ex.listen(PORT, () => {
		const port = (server.address() as SocketAddress).port
		console.log(`http://localhost:${port} is listening.\nTo stop press CTRL+C...\n`)
		if (OPEN_IN_BROWSER) open(`http://localhost:${port}`)

		process.stdin.setRawMode(true)
		process.stdin.on('data', data => {
			if (data.equals(ETX) || data.equals(EOT)) process.exit()
		})
	})
})
//#endregion
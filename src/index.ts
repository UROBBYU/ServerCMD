#!/usr/bin/env node

import { SocketAddress, createConnection } from 'node:net'
import open from 'open'
import * as fs from 'node:fs'
import { resolve, join } from 'node:path'
import yargs from 'yargs/yargs'
import { IncomingMessage, ServerResponse, createServer } from 'node:http'
import accepts from 'accepts'
import serv, { NextFunc } from './static'
import etag from 'etag'

//? #################################
//? ############# YARGS #############
//? #################################

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
	e: {
		alias: 'err-page',
		group: 'General Options:',
		desc: 'Path to the file that server will respond with if an Internal Server Error occurs. Priority: arg > ./.500.html > SCRIPT_DIR/assets/500.html',
		type: 'string',
		default: './.500.html'
	},
	n: {
		alias: 'not-found-page',
		group: 'General Options:',
		desc: 'Path to the file that server will respond with if requested path is not found. Priority: arg > ./.404.html > SCRIPT_DIR/assets/404.html',
		type: 'string',
		default: './.404.html'
	},
	f: {
		alias: 'forbidden-page',
		group: 'General Options:',
		desc: 'Path to the file that server will respond with if request is forbidden. Priority: arg > ./.403.html > SCRIPT_DIR/assets/403.html',
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
		desc: 'Etag generation. Use "--no-st" to disable it',
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

//? #################################
//? ############# TYPES #############
//? #################################

interface Route {
	redirect: boolean
	try(path: string): string | undefined
}

export interface Response extends ServerResponse {
	locals: { [key: string]: any }
	log: () => this
	typeLen: (type: string, len: number) => this
	send: (type: string, body: string | Buffer) => this
	format: (map: { [key: string]: () => void }) => this
	status: (code: number) => this
	redirect: (location: string) => this
	etag: (stats: string | Buffer | etag.StatsLike) => this
	cacheControl: (maxAge: number) => this
	matchEtag: () => true | undefined
}

type RequestListener = (req: IncomingMessage, res: Response) => void

//? #################################
//? ######## PROCESSING ARGS ########
//? #################################

process.stdout.write(`Root: ${resolve('./')}\nError page: `)

let errorPath = argv.e
if (!fs.existsSync(errorPath)) {
	errorPath = resolve(__dirname + '/assets/500.html')

	if (!fs.existsSync(errorPath)) {
		errorPath = ''
		console.log('asset is missing!')
	} else console.log('built-in')
} else console.log(errorPath)

process.stdout.write('Not Found page: ')

let nfPath = argv.n
if (!fs.existsSync(nfPath)) {
	nfPath = resolve(__dirname + '/assets/404.html')

	if (!fs.existsSync(nfPath)) {
		nfPath = ''
		console.log('asset is missing!')
	} else console.log('built-in')
} else console.log(nfPath)

process.stdout.write('Forbidden page: ')

let fPath = argv.f
if (!fs.existsSync(fPath)) {
	fPath = resolve(__dirname + '/assets/403.html')

	if (!fs.existsSync(fPath)) {
		fPath = ''
		console.log('asset is missing!')
	} else console.log('built-in')
} else console.log(fPath)

process.stdout.write('Routes list: ')

let routesPath = argv.r
if (!fs.existsSync(routesPath)) {
	routesPath = ''
	console.log('not found')
} else console.log('found')

const DOTFILES = argv.sd
const ETAG = argv.st
const EXTENSIONS = argv.sx ?? false
const INDEX = argv.si
const MAX_AGE = argv.sa

const OPEN_IN_BROWSER = argv.o
const ERROR_PAGE = errorPath ? fs.readFileSync(errorPath)
	: `<h1>500 | Internal Server Error</h1>
Script asset "${resolve(__dirname + '/assets/500.html')}" is missing`
const NOT_FOUND_PAGE = nfPath ? fs.readFileSync(nfPath)
	: `<h1>404 | File Not Found</h1>
Script asset "${resolve(__dirname + '/assets/404.html')}" is missing`
const FORBIDDEN_PAGE = fPath ? fs.readFileSync(fPath)
	: `<h1>403 | Forbidden</h1>
Script asset "${resolve(__dirname + '/assets/403.html')}" is missing`
const ROUTES_FILE = routesPath ? fs.readFileSync(routesPath).toString() : ''
const ROUTES_TEMPLATE_PATH = resolve(__dirname + '/assets/routes')
const ROUTES_TEMPLATE = fs.existsSync(ROUTES_TEMPLATE_PATH)
	? fs.readFileSync(ROUTES_TEMPLATE_PATH)
	: `# Script asset "${resolve(__dirname + '/assets/routes')}" is missing`

if (argv.i) {
	fs.writeFileSync('./.500.html', ERROR_PAGE)
	fs.writeFileSync('./.404.html', NOT_FOUND_PAGE)
	fs.writeFileSync('./.403.html', FORBIDDEN_PAGE)
	fs.writeFileSync('./.routes', ROUTES_TEMPLATE)

	process.exit()
}

//? #################################
//? ############# ROUTES ############
//? #################################

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

//? #################################
//? ############ UTILITY ############
//? #################################

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

//? #################################
//? ############# LOGGER ############
//? #################################

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

const reqLog = (req: IncomingMessage, res: Response) => { //? Logger
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

//? #################################
//? ############# SERVER ############
//? #################################

const exStatic = serv('./', {
	dotfiles: DOTFILES,
	etag: ETAG,
	extensions: EXTENSIONS,
	index: INDEX,
	maxAge: MAX_AGE,
	logger: (req, res) => reqLog(req, res as Response),
})

const genHandler: RequestListener = (req, res) => { //? General handler
	const reqPath = getPath(req.url!)
	let path = decodeURI(reqPath)
	if (req.method !== 'GET') return notFoundHandler(req, res)
	if (reqPath.startsWith('//')) {
		res.locals.fs = true
		path = path.slice(1)
		return fileHandler(req, res)
	}

	let [redir, newPath] = route(encodeURI(path))
	req.url = newPath + req.url!.split('?').splice(1).join('?')

	if (redir) return res.log().redirect(req.url)

	const nx: NextFunc = (err) => {
		if (err) {
			res.locals.err = err
			errorHandler(req, res)
		}
		else fileHandler(req, res)
	}

	exStatic(req, res, nx)
}

const fileHandler: RequestListener = async (req, res) => { //? File handler
	if (res.statusCode === 403) return forbiddenHandler(req, res)
	if (res.statusCode === 404) res.status(200)
	else if (res.statusCode < 200 && res.statusCode >= 300) throw new Error('Unhandled status code appeared', { cause: res.statusCode })

	const path = decodeURI(getPath(req.url!))
	if (path === '/favicon.ico') {
		const faviconPath = resolve(__dirname + '/assets/favicon.ico')

		if (fs.existsSync(faviconPath)) {
			const stats = fs.statSync(faviconPath)

			res.cacheControl(MAX_AGE)
			res.typeLen('image/x-icon', stats.size).log()
			if (ETAG && res.etag(stats).matchEtag()) return

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

				res.send('text/html', `<!DOCTYPE html>${LIST_STYLE}<table>${LIST_HEADER}${up}${list}</table>`)
			},
			json() { res.send('application/json', JSON.stringify(flist)) },
			text() { res.send('text/plain', flist.join()) }
		})
	}

	return notFoundHandler(req, res)
}

const notFoundHandler: RequestListener = (req, res) => { //? Not Found handler
	res
	.cacheControl(MAX_AGE)
	.status(404).format({
		html() { res.send('text/html', NOT_FOUND_PAGE) },
		json() { res.send('application/json', '{"error":"Not Found"}') },
		text() { res.send('text/plain', 'Not Found') }
	})
}

const forbiddenHandler: RequestListener = (req, res) => { //? Forbidden handler
	res
	.cacheControl(MAX_AGE)
	.status(403).format({
		html() { res.send('text/html', FORBIDDEN_PAGE) },
		json() { res.send('application/json', '{"error":"Forbidden"}') },
		text() { res.send('text/plain', 'Forbidden') }
	})
}

const errorHandler: RequestListener = (req, res) => { //? Error handler
	const err = res.locals.err
	const errMsg = `We got some error here [${req.method} ${decodeURI(req.url!)}]:\n${err.stack}`
	console.error(errMsg)

	latestLogs.push(...errMsg.split('\n').map(v => v.length))

	movePendingRequests(errMsg.split('\n').length)

	res
	.cacheControl(MAX_AGE)
	.status(500).format({
		html() { res.send('text/html', ERROR_PAGE) },
		json() { res.send('application/json', '{"error":"Internal Server Error"}') },
		text() { res.send('text/plain', 'Internal Server Error') }
	})
}

const ex = createServer((req, res) => {
	const resp = res as Response
	resp.locals = {}
	resp.log = () => reqLog(req, resp)
	resp.typeLen = (type, len) => resp
		.setHeader('Content-Type', type)
		.setHeader('Content-Length', len)
	resp.send = (type, body) => resp
		.typeLen(type, body.length)
		.log()
		.end(body)
	resp.status = (code) => {
		resp.statusCode = code
		return resp
	}
	resp.format = (map) => {
		const mimeTypes = Object.keys(map)
		let acceptType = accepts(req).type(mimeTypes)

		if (!acceptType) {
			const body = JSON.stringify({
				code: 'UnsupportedType',
				message: 'Only attached content types are supported.',
				types: mimeTypes
			})

			return resp.status(406).send('application/json', body)
		}
		acceptType = typeof acceptType === 'string' ? acceptType : acceptType[0]

		map[acceptType]()

		return resp
	}
	resp.redirect = (location) => resp.writeHead(302, { location }).end()
	resp.cacheControl = (maxAge) => resp.setHeader('Cache-Control', `public, max-age=${maxAge}`)
	resp.etag = (stats) => {
		const etagValue = etag(stats)
		resp.setHeader('ETag', etagValue)
		return resp
	}
	resp.matchEtag = () => {
		const etagValue = resp.getHeader('Etag')
		if (etagValue === undefined) throw new Error("'Etag' header must be set before matching")
		if (resp.req.headers['if-none-match'] === etagValue) return !!resp.writeHead(304).end()
	}

	resp.setHeader('X-Powered-By', 'urobbyu/serve')
	genHandler(req, resp)
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
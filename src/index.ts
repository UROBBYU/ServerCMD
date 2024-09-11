#!/usr/bin/env node

import net = require('node:net')
import express = require('express')
import open = require('open')
import fs = require('node:fs')
import fsp = require('node:fs/promises')
const { resolve, join } = require('node:path')
import yargs = require('yargs/yargs')

//? #################################
//? ############# YARGS #############
//? #################################

const argv = yargs(process.argv.splice(2))

.scriptName('serve')
.usage('$0 [options...]')
.alias('h', 'help')
.alias('v', 'version')
.epilogue('You can add "//" to the start of URL path to force directory list instead of "index.html" fallback. Example: "http://example.com//file/path/".')
.detectLocale(false)
.strict(true)

.options({
	p: {
		alias: 'port',
		desc: 'Server port',
		type: 'number',
		default: 80
	},
	o: {
		alias: 'open',
		desc: 'Open in browser',
		type: 'boolean',
		default: false
	},
	i: {
		alias: 'init',
		desc: 'Init serve project',
		type: 'boolean',
		default: false
	},
	x: {
		alias: 'extensions',
		desc: 'File extension fallbacks: If a file is not found, search for files with the specified extensions',
		type: 'string',
		array: true,
		default: ['html', 'htm']
	},
	e: {
		alias: 'err-page',
		desc: 'Path to the file that server will respond with if an Internal Server Error occurs. Priority: arg > ./.500.html > SCRIPT_DIR/assets/500.html',
		type: 'string',
		default: './.500.html'
	},
	n: {
		alias: 'not-found-page',
		desc: 'Path to the file that server will respond with if requested path is not found. Priority: arg > ./.404.html > SCRIPT_DIR/assets/404.html',
		type: 'string',
		default: './.404.html'
	},
	r: {
		alias: 'routes',
		desc: 'Path to routes map. Priority: arg > ./.routes',
		type: 'string',
		default: './.routes'
	}
})
.check((argv) => {
	if (!Number.isInteger(argv.p))
		throw new Error('Port must be an integer')

	if (argv.p < 0 || argv.p > 65535)
		throw new Error('Port must be in range [0-65535]')

	if (argv.x.some(v => typeof v !== 'string'))
		throw new Error('File extensions must be strings')

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
} else console.log(errorPath)

process.stdout.write('Routes list: ')

let routesPath = argv.r
if (!fs.existsSync(routesPath)) {
	routesPath = ''
	console.log('not found')
} else console.log('found')

const OPEN_IN_BROWSER = argv.o
const EXTENSION_FALLBACKS = argv.x
const ERROR_PAGE = errorPath ? fs.readFileSync(errorPath)
	: `<h1>500 | Internal Server Error</h1>
Script asset "${resolve(__dirname + '/assets/500.html')}" is missing`
const NOT_FOUND_PAGE = nfPath ? fs.readFileSync(nfPath)
	: `<h1>404 | File Not Found</h1>
Script asset "${resolve(__dirname + '/assets/404.html')}" is missing`
const ROUTES_FILE = routesPath ? fs.readFileSync(routesPath).toString() : ''
const ROUTES_TEMPLATE_PATH = resolve(__dirname + '/assets/routes')
const ROUTES_TEMPLATE = fs.existsSync(ROUTES_TEMPLATE_PATH)
	? fs.readFileSync(ROUTES_TEMPLATE_PATH)
	: `# Script asset "${resolve(__dirname + '/assets/routes')}" is missing`

if (argv.i) {
	fs.writeFileSync('./.500.html', ERROR_PAGE)
	fs.writeFileSync('./.400.html', NOT_FOUND_PAGE)
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
	const client = net.createConnection({port}, () => {
		client.destroy()
		res(false)
	}).once('error', (err: NodeJS.ErrnoException) => {
		client.destroy()
		if (err.code === 'ECONNREFUSED') res(true)
		else rej(err)
	})
})

const ETX = Buffer.of(3)
const EOT = Buffer.of(4)
const LOG1024 = Math.log(1024)
const LSYMS = ['_/‾', '/‾\\', '‾\\_', '\\_/']
const LIST_STYLE = '<style>table{border-spacing:2em .5em}' +
	'body{font-family:monospace;font-size:1.5em;color:#fff;background-color:#222231;white-space-collapse:preserve}' +
	'a{font-weight:bold;color:#54cbc0}a:not(:hover){text-decoration:none}' +
	'td:nth-child(n+2){text-align:right;text-wrap:nowrap}</style>'
const LIST_HEADER = '<tr><th>Name</th><th>Date modified</th><th>Size</th></tr>'

const pendingRequests: Map<express.Request, [number, number]> = new Map()
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

//? #################################
//? ############# SERVER ############
//? #################################

const exStatic = express.static('./', {
	extensions: EXTENSION_FALLBACKS
})

const ex = express()

.use((req, res, next) => { //? Logger
	const h = req.socket.remoteAddress ?? '-'
	const r = `${req.method} ${req.path} ${req.protocol.toUpperCase()}/${req.httpVersion}`
	const b = res.get('Content-Length') ?? '-'
	const ref = req.get('Referer') ?? '-'
	const ua = req.get('User-Agent') ?? '-'

	const line = `[${new Date().toISOString()}] ${h} - - "${r}" ${b} "${ref}" "${ua}" ---`

	latestLogs.push(line.length)

	console.log(line)

	movePendingRequests(1)
	pendingRequests.set(req, [line.length - 3, 1])

	res.once('close', () => {
		const d = pendingRequests.get(req) as [number, number]
		pendingRequests.delete(req)

		updateStatus(`${res.statusCode}`, d)

		const maxY = [...pendingRequests.values()].reduce((t, [_, y]) => Math.max(y, t), 0)
		latestLogs.splice(0, latestLogs.length - maxY)
	})

	next()
})

.use('/', (req, res, next) => { //? General handler
	let path = decodeURI(req.path)
	if (req.path.startsWith('//')) {
		res.locals.fs = true
		path = path.slice(1)
		return next()
	}

	let [redir, newPath] = route(encodeURI(path))
	req.url = newPath + req.originalUrl.split('?').splice(1).join('?')

	if (redir) return res.redirect(req.url)

	if (newPath.includes('/.')) return next()

	exStatic(req, res, next)
})

.use(async (req, res, next) => { //? File handler
	const path = decodeURI(req.path)
	if (path === '/favicon.ico') {
		const faviconPath = resolve(__dirname + '/assets/favicon.ico')
		if (fs.existsSync(faviconPath)) return fs.createReadStream(faviconPath).pipe(res)
	}

	const fpath = resolve(`.${decodeURI(path)}`)
	if (path.endsWith('/') && !path.includes('/.') && fs.existsSync(fpath)) {
		const plist = (await fsp.readdir(fpath)).filter(p => !p.startsWith('.'))

		const flist = (await Promise.all(plist.map(f => fsp.stat(join(fpath, f)))))
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

				res.send(`<!DOCTYPE html>${LIST_STYLE}<table>${LIST_HEADER}${up}${list}</table>`)
			},

			json() {
				res.json(flist)
			},

			text() {
				res.send(flist.join())
			}
		})
	}

	return next()
})

.use((_, res) => res.status(404).format({ //? "Not Found" handler
		html() {
			res.send(NOT_FOUND_PAGE)
		},

		json() {
			res.json({ error: 'Not Found' })
		},

		text() {
			res.send('Not Found')
		}
	})
)

.use(((err, req, res, _) => { //? Error handler
	const errMsg = `We got some error here [${req.method} ${decodeURI(req.originalUrl)}]:\n${err.stack}`
	console.error(errMsg)

	latestLogs.push(...errMsg.split('\n').map(v => v.length))

	movePendingRequests(errMsg.split('\n').length)

	res.status(500).format({
		html() {
			res.send(ERROR_PAGE)
		},

		json() {
			res.json({ error: 'Internal Server Error' })
		},

		text() {
			res.send('Internal Server Error')
		}
	})
}) as express.ErrorRequestHandler)

let PORT = argv.p
isPortFree(PORT).then(isFree => {
	if (!isFree) {
		console.error(`Port ${PORT} is already in use. Switching to random free port.`)
		PORT = 0
	}

	const server = ex.listen(PORT, () => {
		const port = (server.address() as net.SocketAddress).port
		console.log(`http://localhost:${port} is listening.\nTo stop press CTRL+C...`)
		if (OPEN_IN_BROWSER) open(`http://localhost:${port}`)

		process.stdin.setRawMode(true)
		process.stdin.on('data', data => {
			if (data.equals(ETX) || data.equals(EOT)) process.exit()
		})
	})
})
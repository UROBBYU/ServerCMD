import * as fs from 'node:fs'
import * as http from 'node:http'
import { lookup } from './mime'
import { join } from 'node:path'
import { type CustomResponse } from '.'
import { Readable } from 'node:stream'

type Range = [start: number, end: number]

export type NextFunc = (err?: Error | StaticError) => void

export type StaticRequestHandler = (req: http.IncomingMessage, res: CustomResponse, next: NextFunc) => void

export type StaticOptions = {
	fallthrough?: boolean
	dotfiles?: 'allow' | 'deny' | 'ignore'
	extensions?: false | string[]
	index?: false | string
	maxAge?: number
	redirect?: boolean
}

export class StaticError extends Error {
	code: number

	constructor(code: number) {
		super(http.STATUS_CODES[code] || 'Unknown Error')

		this.code = code
		this.stack = ''
	}

	get [Symbol.toPrimitive]() {
		return (hint: string) => {
			if (hint == 'string') return this.message
			return super.toString()
		}
	}
}

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890'
const genID = (length: number) => Array.from({ length }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('')

const numLen = (n: number) => Math.floor(Math.log10(n || 1) + 1)

async function* genMultipart(type: string, path: fs.PathLike, boundary: string, size: number, ranges: Range[]) {
	const delimiter = `\r\n--${boundary}\r\n`
	const closeDelimiter = `\r\n--${boundary}--\r\n`

	for (const [start, end] of ranges) {
		yield `${delimiter}Content-Type: ${type}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`
		for await (const chunk of fs.createReadStream(path, { start, end }))
			yield chunk
	}
	yield closeDelimiter
}

export default (root = './', options?: StaticOptions): StaticRequestHandler => {
	const FALLTHROUGH = options?.fallthrough ?? true
	const DOTFILES = options?.dotfiles ?? 'ignore'
	const EXTENSIONS = options?.extensions ?? false
	if (EXTENSIONS && EXTENSIONS.some(v => /\/|\\/.test(v))) throw new Error('Extension path traversal is not allowed')
	const INDEX = options?.index ?? 'index.html'
	const MAX_AGE = options?.maxAge ?? 0
	const REDIRECT = options?.redirect ?? true

	return (req, res, next) => {
		try {
			let path = `.${req.url}`

			const isFileFound = (path: string) => fs.existsSync(join(root, path))
			const isDir = (path: string) => fs.statSync(join(root, path)).isDirectory()

			if (path.includes('/.')) {
				if (DOTFILES == 'deny') throw new StaticError(403)
				if (DOTFILES == 'ignore') throw new StaticError(404)
			}

			const resp = (path: string): boolean => {
				path = join(root, path)

				if (!isFileFound(path)) return false

				const stats = fs.statSync(path)
				const type = lookup(path)

				res
				.acceptRanges(true)
				.cacheControl(MAX_AGE)

				range: if (req.headers.range && /^\s*bytes\s*=\s*\d*-\d*(\s*,\s*\d*-\d*)*\s*$/.test(req.headers.range)) {
					const ranges = req.headers.range.split('=', 2)[1].split(',').map(range => range.split('-').map(num => parseInt(num)))

					for (const [start, end] of ranges) {
						if (isNaN(start) && isNaN(end)) break range
						if (start > end || end >= stats.size || start >= stats.size) {
							res.setHeader('Content-Range', `bytes */${stats.size}`)

							throw new StaticError(416)
						}
					}

					const byteRanges = ranges.map<Range>(([start, end]) => {
						if (isNaN(start)) return [stats.size - end, stats.size - 1]
						if (isNaN(end)) return [start, stats.size - 1]
						return [start, end]
					})

					const boundary = genID(16)
					const sizeLen = numLen(stats.size)
					const bodyLen = byteRanges.reduce((t, [start, end]) => t + 66 + type.length + numLen(start) + numLen(end) + sizeLen + (end - start), 24)

					if (res.checkConditionals(stats)) return true
					if (res.checkRange(stats)) {
						res.typeLen(type, stats.size).status(200)

						if (req.method === 'HEAD') return Boolean(res.end())

						fs.createReadStream(path).pipe(res)
						return true
					}

					res.typeLen(`multipart/byteranges; boundary=${boundary}`, bodyLen).status(206)

					if (byteRanges.length === 1) {
						const [start, end] = byteRanges[0]

						res
						.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`)
						.typeLen(type, end - start + 1)

						if (req.method === 'HEAD') return Boolean(res.end())

						fs.createReadStream(path, { start, end }).pipe(res)

						return true
					}

					if (req.method === 'HEAD') return Boolean(res.end())

					Readable.from(genMultipart(type, path, genID(16), stats.size, byteRanges)).pipe(res)

					return true
				}

				if (res.checkConditionals(stats)) return true

				res.typeLen(type, stats.size)

				if (req.method === 'HEAD') return Boolean(res.end())

				fs.createReadStream(path).pipe(res)

				return true
			}

			if (isFileFound(path)) {
				let dir = isDir(path)

				if (dir && REDIRECT && !path.endsWith('/')) path += '/'

				if (dir && INDEX) {
					const newPath = path + INDEX
					if (isFileFound(newPath)) path = newPath
					dir = isDir(path)
				}

				if (!dir && resp(path)) return
			}
			else if (EXTENSIONS) {
				for (const ext of EXTENSIONS) {
					if (resp(`${path}.${ext}`)) return
				}
			}

			throw new StaticError(404)
		} catch (err) {
			if (err instanceof StaticError) {
				if (FALLTHROUGH) {
					res.status(err.code)
					next()
				}
				else next(err)
			}
			else throw err
		}
	}
}
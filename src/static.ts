import * as fs from 'node:fs'
import * as http from 'node:http'
import { lookup } from './mime'
import { join } from 'node:path'
import { Response } from '.'

export type NextFunc = (err?: Error | StaticError) => void

export type StaticRequestHandler = (req: http.IncomingMessage, res: Response, next: NextFunc) => void

export type StaticOptions = {
	fallthrough?: boolean
	dotfiles?: 'allow' | 'deny' | 'ignore'
	etag?: boolean
	extensions?: false | string[]
	index?: false | string
	maxAge?: number
	redirect?: boolean
	logger?: http.RequestListener
}

export class StaticError extends Error {
	code: number

	constructor(code: number, msg: string) {
		super(msg)

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

export default (root = './', options?: StaticOptions): StaticRequestHandler => {
	const FALLTHROUGH = options?.fallthrough ?? true
	const DOTFILES = options?.dotfiles ?? 'ignore'
	const ETAG = options?.etag ?? true
	const EXTENSIONS = options?.extensions ?? false
	if (EXTENSIONS && EXTENSIONS.some(v => /\/|\\/.test(v))) throw new Error('Extension path traversal is not allowed')
	const INDEX = options?.index ?? 'index.html'
	const MAX_AGE = options?.maxAge ?? 0
	const REDIRECT = options?.redirect ?? true
	const logger = options?.logger ?? (() => {})

	return (req, res, next) => {
		try {
			let path = `.${req.url}`

			const isFileFound = (path: string) => fs.existsSync(join(root, path))
			const isDir = (path: string) => fs.statSync(join(root, path)).isDirectory()

			if (path.includes('/.')) {
				if (DOTFILES == 'deny') throw new StaticError(403, 'denied')
				if (DOTFILES == 'ignore') throw new StaticError(404, 'not found')
			}

			const resp = (path: string): boolean => {
				path = join(root, path)

				if (!isFileFound(path)) return false

				const stats = fs.statSync(path)

				res
				.cacheControl(MAX_AGE)
				.typeLen(lookup(path), stats.size)
				logger(req, res)
				if (ETAG && res.etag(stats).matchEtag()) return true

				return !!fs.createReadStream(path).pipe(res)
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

			throw new StaticError(404, 'not found')
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
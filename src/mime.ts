import mimeDB from 'mime-db'

type MimeDB = Map<string, string> & {
	lookup: (path: string, fallback?: string) => string
}

const db = new Map() as MimeDB
Object.entries(mimeDB).forEach(([name, ent]) => {
	if (ent.extensions) {
		ent.extensions.forEach(ext => {
			const oldName = db.get(ext)
			if (!oldName || (mimeDB[oldName].source !== 'apache'))
				db.set(ext, name)
		})
	}
})

export const lookup = db.lookup = (path: string, fallback?: string) => {
	const ext = path.replace(/^.*[\.\/\\]/, '').toLowerCase()
	return db.get(ext) ?? fallback ?? 'application/octet-stream'
}

export default db
import { safeStem } from './document-filename.mjs'

// Generate a single portable ZIP entry per row, preserving useful references such as leading zeroes.
export function batchFilenames(basenames, format) {
  const stems = basenames.map(name => safeStem(name, 220))
  const key = (name) => name.toLowerCase().normalize('NFC')
  const reserved = new Set(stems.map(key))
  const seen = new Set()
  return stems.map(stem => {
    let name = stem
    if (seen.has(key(name))) {
      let suffix = 2
      do { name = stem + ' (' + suffix++ + ')' } while (reserved.has(key(name)) || seen.has(key(name)))
    }
    seen.add(key(name))
    return name + '.' + format.toLowerCase()
  })
}

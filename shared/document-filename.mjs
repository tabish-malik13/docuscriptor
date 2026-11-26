export function safeStem(value, maxBytes) {
  let stem = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, '_')
    .trim().replace(/^[. ]+|[. ]+$/g, '')
  if (!stem) stem = 'Document'
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = '_' + stem
  // Truncate on a character boundary so the filename is valid UTF-8.
  const encoder = new TextEncoder()
  let result = '', bytes = 0
  for (const char of stem) {
    const length = encoder.encode(char).length
    if (bytes + length > maxBytes) break
    result += char
    bytes += length
  }
  return result.replace(/[. ]+$/, '')
}

export function documentFilename(source, format) {
  const suffix = format === 'PDF' ? /\.(?:docx|html?)$/i : /\.docx$/i
  return safeStem(source.replace(suffix, ''), 200) + '.' + format.toLowerCase()
}

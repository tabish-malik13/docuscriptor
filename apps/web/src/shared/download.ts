export function download(artifact: Blob, name: string) {
  const url = URL.createObjectURL(artifact)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// The hosted Pages build disables server processing. Self-hosted services retain their code.
export const processingEnabled = import.meta.env.VITE_PROCESSING_ENABLED !== 'false'

export const cloudFilesEnabled = import.meta.env.VITE_CLOUD_FILES_ENABLED === 'true'

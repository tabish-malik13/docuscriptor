import { createHash, randomUUID } from 'node:crypto'
import { problem } from '../../shared/problems.mjs'
import { Buffer } from 'node:buffer'
import { docxType, pdfType, readArtifact } from '../shared/document-http.mjs'

const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex')
const job = (row) => ({ id: row.id, createdBy: row.created_by, name: row.name, kind: row.kind, source: row.source, when: row.created_at,
  status: row.status === 'deleting' || (row.status === 'processing' && new Date(row.expires_at).getTime() <= Date.now()) ? 'failed' : row.status,
  error: row.status === 'deleting' ? 'Deletion was interrupted. Delete this record again to finish.' : row.error || (row.status === 'processing' && new Date(row.expires_at).getTime() <= Date.now() ? 'Processing was interrupted. Submit the document again.' : null) })
const template = (row) => ({ id: row.id, name: row.name, fields: row.fields, created: row.created_at, createdBy: row.created_by, saved: true })

export function createSupabaseStore({
  supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = fetch,
} = {}) {
  if (!supabaseUrl || !publishableKey) throw new Error('Configure Supabase before enabling cloud document storage.')
  const origin = new URL(supabaseUrl).origin
  async function request(token, path, { method = 'GET', body, binary, type } = {}) {
    let response
    try {
      response = await fetchImpl(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { apikey: publishableKey, Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': type || 'application/json' }),
          ...(binary ? { 'x-upsert': 'false', 'cache-control': 'max-age=0' } : {}) },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      })
    } catch { throw problem(503, 'Cloud document storage is temporarily unavailable. Please retry.') }
    if (!response.ok) {
      const result = await response.json().catch(() => null)
      if (['PGRST202','PGRST205','42P01','42883'].includes(result?.code)) throw problem(503, 'Apply the Supabase document storage migration before using the workspace.')
      if (response.status === 401) throw problem(401, 'Your session is invalid or expired.')
      if (response.status === 403 || result?.code === '42501') throw problem(403, 'Your organization permissions do not allow this storage operation.')
      if (response.status === 404) throw problem(404, 'Stored document not found.')
      if (result?.code === '23514') throw problem(409, ['Free storage budget reached','Organization storage limit reached','Organization record limit reached','Wait for processing to finish','File deletion is not complete','Document reservation expired'].includes(result.message) ? result.message + '.' : 'The document could not be saved within its storage reservation.')
      if (response.status === 409 || result?.error === 'Duplicate' || result?.code === 'Duplicate' || result?.statusCode === '409') throw problem(409, 'A file already exists at this document address.')
      throw problem(503, 'Cloud document storage could not complete the request.')
    }
    return response
  }
  function scope(identity) {
    const { accessToken: token, tenantId, subject } = identity
    if (!token || !tenantId || !subject) throw problem(401, 'Verified organization access is required for cloud storage.')
    const rpc = async (action, data) => (await request(token, '/rest/v1/rpc/ds_document_command', { method: 'POST', body: { p_tenant_id: tenantId, p_action: action, p_data: data } })).json()
    const rows = async (filter) => (await request(token, '/rest/v1/ds_documents?select=*&tenant_id=eq.' + tenantId + '&' + filter)).json()
    const row = async (type, id) => (await rows('record_type=eq.' + type + '&id=eq.' + id + '&limit=1'))[0]
    const download = async (record) => {
      const bytes = await readArtifact(await request(token, '/storage/v1/object/authenticated/ds-documents/' + record.object_key))
      if (record.sha256 && checksum(bytes) !== record.sha256) throw problem(502, 'The stored document checksum does not match. The file was not returned.')
      return bytes
    }
    const upload = async (record, bytes) => {
      try { await (await request(token, '/storage/v1/object/ds-documents/' + record.object_key, { method: 'POST', body: bytes, binary: true, type: record.kind === 'PDF' ? pdfType : docxType })).body?.cancel() }
      catch (error) {
        // A retry after a lost response must never overwrite an unrelated file.
        if (error.statusCode !== 409 || checksum(await download(record)) !== checksum(bytes)) throw error
      }
    }
    const complete = async (record, bytes) => {
      await upload(record, bytes)
      return rpc('complete', { id: record.id, size: bytes.length, sha256: checksum(bytes) })
    }
    const remove = async (type, id) => {
      const record = await row(type, id)
      if (!record) return false
      await rpc('begin_delete', { id })
      // Storage's delete API enforces RLS and safely accepts an already absent object.
      await (await request(token, '/storage/v1/object/ds-documents', { method: 'DELETE', body: { prefixes: [record.object_key] } })).body?.cancel()
      await rpc('finish_delete', { id })
      return true
    }
    return {
      async listJobs(_tenant, offset = 0) { return (await rows('record_type=eq.job&order=created_at.desc,id.desc&limit=50&offset=' + offset)).map(job) },
      async job(_tenant, id) { const record = await row('job',id); return record ? job(record) : undefined },
      async artifact(_tenant, id) { const record = await row('job',id); return record?.status === 'ready' ? { name: record.name, kind: record.kind, artifact: await download(record) } : undefined },
      async uploadFile(name, kind, bytes) {
        const record = await rpc('reserve_job', { id:randomUUID(), name,kind,source:'Uploaded document' })
        try { await complete(record,bytes); return job({ ...record,status:'ready',size_bytes:bytes.length }) }
        catch(error) { try { await rpc('fail',{id:record.id,error:'Upload did not finish. Delete this record and retry.'}) } catch {} throw error }
      },
      async beginJob(_tenant, metadata) { return (await rpc('reserve_job', { ...metadata, id: randomUUID() })).id },
      async completeJob(_tenant, id, bytes) { const record = await row('job',id); if (!record) throw problem(404, 'Document not found.'); await complete(record,bytes) },
      async failJob(_tenant, id, error) { await rpc('fail', { id,error }) },
      deleteJob: (_tenant,id) => remove('job',id),
      async listTemplates() { return (await rows('record_type=eq.template&order=created_at.desc,id.desc&limit=100')).filter((r) => r.status !== 'processing' || new Date(r.expires_at).getTime() <= Date.now()).map(template) },
      async template(_tenant, id) { const record = await row('template',id); return record?.status === 'ready' ? { ...template(record), file: await download(record) } : undefined },
      async saveTemplate(_tenant, name, fields, bytes) {
          const record = await rpc('reserve_template', { id: randomUUID(),name,fields,source:name,kind:'DOCX' })
        try { await complete(record,bytes); return template(record) }
        catch (error) { try { await rpc('fail', { id:record.id,error:'Template upload did not finish. Delete this record and retry.' }) } catch { /* Preserve the original failure; reservations remain charged. */ } throw error }
      },
      deleteTemplate: (_tenant,id) => remove('template',id),

    }
  }
  return {
    close() {},
    forRequest: (identity) => scope(identity),
    legacySummary: () => ({ jobs: 0, templates: 0 }),
    importLegacy() { throw problem(410, 'Local archive imports are not supported.') },
  }
}

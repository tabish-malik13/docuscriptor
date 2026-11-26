# Generate a named file for each roster row

## In the workspace

1. Open **Bulk generation** in the organization that should hold the finished documents. Owners, admins and operators can run a batch.
2. Choose **Certificate of completion** or a saved Word template. For a custom design, first save a DOCX with placeholders such as `{recipient_name}` under **Templates**. Select PDF or editable DOCX. PDF uses the deployment's private renderer.
3. Download the CSV headers for the selected template or export your spreadsheet as UTF-8 CSV. The certificate starter takes `recipient_name`, `course_name`, `completion_date`, `issuer_name` and `certificate_id`. Format identifiers as text in the spreadsheet so the export preserves leading zeros.
4. Upload the CSV, map each template field to a column, and review the first three output names and their values. The certificate starter defaults to PDF and uses the mapped certificate ID for filenames. Its five fields must be populated and its IDs must be unique within that roster. Other templates allow intentionally blank cells. Unsafe filename characters are replaced and name collisions receive suffixes.
5. For a new or revised design, choose **Generate first file for review** and open the first learner’s actual PDF or Word file. Check layout, spelling and identifier, then **Resume batch** to issue the remaining files. For a familiar template, select **Generate** to run the entire roster. Keep the page open while it submits rows. You can pause or leave, then open **Your batch history** to resume pending rows. A submitted row can finish after the page closes. If a row failed, inspect the error, correct its data and create another batch containing only the affected rows.
6. Download the ZIP or individual files. The ZIP contains the files currently available and the button shows their count. Check the ready, failed and pending counts before distributing a cohort. Staff can deliver the files using their existing LMS or other approved channel.

Each finished file also appears in organization **Activity**, where members with document access can read it. Batch history and queued rows belong to the submitting user or API client within that organization. Choose the workspace with the appropriate staff membership before uploading a roster.

Each batch keeps the saved template version it started with, including when you pause and resume after someone edits the template.

## From an integration

Obtain a bearer token with `documents:generate`. PDF also requires `documents:convert`. Add `templates:read` to create or advance a batch using a saved template. An integration can download its own batch without broad access to tenant history. [API client setup](client-api.md)

| Method and path | Behavior |
| --- | --- |
| `POST /api/batches` | Submit JSON with exactly one of `templateId` and `savedTemplateId`, a `format` of `PDF` or `DOCX`, and 1–100 rows. Returns HTTP 201 with the run ID, counters and ordered row metadata. |
| `GET /api/batches` | List the caller's retained runs in the current tenant. |
| `GET /api/batches/:id` | Read counters and row status, filename, job ID, error, availability and byte count. Row numbers start at 1. |
| `POST /api/batches/:id/next` | Claim and process one pending row, then return updated detail. At most one row per run can be in flight. Add `?row=N` to advance a specific 1-based row in order. Replaying an already started row returns its run state without advancing another row. |
| `GET /api/batches/:id/download` | Download a ZIP of available files. The response includes `X-Batch-File-Count` and `X-Batch-Omitted-Count`. An empty archive or more than 32 MiB of artifact bytes returns 409. Use `GET /api/jobs/:jobId/download` for individual files. |
| `DELETE /api/batches/:id` | Remove the batch and remaining queued inputs. Generated files stay in Activity. An active row must finish first. |

For example, a certificate creation request has this shape. Supply the real roster values at runtime.

```json
{
  "templateId": "certificate",
  "format": "PDF",
  "rows": [
    {
      "name": "00042",
      "values": {
        "recipient_name": "<recipient name>",
        "course_name": "<course title>",
        "completion_date": "<completion date>",
        "issuer_name": "<issuing organization>",
        "certificate_id": "00042"
      }
    }
  ]
}
```

Send a newly generated UUID in the `Idempotency-Key` header for each new run. Retry an uncertain creation with the same key and inputs to recover the run ID. A different payload under the same key returns 409. The key is scoped to the caller, tenant and retained run. Save the run ID and call `/next?row=N` sequentially for pending rows. To review a proof, advance row 1, download its artifact by job ID and resume at row 2 after approval. Honor `Retry-After` on admission limits. If an advance times out or reports an active row, fetch the run and wait for its processing count to reach zero before advancing. Inspect failed rows separately. Reacquire an expired access token for the same client before resuming.

## Limits and retention

The browser accepts UTF-8 CSV up to 2 MiB. The mapped JSON request also has a 2 MiB limit. Fields accept up to 4,000 characters. A generated Word file going into PDF conversion must fit the 4 MiB input limit. Each finished file has a 16 MiB limit. The existing tenant processing, job and storage quotas apply to every row. A tenant can retain up to 100 batches.

For recovery, SQLite stores mapped input values while their rows are pending or processing. Values count toward tenant storage and are cleared when the row finishes or fails. A gateway restart marks an interrupted row failed and preserves other pending rows. Batch records, including abandoned inputs, expire 30 days after creation. Cleanup runs on startup and about once a minute while the gateway is running, allowing an active row to finish. Activity files remain subject to normal job deletion and backup policies.

# A first market for DocuScripter

**Decision, 26 November 2026.** Start with training operations teams that issue completion certificates from an existing Word design and a roster exported from their learning management system. Target teams with recurring cohorts of 20–100 learners and an actual reason to run document processing on their own infrastructure. The operator gets an individually named PDF for each learner, ready to upload to the organization's existing delivery system.

## What the market shows

| Evidence | Implication for DocuScripter |
| --- | --- |
| A Word user could already merge Excel data into letters but needed each result saved separately under its spreadsheet reference and, ideally, as a PDF. This is a first-hand account from 2017. [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/4938949/how-do-i-split-out-a-mail-merge-into-separate-docu) | Preserve leading zeros, preview filenames and produce one downloadable file per row. Measure the time spent checking and renaming outputs. |
| DocuGenerate includes API access on its free single-document tier. Its paid Plus tier includes batch generation and 500 documents per month. Its Premium tier adds template version history. [DocuGenerate pricing](https://www.docugenerate.com/pricing/) | Buyers already have inexpensive rendering APIs. Give an operations user a complete repeatable task. Version history is a candidate for teams with multiple template editors. |
| Plumsail shipped CSV and Excel imports with column mapping and identifies student certificates as a use case. [Plumsail release announcement](https://community.plumsail.com/t/documents-edit-templates-on-desktop-and-bulk-start-processes-from-csv-or-excel/16395) | Accept the organization's existing column names. CSV supports an initial pilot with common LMS exports. |
| Temvro markets this exact certificate workflow, including individual PDFs and a ZIP. It lists 50 documents per month free and 10,000 per month at US$20 on its monthly Team plan. [Temvro training certificates](https://temvro.com/solutions/training-certificates) | Per-document pricing faces strong competition. Test whether buyers value deployment control, bringing their Word design, and an API for later automation enough to pay for setup and support. |
| PandaDoc places version history and approval workflows on Business and Enterprise tiers and offers recipient verification as an add-on. [PandaDoc plan comparison](https://support.pandadoc.com/en/articles/9715033-compare-subscription-plan-features) | Governance and signing have established vendors. Pursue these when a specific buyer identifies the purchase blocker and the person who owns its budget. |

These are published offers and workflow reports. Their prices establish alternatives a prospect can choose. Customer demand, retention and willingness to pay for DocuScripter still require direct validation.

## What was missing

The workspace already supported private DOCX generation, DOCX-to-PDF conversion, reusable tenant templates and scoped APIs. Issuing a class set meant filling the template repeatedly or writing an integration to map columns, name files, track failures and collect results. The new **Bulk generation** workflow covers those steps and includes a certificate starter. An operator can reuse a branded Word template with simple text placeholders, generate the first learner’s actual file for review, and continue the same roster after checking its layout. [Operator and API guide](bulk-generation.md)

Prioritize the next gaps in the order below.

| Purchase blocker to listen for | Candidate response | Evidence to request |
| --- | --- | --- |
| Staff spend more time distributing files than generating them. | An unattended run with delivery into the buyer's LMS and a receipt for each result. | For two consecutive cohorts, observe who receives files, how staff reconcile deliveries and which system is authoritative. |
| An administrator cannot tell which approved template produced a document. | Immutable template revisions, publishing approval and an issuance record with an explicit retention policy. | Ask the template owner to show a recent correction, recall or audit request. |
| Learners or employers repeatedly contact staff to verify certificates. | Issuer-controlled verification with revocation and privacy controls. | Count verification requests and determine who can disclose a learner's status. |

A certificate ID is currently supplied by the issuer. The starter checks for duplicates within one uploaded roster. Long-term issuance records, public verification, individual learner delivery and an accreditation claim are outside the implemented workflow. Finished files are visible to organization members, so a pilot involving student records needs a workspace limited to authorized staff.

## What the implementation demonstrated

A local, authenticated 100-row Word run finished in 5 minutes 1 second, including five one-minute rate-limit waits. The gateway restarted after row 50. The completed ZIP contained 100 distinct files, and each filename, recipient and embedded ID matched its roster row. A separate browser run exercised first-file review and PDF generation with LibreOffice. The full-size run measured Word output under the default limits. PDF throughput and hands-on time with customers’ own templates remain pilot measurements.

## First paid pilot

Recruit **five training operations owners** who have already issued at least two cohorts. Ask each to show the last roster, the Word layout, the output naming rule and the person who approves spending. Use deidentified records for the first run. Record the baseline hands-on time to prepare, check, rename and collect the files.

Offer **US$99 once** to configure one existing template and support the first two cohorts on the customer's deployment. This is an optional service price to test. Discuss it before doing the setup and record whether a budget owner actually commits. The application itself can run without a subscription.

Advance if at least **three of five** teams can complete a roster without assistance, every inspected file matches its recipient and ID, and **two teams pay and use it for a second cohort within 30 days**. Record elapsed time and hands-on time separately. If operators succeed but buyers prefer the free alternatives, revisit the target segment and offer before adding more features. No interviews, purchases or retention measurements have been collected for this decision.

## Licensing for small teams and enterprise buyers

The platform can now sell one organization a Plus or Ultimate subscription through hosted checkout, or assign it a contract license after an invoice or purchase order is handled externally. Workspace owners can compare capacity and inspect actual usage. The initial tiers differ by storage, saved templates and retained jobs. Set prices in the merchant account after testing willingness to pay. [Billing setup and tier defaults](billing.md)

| Buyer question | Current gap | What to validate next |
| --- | --- | --- |
| “What will it cost to generate 10,000 documents per month?” | Retained history measures what the customer keeps. Deleting files frees capacity, so this measure cannot support per-document billing. Competitors publish generation allowances. [PDF Generator API plans](https://pdfgeneratorapi.com/pricing) · [DocuGenerate pricing](https://www.docugenerate.com/pricing/) | Collect monthly successful output counts with pilot customers. Test a volume-based quote against a flat organization price before implementing overages. |
| “How can our finance team get an invoice or change the subscription?” | Today the merchant handles invoice requests, changes and cancellation through the provider dashboard. | Observe a small business's first renewal. Prioritize owner-accessible invoice downloads, payment-method updates and cancellation if customers need support for those tasks. |
| “Can we sign off on this vendor and revoke access centrally?” | The workspace has organization roles and API credentials. Enterprise SSO, automated directory provisioning and contractual support commitments need separate delivery. PandaDoc lists SSO in its enterprise offering, and DocuGenerate offers SLA and procurement support. [PandaDoc plan comparison](https://support.pandadoc.com/en/articles/9715033-compare-subscription-plan-features) · [DocuGenerate pricing](https://www.docugenerate.com/pricing/) | Ask an enterprise prospect for its identity provider, onboarding checklist, required audit evidence and contract terms. Fund the requirement that blocks a named deal before advertising it under Ultimate. |

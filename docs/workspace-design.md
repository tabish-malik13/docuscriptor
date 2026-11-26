# Workspace interface design

The November 2026 redesign organizes DocuScripter around three daily tasks. An operator can start a document, reuse a template, or retrieve a finished file from Overview. The desktop sidebar keeps those destinations visible. On phones, the document tools remain on Overview and the full menu opens on demand. The blue accent marks navigation and actions, while document status has a text label.

[Desktop overview](images/workspace-desktop.png) · [Mobile overview](images/workspace-mobile.png). Both screenshots show the application in an isolated review workspace.

## Research behind the decisions

| What we found | Where it appears in DocuScripter |
| --- | --- |
| In a 179-participant study across six websites, people found content less often and completed desktop tasks more slowly when the main navigation was hidden. Apple recommends succinct groups and a shallow sidebar. [Original usability study](https://www.nngroup.com/articles/hamburger-menus/) · [Apple sidebar guidance](https://developer.apple.com/design/human-interface-guidelines/sidebars) | The desktop rail shows workspace destinations and document tools by name. Operators can also launch common tasks directly from Overview. On narrow screens the menu supports keyboard focus, Escape, and return to its opener. |
| Apple Pages lets people choose a document by recognizing its layout. [Pages template chooser](https://support.apple.com/en-gb/guide/pages/tan5c52a733c/mac) | The four starter thumbnails come from their actual Word files. The library opens a full-page preview, lists the required fields and lets operators start a document from that layout. Uploaded templates use a Word-file icon and their actual field metadata. |
| Jira exposes recent and starred items so users can return to the work that matters to them. [Jira navigation](https://support.atlassian.com/navigation/docs/what-is-the-new-navigation-in-jira/) | Pin a starter or saved template in Templates to bring it onto Overview. Pins are personal to the account and organization in this browser. The preference stores template IDs. |
| IBM Carbon locates search and filters next to the data table they control. [Carbon data tables](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines) | Activity offers name and status filters over the jobs loaded in the view. The mobile rows retain file format, date, status and download actions. |
| Microsoft Fluent recommends organizing navigation around the user's goals, with concise, descriptive labels. [Fluent navigation](https://fluent2.microsoft.design/components/web/react/core/nav/usage) | Viewers see the library, activity and the local editor. Operators also see generation and conversion. Administrators can move between people, API clients, access history and general settings. |

The color palette follows the requested light theme. These sources support specific interactions. Preference for this design among DocuScripter's customers still needs direct research.

## A customer test

Ask a first-time operator to preview a certificate, generate the first file from a roster and retrieve it. Ask a returning operator to pin a template and find it after reopening the workspace. Give an administrator the separate task of locating an API client's permissions. Observe first clicks, task completion, time spent searching and whether anyone selects the wrong organization. Use the results to decide which controls deserve greater prominence.

---
name: implement-devlog
description: Establish or reorganize repository devlog practices, including a development guide, agent instructions, technical-note migration, and screenshot evidence conventions. Use when asked to implement devlog organization or adapt it from another repository; ordinary feature work or a single log entry does not require this workflow.
---

# Implement devlog practices

Create a repository-specific home for contributor knowledge and verification
evidence, with `devlog/DEVELOPMENT.md` as its entry point. Implement the
organization and repair references, rather than only proposing a structure.

## Discover the destination and reference

Read applicable `AGENTS.md` files, inspect working-tree changes, and review the
destination's README variants, development documents, build/test configuration,
scripts, ignore rules, and screenshot workflows. Use the actual configuration
as evidence for commands and prerequisites; do not assume a language or stack.

When a reference repository is supplied, read its `AGENTS.md`, development
guide, and relevant devlog notes. Transfer its organizational practices, not
its application-specific commands, technical claims, images, or history. The
workflow below is self-contained when no reference is available.

Preserve existing edits, project conventions, document languages, and filename
styles. Merge into an existing development guide and agent instructions instead
of replacing them. Do not impose a second documentation system on a repository
with a deliberate equivalent unless the requested migration calls for it.

## Establish documentation ownership

Use these defaults, adapting them to the project's actual audience:

- **README variants:** what the product does and how people use it. Authoring, configuration, CLI usage, and public format documentation may belong here when they serve users, including developer users of a library or framework.
- **`devlog/`:** contributor build/test commands, coding conventions, architecture, implementation details, technical plans, integration notes, cleanup/audit findings, development logs, and verification evidence.
- **`docs/` or the existing published-docs directory:** published screenshots, examples, specifications, or documentation the product distributes. Do not relocate an established public documentation site merely because it contains technical material.
- **Existing production-input directories:** retain story drafts, character references, design sources, and other inputs in their established locations. Separate these from implementation reports by purpose.

Move contributor-only sections out of READMEs into the development guide and
replace them with a short relative link. Update existing language variants
together for changed shared guidance; do not create translations the project
does not otherwise maintain. Preserve user-facing technical references.

Move misplaced development notes into `devlog/` where appropriate. Search for
inbound references, including agent skills, scripts, and CI; update them and
repair relative links and images inside moved files. Preserve historical
content and evidence. Do not bulk-move ignored runtime output or rewrite old
dates merely to make the tree uniform.

## Write the development entry point

Keep `devlog/DEVELOPMENT.md` useful as a starting point, covering:

- Where documentation and artifacts belong, with links back to user documentation.
- Verified build, run, and test commands, supported configurations, prerequisites, and relevant environment assumptions. Distinguish preset/tooling requirements from lower-level build-system requirements.
- A concise map of important source, content, tooling, and test directories.
- Existing coding, localization, ownership, and dependency-boundary conventions grounded in the repository.
- Links to technical notes, plans, audits, and screenshot guidance that actually exist.

Split implementation history into one file per work date and topic under
`devlog/yyyy-mm-dd_<topic>.md`. Use a short lowercase topic with hyphens
between words, as in `devlog/2026-11-20_login-validation.md`. Add related
work on the same date to the matching file. When migrating a combined log,
split its dated sections by topic, keep each section's evidence with it, and
link the resulting files from the development guide.

Dated work reports should record the problem or change, its
reason, commands and results, evidence links, and remaining unverified behavior.
Keep historical validation distinct from checks performed for the current task.
Use the actual local work/capture date for new reports; retain original dates
on migrated reports. Do not create empty indexes, archives, or report templates
unless they are useful to the requested result.

## Integrate agent and artifact conventions

Extend the destination's `AGENTS.md` with concise instructions to:

- Read the development guide first for contributor work.
- Put durable technical knowledge and development artifacts in `devlog/` and link new notes from the guide.
- Record implementation work in `devlog/yyyy-mm-dd_<topic>.md`, one file per work date and topic.
- Keep user documentation focused on its audience and maintain existing language variants together.
- Follow the project's screenshot capture and archival guidance.

Preserve unrelated agent instructions. Keep detailed commands and procedures in
the guide rather than copying them into `AGENTS.md`.

Inspect scripts that write development logs into the root or build output.
Where a small, compatible change makes sense, create the destination directory
before writing and redirect those logs to `devlog/`. Verify ignore patterns
still exclude disposable logs while allowing intended reports and evidence.
Check consumers before changing a generated file's path. Avoid changing runtime
APIs, CLI contracts, or production-output destinations as part of this
documentation task; document existing paths and how to retain useful evidence.

## Adapt screenshot practices

Create or update `devlog/screenshots.md` when visual evidence is relevant.
Document the existing supported capture method. Prefer a repository capture
script when one exists; otherwise explain the actual app capture controls or
tools. Do not claim a reference project's script exists in the destination or
build an unrelated capture system just to match it.

For reproducible verification, record the executable/build, content or fixture,
scene/page/state, language, viewport/settings, necessary actions, and timing
when relevant. Inspect captured images before citing them. Store development
evidence in `devlog/` with descriptive dated filenames and relative report
links. Distinguish verification captures from selected published screenshots.

Archive replaced published images under
`devlog/screenshots-archive/<year>-<month>/` before replacement, preserving
language subfolders and avoiding filename collisions. Use the original capture
month when known; otherwise document use of the archival month. Create archive
and published-image directories only when needed. Preserve historical evidence
links. Keep translated screenshots aligned when visible language matters.

## Verify and deliver

Check local links and image paths in changed and moved documentation, including
anchors where changed. Exclude code fences and inline-code examples from link
validation. Search for stale old paths. Check the diff for accidental content
loss, whitespace problems, and unrelated changes. Include untracked new files
in the review; `git diff` alone does not show them.

Validate changed scripts through appropriate checks. Documentation-only edits
usually need no full application build; run relevant existing checks when
commands, paths, or behavior changed. Report exactly which checks ran, which
passed, and any limitations. Do not report inherited test counts as new results.

Finish with a concise list of the implemented conventions, links to the guide
and agent instructions, and validation results. Leave installation, commits,
publishing, and unrelated cleanup outside this workflow unless requested.

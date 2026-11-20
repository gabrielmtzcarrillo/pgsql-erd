# AGENTS.md

Notes for coding agents working in this repository.

## Documentation lives in two places

- **Coding conventions and development notes belong in [devlog/](devlog/).** Read
  [devlog/DEVELOPMENT.md](devlog/DEVELOPMENT.md) first: running and testing, coding conventions, the project layout,
  file formats ([devlog/pgerd-format.md](devlog/pgerd-format.md)), design notes and plans, and how the screenshots are
  taken ([devlog/screenshots.md](devlog/screenshots.md)). When you learn something technical worth keeping, or change
  a convention, write it there.
- **README.md and README-es.md are for people who use the app.** Keep them about what the app does and how to use
  it, and change both languages together. Do not add build steps, code structure or other technical detail to them;
  put it in `devlog/` and link to it if needed.
- **docs/** holds only what the app publishes: the README screenshots, the import template spec, its JSON Schema and
  the examples.

## Screenshots

Take README screenshots with `scripts/capture-screenshots.mjs`, not by hand, and move the images they replace to
`devlog/screenshots-archive/<year>-<month>/`.

<!-- skills-agentic:implement-devlog -->
## Devlog organization skill

When asked to establish or reorganize repository devlog practices, or adapt
them from a reference repository, read `.claude/skills/implement-devlog/SKILL.md` and follow its
workflow. Preserve project-specific instructions and user-facing documentation.
Ordinary feature work or a single development-log entry does not require the
full reorganization workflow.

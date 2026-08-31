# Documentation Guidelines

These instructions adapt the [DeepSeek Harness documentation standard](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md) to this repository. They apply to human-facing Markdown under `docs/`; repository-wide contributor rules remain in [the root guide](../AGENTS.md).

## Document Structure

Classify each page as a tutorial or reference before writing. A tutorial leads a reader from stated prerequisites to a verified outcome. A reference describes current behavior for lookup and does not narrate a learning sequence.

Each durable fact has one owning page. Other pages summarize only enough to orient the reader and link to that owner for detail.

| Tier | Owns | Excludes |
| --- | --- | --- |
| [Documentation index](README.md) | Navigation and one-line scope descriptions | Procedures and implementation detail |
| [Architecture](architecture.md) | Components, lifecycle, boundaries, and extension seams | CLI inventories and contributor setup |
| [Development](development.md) | Prerequisites, local workflow, tests, and documentation checks | Runtime design rationale |
| [Reference](reference/cli.md) | Exact options, environment variables, lookup order, and observable contracts | Step-by-step workflows |
| [Cookbooks](cookbook/package-windows.md) | Numbered procedures with explicit verification | Design rationale |
| [Decisions](decisions/README.md) | Architectural rationale, trade-offs, consequences, and required verification | Migration checklists and incident chronology |
| [Postmortems](postmortem/README.md) | Incident evidence, impact, causes, and corrective actions | General product documentation |

## Writing Rules

- Describe the current repository state. Put change history in commits, decision records, or postmortems.
- Keep one physical line per prose paragraph and rely on editor soft wrapping. Preserve normal formatting for tables, lists, and code blocks.
- Use direct language and exact names such as `HarnessRuntime`, `DSH_HOME`, `cargo test`, and `scripts/package.ps1`.
- Link repository files with relative Markdown links. Include a fragment when pointing to a specific section; do not use bare filenames as cross-references.
- Keep code examples runnable from the repository root unless the surrounding text names another working directory.
- Update the owning page in the same change as a documented CLI option, runtime lookup rule, component boundary, or packaging step.
- Add or update a decision record when changing architecture, process ownership, security boundaries, or runtime distribution. Mechanical edits do not require one.
- Do not restate generated inventories, source comments, test lists, implementation status, or implementation reasoning.

## Budgets and Validation

Word ceilings are declared in [`scripts/doc-budgets.json`](../scripts/doc-budgets.json). Keep at least 5% headroom when practical; relocate misplaced detail before raising a limit.

Run the documentation gate after changing Markdown:

```powershell
.\scripts\verify-docs.ps1
```

The gate rejects missing budget entries, missing files, excess words, broken relative links, and missing heading fragments.

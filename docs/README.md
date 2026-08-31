# Documentation

This reference is the entry point for repository documentation. Read the page that owns the subject and use its links for lower-level detail.

## Directory

```text
docs/
├── AGENTS.md                 documentation rules and budgets
├── architecture.md           component map and runtime lifecycle
├── development.md            contributor setup and validation
├── cookbook/
│   └── package-windows.md    standalone Windows packaging tutorial
├── decisions/
│   └── README.md             architectural decision-record format
├── postmortem/
│   └── README.md             incident documentation format
└── reference/
    └── cli.md                CLI and runtime-discovery contract
```

## Reading Guide

| Need | Document | Type |
| --- | --- | --- |
| Understand process and component ownership | [Architecture](architecture.md) | Reference |
| Prepare a development environment | [Development](development.md) | Tutorial |
| Look up options or runtime resolution | [CLI reference](reference/cli.md) | Reference |
| Produce a distributable Windows folder | [Windows packaging](cookbook/package-windows.md) | Tutorial |
| Record a durable technical choice | [Decision records](decisions/README.md) | Reference |
| Document an operational failure | [Postmortems](postmortem/README.md) | Reference |

Contributors editing this tree must follow [the documentation guidelines](AGENTS.md).

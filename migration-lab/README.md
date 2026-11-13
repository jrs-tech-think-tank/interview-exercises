# Solutions Engineering Migration Lab

## Scenario

Acme Payments is evaluating Blacksmith for its GitHub Actions workloads. The team cares about faster CI, lower spend, and a smoother debugging workflow when jobs fail.

The repository contains a representative CI pipeline with:

- Runner labels that should be migrated to Blacksmith.
- Jobs with different compute requirements.
- Docker builds for multiple architectures.
- Tests split across shards.
- Integration tests that depend on Postgres.

Your goal during the interview is to help Acme get started on Blacksmith, inspect the resulting CI behavior, and recommend changes.

## CI Workflow

The GitHub Actions workflow for this lab is:

```text
.github/workflows/acme-ci.yml
```

The workflow is intentionally the main surface area for the exercise. It contains jobs named:

- `Background report profile`
- `Fraud model benchmark`
- `Unit tests shard */8`
- `Integration tests`
- `Docker build (...)`


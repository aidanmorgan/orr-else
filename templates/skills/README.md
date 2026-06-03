# Skills

Place Pi skill files in this directory. Skills are reusable prompt fragments that
can be referenced from state prompts via the `skills:` key in `harness.yaml`.

## Format

Each skill is a Markdown file. The filename (without `.md`) is the skill identifier.

Example skill reference in `harness.yaml`:

```yaml
states:
  - id: Implementation
    actions:
      - id: implement
        type: prompt
        promptKey: implementer
        skills:
          - code-review
          - testing-patterns
```

## Default Skills

Add your project-specific skills here. Generic harness skills (like `signal_completion`
usage guides) are provided by the harness itself.

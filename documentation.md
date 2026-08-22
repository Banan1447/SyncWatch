> Feature hub: [docs/index.md](docs/index.md) | Feature status: [docs/featuremap.md](docs/featuremap.md)

# Documentation

## After every significant code change

1. Find the corresponding `FEATURE_*.md` in `docs/`
2. Update its content — what's implemented, what's not
3. Update YAML frontmatter: `progress`, `status`, `last_audited`
4. Update [docs/featuremap.md](docs/featuremap.md) — move card to the right column, update %

## Featuremap (docs/featuremap.md)

[docs/featuremap.md](docs/featuremap.md) is the feature tracking board.
When a feature status changes:
- Find the `[FEATURE_*]` card in the featuremap
- Move to the right column
- Update % in the card text

Card format: `- [ ] [FEATURE_name](./FEATURE_name.md) — X%`

## New service/module without FEATURE_*.md

1. Create `docs/FEATURE_[name].md` using existing ones as template (YAML frontmatter + sections: Description / Implemented / Not Implemented / Related Files)
2. Add card to [docs/featuremap.md](docs/featuremap.md) in `In Progress` column

## Unfinished work — mandatory TODO

If during implementation something couldn't be completed (missing context, dependency on another module, too large scope, needs user decision):

1. **Don't leave silently.** Add a specific `- [ ]` item to the `## TODO` section of the corresponding `docs/FEATURE_*.md`
2. Format: `- [ ] specific action (reason: why not done now)`
3. At the end of the response, **list** everything unfinished:
   ```
   Unfinished:
   - FEATURE_xxx.md: task description (reason)
   - FEATURE_yyy.md: task description (reason)
   ```
4. If no `## TODO` section exists in the file — create one right after the header and Status

Rule: **zero context loss**. Everything not implemented must be recorded in the FEATURE file, not lost between sessions.

## Never delete sections

Mark outdated content as `> ⚠️ Outdated — [reason]`, don't delete.

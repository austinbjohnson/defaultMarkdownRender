---
name: "hello-skill"
description: "Test fixture for skill-style YAML frontmatter rendering and round-trip stability."
---

# Hello Skill

This file mirrors the frontmatter shape used by SKILL.md files.

## Expected Behavior

1. Frontmatter panel appears and parses `name` and `description`.
2. Editing markdown body does not mutate frontmatter.
3. Reopening the file preserves exact frontmatter delimiters and values.

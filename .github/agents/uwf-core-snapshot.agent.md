---
name: uwf-core-snapshot
description: "Produce uwf-drs as a point-in-time reconstruction record after acceptance. Closes uwf-br layer 5 and appends a closure entry to uwf-changelog."
tools: ["agent", "todo", "search", "edit", "read", "execute"]
user-invocable: false
---

# Snapshot Stage

Read `.github/skills/uwf-snapshot/SKILL.md`. All procedures, the uwf-drs JSON schema, divergence detection rules, uwf-br layer 5 closure format, uwf-changelog append format, and exit criteria are defined there. Follow them exactly.

This stage runs only on accepted state. Verify `verdict: approved` in the acceptance artifact before proceeding. If the acceptance gate has not passed, abort immediately and report the failure.

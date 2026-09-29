# How to read this

This is the digest of a 294-page book, compressed roughly 4:1. It is a **reference**, not a tutorial: it assumes you will read it beside the source, and every claim carries the `path.ts:LINE` that supports it.

## What is kept, and what was cut

**Kept in full — nothing removed:**

- every **citation** (`path.ts:LINE`) — ~600 of them
- every **control-decision table**: the exact branch conditions and where each lives
- every **finding**: what is mounted, what is inert, what is dead, what the docs get wrong
- every **configuration default**, resolved across all three composition layers
- every **limit and fragile area**, including the acknowledged in-source TODOs
- the **design rationale** — §E is the consolidated "what the real implementation adds and which failure each addition prevents"
- 21 of 27 **diagrams**

**Cut — the ~20%:**

- **exercises** (~120 of them) and the "what you'll learn / prerequisites" apparatus
- **narrative scaffolding** — the extended problem statements and analogies that open each full chapter
- **long code excerpts**, trimmed to the lines that carry the decision
- **repetition** — the three-layer composition hazard is explained once here rather than at each site
- 6 diagrams whose content is stated more compactly as a table

**Reach for the full edition** when you want the reasoning developed at length, worked exercises, or the complete ~25-line excerpts. Everything factual is here.

## Reading paths

- **Orient in twenty minutes:** §1 → §2 → §4, then §31 (one real turn, annotated line by line).
- **Understand the core:** §5 → §6 → §7 → §9 → §10 → §11. Those six are the thesis and its proof.
- **Debug something specific:** Appendix D maps mechanisms, files, and extension points to sections; §32 traces three failure paths end to end; §35 lists where the guarantees stop.
- **Rebuild it:** §37, then the sections each milestone names. Milestones 1–7 need no plugin framework.

## Evidence

Written entirely from reading the implementation, then checked by building and running the suite: **3,373 of 3,383 tests pass**, including **342/342** covering the engine core. Every failure on the test machine traces to a Windows limitation rather than to behavior. Marks used inline: 🧪 run-verified · ⚠️ a docs-vs-code contradiction or an unverified quoted figure · ❗ a confirmed limitation · ✅ a specifically verified negative ("nothing does this").

Three claims in the first draft were **wrong** and are corrected here; §E's closing note explains how each was caught, because the failure mode is instructive.

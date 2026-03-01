# Model Comparison Findings

50-note test corpus, 2026-02-28. All models ran the same three-phase tag pipeline (discover → consolidate → assign) on identical notes.

## Summary

| Model | Thinking | Time | Tags | Untagged | Largest tag | Quality |
|---|---|---|---|---|---|---|
| **qwen3:8b** | **hybrid** | **~21 min** | **17** | **3** | **software (14)** | **Best — accurate taxonomy, permissive assignment, no catch-alls** |
| llama3.1:8b | no | ~2 min | 21 | 1 | software (14) | Good runner-up — discovered "projects" category, slight over-tagging |
| ministral-3:8b | no | ~2 min | 20 | 2 | software (20) | Decent — "software" too broad (20/50), overlapping categories |
| deepseek-r1:8b | hybrid | ~58 min | 10 | 1 | ideas (25) | Poor — catch-all junk drawers, narrow taxonomy, 3x slower |
| gemma3n:e4b | no | ~2 min | 14 | 0 | personal (31) | Bad — "personal" swallowed 62% of notes |

"Hybrid" = thinking for discovery, no thinking for assignment. Only qwen3 and deepseek-r1 support `<think>` tags natively.

## Thinking support

Models trained with `<think>` tag conventions (can use `--think` flag):
- **qwen3** — native support, best results with hybrid approach
- **deepseek-r1** — native support, but over-thinks and returns too many blanks

Models without thinking support (schema-constrained only):
- **llama3.1** — standard instruction-tuned, no `<think>` tags
- **ministral-3** — standard instruction-tuned, no `<think>` tags
- **gemma3n** — no `<think>` tags (gemma3:4b failed at 96% when thinking was attempted)

## Detailed analysis

### qwen3:8b (hybrid) — Winner

- Discovery: ~20 min (thinking enabled, ~25s/note). Produced specific, well-differentiated tags.
- Consolidation: 17 canonical tags after pruning. No catch-all categories.
- Assignment: ~45s (schema-constrained, no thinking). Permissive but accurate.
- 3 correctly untagged: GFM Test, Skyline, Untitled 6
- Tags feel natural for sidebar browsing: software, ideas, ai, fitness, finance, books, music, humor, travel, journaling, etc.
- Minor issue: "front license plate" mistagged as software/ai

### llama3.1:8b (no thinking) — Best runner-up

- Fast (~2 min total). Produced 21 tags — more granular taxonomy than qwen3.
- Uniquely discovered "projects" as a category (6 notes) — a useful distinction other models missed.
- Also found career (4), housing (3), business (3) — fine-grained but useful.
- Only 1 untagged (Workout Fitness Journal).
- Slight over-tagging tendency but no catch-all problems.
- Would be the pick if speed matters and thinking isn't available.

### ministral-3:8b (no thinking)

- Fast (~2 min total). 20 tags, 2 untagged.
- "software" too broad at 20/50 notes (40% of corpus).
- "technology" (16 notes) heavily overlaps with "software".
- Introduced "automation" (10 notes) — interesting but overlaps with software/technology.
- "development" (10 notes) is another software synonym.
- Net: too many overlapping tech-adjacent categories, not enough differentiation elsewhere.

### deepseek-r1:8b (hybrid) — Worst thinking model

- Extremely slow: ~33 min discovery + ~25 min assignment = ~58 min total.
- Discovery too conservative: **12/50 notes returned zero tags** (including obviously taggable notes like "AI Agents as Competing Independent Thinkers", "Books to read", "Startup Business Ideas").
- Only 10 tags survived consolidation — narrow taxonomy.
- Assignment compensated by jamming everything into catch-alls: "ideas" (25 notes), "journaling" (21 notes).
- Bad assignments: "Gift ideas" → technology, "Half Price Books Haul" → work, "Wednesday lyrics" → technology, "GFM Test" → ai.
- deepseek-r1 is a reasoning model distilled from a much larger model — it overthinks during discovery and the narrow taxonomy cascades into garbage assignments.

### gemma3n:e4b (no thinking)

- Fast (~2 min total). 14 tags, 0 untagged.
- "personal" swallowed 31/50 notes (62%) — unusable as a navigation category.
- "personal development" added another 25/50 notes — massive overlap with "personal".
- Tags that weren't catch-alls (reading, music, travel, fitness) were fine but too few notes each.
- The model defaults to vague, safe categories instead of making specific calls.

## Conclusions

1. **Thinking matters for taxonomy quality.** qwen3:8b with thinking produced the most useful, well-differentiated tag set. Without thinking, even the best models (llama3.1) produce slightly noisier taxonomies.

2. **Not all thinking models are equal.** deepseek-r1:8b supports thinking but produced the worst results among thinking-capable models. It's too conservative in discovery, creating a starved taxonomy that cascades into catch-all assignments.

3. **Hybrid is the right approach.** Thinking for discovery (where reasoning about "what is this note about?" matters) + schema-constrained assignment (where the model just needs to pick from a list) consistently outperforms all-thinking or no-thinking.

4. **Catch-all tags are the main failure mode.** Any tag covering >30% of notes is useless for navigation. Models that produce "personal", "ideas", or "journaling" as catch-alls are failing the core use case.

5. **Speed vs quality tradeoff is real but worth it.** qwen3:8b hybrid takes ~21 min vs ~2 min for non-thinking models. For overnight batch processing of a full corpus, this is irrelevant. For on-device real-time tagging, the non-thinking models would need to be considered.

6. **Full corpus estimate (qwen3:8b hybrid, ~2300 notes):** ~13-16 hours for discovery, ~40 min for assignment. Suitable for overnight batch run.

## Comments and specifications

Comments preserve information that names, structure, types, and specifications do not efficiently
express. Comment non-obvious intent, ordering constraints, external limitations, retry/background
behavior, and major regions in long markup or tests. Operational scripts and configuration should
label meaningful phases, safety constraints, readiness checks, and ordering requirements.

Do not:

- Translate obvious syntax into prose.
- Paste product requirements or full API contracts into source files.
- Keep dead implementation commented out.
- Write author diaries, change logs, or mandatory documentation for self-explanatory exports.
- Preserve comments invalidated by the same change.

Keep comments short, direct, current, and immediately above the code they explain. A short comment
may cite a stable specification or decision when implementing a surprising constraint.

| Information                                                  | Owner                          |
| ------------------------------------------------------------ | ------------------------------ |
| User-visible behavior and acceptance criteria                | `docs/spec/`                   |
| System-wide architecture or a durable tradeoff               | Architecture docs or ADRs      |
| Inputs, outputs, and finite states                           | Types and signatures           |
| What a component or function does                            | Its name, props, and structure |
| Why local order, waiting, retry, or a workaround is required | A nearby comment               |
| Operational phases in scripts or configuration               | Phase comments in that file    |

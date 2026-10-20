## Testing

Co-locate tests with the unit, feature, or boundary they verify. Use a top-level test directory only
when the test spans owners or cannot usefully live beside one implementation.

Test behavior at its owning layer:

- Pure logic: inputs, outputs, edge cases, and errors.
- Integrations: command/request construction, response conversion, missing data, and provider errors
  using controlled dependencies.
- Routes and commands: input extraction, validation, delegation, response/result mapping, and errors.
- Components and pages: visible states, interaction, accessibility, and submitted actions.
- State modules and contexts: public transitions, lifecycle, and provider requirements.

Prefer one behavior per test and names that state the behavior. Test through the public contract.
Export a private helper only when it is a cohesive unit worth owning and testing independently, not
merely to reach an implementation detail.

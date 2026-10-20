## Native app icon sheet

- _(iOS)_ Settings opens App icon in a nested sheet with its own NavigationStack; Done or swipe dismisses only the picker and returns to Settings.
- _(Android)_ The App icon ModalBottomSheet owns system/predictive Back and swipe dismissal; its Back button also dismisses only the sheet, leaving Settings and the navigation stack intact, without adding a global Screen route.
- _(native shells)_ Sheet dismissal preserves completed icon changes.

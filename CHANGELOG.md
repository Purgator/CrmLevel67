# Changelog

## 1.0.1

- Classic web client (forms in a frame, as on many on-premises organisations): logical name chips and blur now work there.
- Blur also covers two-option fields and header fields in the Unified Interface, and no longer keeps anything running in the page.
- The impersonation check asks the server through a data query, because `WhoAmI` ignores impersonation on some versions and reported "not applied" wrongly.
- In the classic web client the menu says that impersonation only covers Web API calls there.
- The page scripts are loaded once per page instead of at every opening of the menu.

## 1.0.0

First release.

- Search-first command palette with fuzzy search, favourites, recents, keyboard navigation, light and dark themes.
- 52 commands in five groups: Record, Navigate, Admin, Debug, Tools.
- In-page side panel with filter, click-to-copy, CSV and JSON export.
- User impersonation through a session-scoped network rule, confirmed by the server, with a badge on the tabs of that environment.
- Logical names shown as click-to-copy chips under the field labels.
- Settings panel: keep the menu open after a command or close it, theme, clear favourites and recents.
- Web API playground.
- Separate packages for Chromium browsers and Firefox 140+.

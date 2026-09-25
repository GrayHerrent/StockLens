# StockLens release maintenance

These requirements apply to every future application change:

- Update the in-app **Project Documentation** whenever a release adds, removes, renames, relocates, reads, writes, or changes the behavior of a permanent file, API snapshot, cache, master, backup, section, subsection, or tool.
- Keep the permanent-file register complete. Each entry must identify the file and location, explain its purpose, inputs and outputs, name every tool that creates or updates it, name the tools that consume it, describe its retention/version behavior, and provide working file/folder links.
- Keep the sections-and-tools catalog synchronized with the actual navigation and workflow. Clearly label placeholders or unimplemented tools.
- Treat the in-app documentation arrays as release-controlled source. Update `DOCUMENTATION_UPDATED_DATE_TIME` with every release; it should follow `APP_PUBLISHED_DATE_TIME` unless documentation has a separately verified timestamp.
- Update `APP_VERSION` and `APP_PUBLISHED_DATE_TIME` for every saved release, always showing the full date and time in ET.
- Run the build and automated tests after documentation or application changes.
- Save a new Site version first. Do not publish unless the user explicitly asks to publish that completed version.

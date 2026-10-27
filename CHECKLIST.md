# Nax-Notepad: what must never happen

Each release report marks every item as verified (by a named test) or not verified.

## Data in documents

1. Unsaved text must never be lost when the window closes, the app crashes, the language changes or the app is updated; it is restored on the next start.
2. A failed or interrupted save must never leave the target file half-written, truncated or empty; the original stays unchanged.
3. Saving must never delete or overwrite any file other than the one being saved, including neighbouring files with similar names.
4. Saving must never leave temporary files behind next to the saved file.
5. A file changed by another program must never be overwritten silently; the app asks first.
6. Saving must never change characters silently, for example by replacing characters the target encoding cannot represent or by rewriting bytes that were invalid in the file's encoding.
7. A document in read-only mode must never be changed by any command, macro, paste, replace, widget or hex edit.
8. Typing while a save, a large-file commit or a page load is in progress must never be lost or marked as saved.
9. Replace All limited to a selection must never change text outside that selection.
10. Large files must never be loaded completely into memory, and editing them must never corrupt the parts that were not edited.
11. The hex editor must never write bytes other than the ones the user changed, and the hidden text editor must never change while only the hex view is shown.
12. Follow mode (tail -f) must never mix data appended by another program into unsaved edits.

## The computer and the user's settings

13. Uninstalling must never leave system changes behind: no file associations, Explorer context menu entries, PATH entries or uninstall registry keys remain; user data is removed only when the user agrees.
14. The installer must never overwrite the user's settings, session or unsaved text.
15. Importing from Notepad++ must never change Notepad++ files and must never apply anything the user did not tick.
16. Opening a document must never run code from it: links open only on Ctrl+click, and Markdown preview never executes scripts or HTML.

## Privacy

17. The app must never send personal data: the update check sends no file names, paths or settings.
18. The repository, commit history and release downloads must never contain personal data, absolute local paths of the build machine or traces of AI tools.

# Lite Claude Diff

A lightweight VS Code extension to **see and review the code changes made by Claude Code**, the way
Copilot Edits or Antigravity let you: see which files were touched, what changed in them, and
**accept or reject each change — or a whole file**.

## Features

Review happens **in the file itself**, like Antigravity / Copilot Edits:

- **Status bar review toolbar.** `✦ Claude: 3 files` appears as soon as Claude edits something; click it to
  open the first file. On a changed file it becomes `‹  ✦ Claude 2/3  ›  ✓ Accept file  ✗ Reject file`, plus `Accept all` · `Reject all` at any time;
  accepting or rejecting a file opens the next one. Click `Claude 2/3` to jump to any file
  (`Ctrl+Alt+]` / `Ctrl+Alt+[` also move between files).
- **In the editor**: lines added by Claude are highlighted in green, a red line marks where code was
  removed; hover a change to see the original code. `Alt+F5` / `Shift+Alt+F5` jump between changes.
- **Explorer marker**: a purple `●` on files Claude modified or created (and their folders), gone once
  the file is reviewed. Colour: `liteClaudeDiff.explorerMarker` in `workbench.colorCustomizations`.
- **CodeLens** above each change: `✓ Accept` · `✗ Reject`, and `Accept file` · `Reject file` at the top.
- **Source Control › Claude Changes** lists the files; clicking one opens a side-by-side diff if you want it.
- Rejecting restores the original code (undoable with `Ctrl+Z`); rejecting a file Claude created deletes it.

Changes are tracked **since the last review**: if Claude edits a file several times, you review the
combined result against the content it had before Claude's first edit.

## How it works

Claude Code [hooks](https://docs.claude.com/en/docs/claude-code/hooks) are used to capture each file
just before Claude modifies it:

```
Claude Code ──PreToolUse (Write|Edit|MultiEdit)──▶ lite-claude-diff-hook.js
                                                       │ saves the original content
                                                       ▼
                                   ~/.lite-claude-diff/baselines/<sha1(path)>.json
                                                       │ watched by the extension
                                                       ▼
                     diff(baseline, current file) ─▶ tree view, decorations, CodeLens
```

- **Accept** a change → it's merged into the baseline (it stops being "pending").
- **Reject** a change → the original lines are written back into the file.
- When the file equals its baseline again, the baseline is deleted.
- `PostToolUse` removes the baseline if the tool ended up changing nothing.

**Zero setup.** On first start the extension registers its hook once, at user level, in
`~/.claude/settings.json` — so it applies to every project, with nothing written in your repos.
Your existing settings and hooks are preserved. The hook runs with VS Code's own Node runtime
(nothing else to install) and is refreshed automatically when VS Code updates. Uninstalling the
extension removes the hook. Baselines live in a single global folder, `~/.lite-claude-diff/`; each
VS Code window shows the files that belong to its workspace.

This works with Claude Code in the terminal and with the official Claude Code VS Code extension, since
both read the same settings.

## Getting started

1. Download `lite-claude-diff-<version>.vsix` from the
   [latest release](https://github.com/AlexLynx77/lite-claude-diff/releases/latest) and install it:
   `code --install-extension lite-claude-diff-<version>.vsix`
   (or *Extensions* view › `…` › *Install from VSIX…*).
2. Start a **new** Claude Code session (hooks are loaded when a session starts).
3. Ask Claude to change some code: `✦ Claude: N files` appears in the status bar — click it to review.

To turn tracking off, run **Lite Claude Diff: Disable Claude Code change tracking** (it stays off
until you run *Enable*), or set `liteClaudeDiff.autoInstallHook` to `false`.

## Development

```bash
npm install
npm run compile      # or: npm run watch
npm test             # diff algorithm tests
npm run package      # builds lite-claude-diff-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host. Install a build with
`code --install-extension lite-claude-diff-<version>.vsix`.

### Layout

| File | Role |
| --- | --- |
| `hook/lite-claude-diff-hook.js` | Claude Code hook: snapshots files before edits |
| `src/tracker.ts` | Reads baselines, computes hunks, accept/reject logic |
| `src/diff.ts` | Dependency-free Myers line diff |
| `src/views.ts` | Tree view, CodeLens, decorations, baseline documents for the diff editor |
| `src/hookInstaller.ts`, `src/hookSettings.ts` | Adds/removes the hook in `~/.claude/settings.json` |
| `src/uninstall.ts` | Removes the hook when the extension is uninstalled |
| `src/extension.ts` | Activation and commands |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `liteClaudeDiff.codeLens` | `true` | Accept/Reject CodeLens above each change |
| `liteClaudeDiff.decorations` | `true` | Highlight changed lines in the editor |
| `liteClaudeDiff.autoInstallHook` | `true` | Register the hook in `~/.claude/settings.json` automatically |

## Limitations

- Only edits made through Claude's file tools (`Write`, `Edit`, `MultiEdit`) are tracked; files changed
  by shell commands (`sed`, `rm`, code generators…) are not.
- Text files up to 5 MB; binary files are ignored.
- Edits you make yourself to a file that has pending Claude changes are shown as part of those changes.

import * as vscode from 'vscode';
import * as path from 'path';
import { Tracker, TrackedFile } from './tracker';
import { Hunk } from './diff';

// ---- Baseline documents (left side of the diff editor) ---------------------------------

export const BASELINE_SCHEME = 'lite-claude-diff';

export function baselineUri(file: TrackedFile): vscode.Uri {
    return vscode.Uri.from({
        scheme: BASELINE_SCHEME,
        path: '/' + path.basename(file.fsPath),
        query: encodeURIComponent(file.fsPath),
    });
}

/** Maps a file or baseline URI back to the tracked file path. */
export function fsPathOf(uri: vscode.Uri): string {
    return uri.scheme === BASELINE_SCHEME ? decodeURIComponent(uri.query) : uri.fsPath;
}

export class BaselineProvider implements vscode.TextDocumentContentProvider {
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.emitter.event;

    constructor(private readonly tracker: Tracker) {
        tracker.onDidChange(() => {
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.uri.scheme === BASELINE_SCHEME) {
                    this.emitter.fire(doc.uri);
                }
            }
        });
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const file = this.tracker.get(fsPathOf(uri));
        // Once everything is accepted/rejected the record is gone: show the file itself.
        return file ? file.baseline : vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPathOf(uri))?.getText() ?? '';
    }
}

/** True if `editor` is the modified side of one of our Claude diff editors. */
export function isInClaudeDiff(editor: vscode.TextEditor): boolean {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn);
    const input = group?.activeTab?.input;
    return (
        input instanceof vscode.TabInputTextDiff &&
        input.original.scheme === BASELINE_SCHEME &&
        input.modified.fsPath === editor.document.uri.fsPath
    );
}

// ---- "Claude Changes" tree view in the Source Control container ------------------------

export class ChangesTree implements vscode.TreeDataProvider<TrackedFile> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly tracker: Tracker) {
        tracker.onDidChange(() => this.emitter.fire());
    }

    getChildren(element?: TrackedFile): TrackedFile[] {
        return element ? [] : this.tracker.all;
    }

    getTreeItem(file: TrackedFile): vscode.TreeItem {
        const item = new vscode.TreeItem(file.uri, vscode.TreeItemCollapsibleState.None);
        const folder = vscode.workspace.getWorkspaceFolder(file.uri);
        const rel = folder ? path.relative(folder.uri.fsPath, path.dirname(file.fsPath)) : path.dirname(file.fsPath);
        const stats = !file.existedBefore ? `new +${file.added}` : !file.exists ? 'deleted' : `+${file.added} −${file.removed}`;
        item.description = rel ? `${stats}  ${rel}` : stats;
        item.tooltip = new vscode.MarkdownString(
            `**${path.basename(file.fsPath)}** — ${file.hunks.length} change(s), ${stats}\n\n` +
                `\`${file.fsPath}\`\n\nFirst edited by Claude: ${file.createdAt.toLocaleString()}`,
        );
        item.contextValue = 'claudeChange';
        item.command = { command: 'liteClaudeDiff.openDiff', title: 'Open Claude Diff', arguments: [file] };
        return item;
    }
}

// ---- CodeLens: Accept / Reject per hunk and per file ----------------------------------

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.emitter.event;

    constructor(private readonly tracker: Tracker) {
        tracker.onDidChange(() => this.emitter.fire());
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('liteClaudeDiff.codeLens')) {
                this.emitter.fire();
            }
        });
    }

    provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration('liteClaudeDiff').get<boolean>('codeLens', true)) {
            return [];
        }
        const file = this.tracker.get(doc.uri.fsPath);
        // Skip while the document has diverged from what the tracker last computed.
        if (!file || doc.getText() !== file.current) {
            return [];
        }
        const top = new vscode.Range(0, 0, 0, 0);
        const lenses = [
            new vscode.CodeLens(top, {
                title: `$(sparkle) Claude: ${file.hunks.length} change(s)`,
                command: '',
            }),
            new vscode.CodeLens(top, { title: '$(check-all) Accept file', command: 'liteClaudeDiff.acceptFile', arguments: [doc.uri] }),
            new vscode.CodeLens(top, { title: '$(discard) Reject file', command: 'liteClaudeDiff.rejectFile', arguments: [doc.uri] }),
        ];
        for (const hunk of file.hunks) {
            const line = Math.min(hunk.curStart, doc.lineCount - 1);
            const range = new vscode.Range(line, 0, line, 0);
            lenses.push(
                new vscode.CodeLens(range, { title: '$(check) Accept', command: 'liteClaudeDiff.acceptHunk', arguments: [doc.uri, hunk] }),
                new vscode.CodeLens(range, { title: '$(close) Reject', command: 'liteClaudeDiff.rejectHunk', arguments: [doc.uri, hunk] }),
                new vscode.CodeLens(range, { title: hunkLabel(hunk), command: '' }),
            );
        }
        return lenses;
    }
}

function hunkLabel(h: Hunk): string {
    const add = h.curLines.length;
    const del = h.baseLines.length;
    if (!del) {
        return `+${add} line(s)`;
    }
    if (!add) {
        return `−${del} line(s) removed`;
    }
    return `+${add} −${del}`;
}

// ---- Inline decorations ---------------------------------------------------------------

export class Decorator implements vscode.Disposable {
    private readonly added = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    /** Pure deletions: a red line where the code was (hover shows the removed code). */
    private readonly removedAbove = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderWidth: '2px 0 0 0',
        borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    private readonly removedBelow = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderWidth: '0 0 2px 0',
        borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    /** Only the Accept/Reject hover: used inside the diff editor, which already colours everything. */
    private readonly hoverOnly = vscode.window.createTextEditorDecorationType({});
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly tracker: Tracker) {
        this.disposables = [
            this.added,
            this.removedAbove,
            this.removedBelow,
            this.hoverOnly,
            tracker.onDidChange(() => this.updateAll()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.updateAll()),
            vscode.window.tabGroups.onDidChangeTabs(() => this.updateAll()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('liteClaudeDiff.decorations')) {
                    this.updateAll();
                }
            }),
        ];
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private updateAll(): void {
        vscode.window.visibleTextEditors.forEach((e) => this.update(e));
    }

    private update(editor: vscode.TextEditor): void {
        const enabled = vscode.workspace.getConfiguration('liteClaudeDiff').get<boolean>('decorations', true);
        const doc = editor.document;
        const file = doc.uri.scheme === 'file' ? this.tracker.get(doc.uri.fsPath) : undefined;
        const added: vscode.DecorationOptions[] = [];
        const above: vscode.DecorationOptions[] = [];
        const below: vscode.DecorationOptions[] = [];
        const hovers: vscode.DecorationOptions[] = [];

        if (file && doc.getText() === file.current && doc.lineCount > 0) {
            const inDiff = isInClaudeDiff(editor);
            for (const hunk of file.hunks) {
                const hover = hunkHover(file, hunk, doc.languageId);
                const first = Math.min(hunk.curStart, doc.lineCount - 1);
                const last = Math.min(hunk.curStart + Math.max(hunk.curLines.length, 1) - 1, doc.lineCount - 1);
                const range = new vscode.Range(first, 0, last, 0);
                if (inDiff || !enabled) {
                    hovers.push({ range, hoverMessage: hover });
                    continue;
                }
                if (hunk.curLines.length) {
                    added.push({ range, hoverMessage: hover });
                } else if (hunk.curStart < doc.lineCount) {
                    above.push({ range: new vscode.Range(hunk.curStart, 0, hunk.curStart, 0), hoverMessage: hover });
                } else {
                    below.push({ range: new vscode.Range(doc.lineCount - 1, 0, doc.lineCount - 1, 0), hoverMessage: hover });
                }
            }
        }
        editor.setDecorations(this.added, added);
        editor.setDecorations(this.removedAbove, above);
        editor.setDecorations(this.removedBelow, below);
        editor.setDecorations(this.hoverOnly, hovers);
    }
}

function hunkHover(file: TrackedFile, hunk: Hunk, languageId: string): vscode.MarkdownString {
    const args = (cmd: string) => `command:${cmd}?${encodeURIComponent(JSON.stringify([file.uri.toString(), hunk]))}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['liteClaudeDiff.acceptHunk', 'liteClaudeDiff.rejectHunk'] };
    md.appendMarkdown(
        `**Claude change** (${hunkLabel(hunk)}) — [$(check) Accept](${args('liteClaudeDiff.acceptHunk')}) · ` +
            `[$(close) Reject](${args('liteClaudeDiff.rejectHunk')})\n\n`,
    );
    if (hunk.baseLines.length) {
        md.appendMarkdown('Before:\n');
        md.appendCodeblock(hunk.baseLines.join('\n'), languageId);
    }
    return md;
}

// ---- Explorer marker: a purple dot on files (and their folders) Claude changed ---------

export class ExplorerDecorations implements vscode.FileDecorationProvider {
    private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this.emitter.event;
    private shown: vscode.Uri[] = [];

    constructor(private readonly tracker: Tracker) {
        tracker.onDidChange(() => {
            const now = tracker.all.map((f) => f.uri);
            this.emitter.fire([...this.shown, ...now]); // refresh files that gained or lost the dot
            this.shown = now;
        });
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const file = uri.scheme === 'file' ? this.tracker.get(uri.fsPath) : undefined;
        if (!file) {
            return undefined;
        }
        // No badge: just the file name in purple.
        const d = new vscode.FileDecoration(
            undefined,
            file.existedBefore ? 'Modified by Claude (pending review)' : 'Created by Claude (pending review)',
            new vscode.ThemeColor('liteClaudeDiff.explorerMarker'),
        );
        d.propagate = true;
        return d;
    }
}

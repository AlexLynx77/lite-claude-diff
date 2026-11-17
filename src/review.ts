import * as vscode from 'vscode';
import * as path from 'path';
import { Tracker, TrackedFile } from './tracker';
import { baselineUri, fsPathOf } from './views';

/**
 * File-by-file review driven from the status bar:
 *
 *   not reviewing:  [✦ Claude: 3 files]                      → click opens the first file
 *   reviewing:      [‹] [✦ Claude 2/3] [›] [✓ Accept file] [✗ Reject file]
 *   always:         [✓✓ Accept all] [✗ Reject all]
 *
 * Files open in the normal editor; accepting / rejecting a file moves on to the next one.
 */
export class Review implements vscode.Disposable {
    private readonly main = item('liteClaudeDiff.status', 'Claude changes', 105);
    private readonly prev = item('liteClaudeDiff.prev', 'Claude: previous file', 104);
    private readonly next = item('liteClaudeDiff.next', 'Claude: next file', 103);
    private readonly accept = item('liteClaudeDiff.accept', 'Claude: accept file', 102);
    private readonly reject = item('liteClaudeDiff.reject', 'Claude: reject file', 101);
    private readonly acceptAll = item('liteClaudeDiff.acceptAll', 'Claude: accept all', 100);
    private readonly rejectAll = item('liteClaudeDiff.rejectAll', 'Claude: reject all', 99);
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly tracker: Tracker) {
        this.prev.text = '$(chevron-left)';
        this.prev.tooltip = 'Previous file changed by Claude';
        this.prev.command = 'liteClaudeDiff.previousFile';
        this.next.text = '$(chevron-right)';
        this.next.tooltip = 'Next file changed by Claude';
        this.next.command = 'liteClaudeDiff.nextFile';
        this.accept.text = '$(check) Accept file';
        this.accept.tooltip = 'Keep all of Claude’s changes in this file, then go to the next file';
        this.accept.command = 'liteClaudeDiff.acceptFile';
        this.reject.text = '$(close) Reject file';
        this.reject.tooltip = 'Undo all of Claude’s changes in this file, then go to the next file';
        this.reject.command = 'liteClaudeDiff.rejectFile';
        this.acceptAll.text = '$(check-all) Accept all';
        this.acceptAll.tooltip = 'Keep all of Claude’s changes in every file';
        this.acceptAll.command = 'liteClaudeDiff.acceptAll';
        this.rejectAll.text = '$(discard) Reject all';
        this.rejectAll.tooltip = 'Undo all of Claude’s changes in every file';
        this.rejectAll.command = 'liteClaudeDiff.rejectAll';
        this.disposables = [
            this.main,
            this.prev,
            this.next,
            this.accept,
            this.reject,
            this.acceptAll,
            this.rejectAll,
            tracker.onDidChange(() => this.update()),
            vscode.window.onDidChangeActiveTextEditor(() => this.update()),
            vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
        ];
        this.update();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    /** The tracked file shown in the active editor or active tab (normal or diff editor). */
    activeFile(): TrackedFile | undefined {
        const uri = vscode.window.activeTextEditor?.document.uri ?? activeTabUri();
        return uri ? this.tracker.get(fsPathOf(uri)) : undefined;
    }

    private update(): void {
        const files = this.tracker.all;
        const active = this.activeFile();
        const reviewing = !!active;
        void vscode.commands.executeCommand('setContext', 'liteClaudeDiff.activeFileTracked', reviewing);

        if (!files.length) {
            [this.main, this.prev, this.next, this.accept, this.reject, this.acceptAll, this.rejectAll].forEach((i) => i.hide());
            return;
        }
        const hunks = files.reduce((n, f) => n + f.hunks.length, 0);
        if (active) {
            const index = files.indexOf(active) + 1;
            this.main.text = `$(sparkle) Claude ${index}/${files.length}`;
            this.main.tooltip = `${path.basename(active.fsPath)}: ${active.hunks.length} change(s), +${active.added} −${active.removed}\nClick to pick another file`;
            this.main.command = 'liteClaudeDiff.pickFile';
        } else {
            this.main.text = `$(sparkle) Claude: ${files.length} file${files.length > 1 ? 's' : ''}`;
            this.main.tooltip = `${hunks} pending change(s) by Claude Code — click to review`;
            this.main.command = 'liteClaudeDiff.review';
        }
        this.main.show();
        this.acceptAll.show();
        this.rejectAll.show();
        for (const i of [this.prev, this.next]) {
            reviewing && files.length > 1 ? i.show() : i.hide();
        }
        for (const i of [this.accept, this.reject]) {
            reviewing ? i.show() : i.hide();
        }
    }

    /** Opens the file itself (not a diff) with the cursor on its first change. */
    async open(file: TrackedFile): Promise<void> {
        const editor = await vscode.window.showTextDocument(file.uri, { preview: false });
        const first = file.hunks[0];
        if (first) {
            const pos = new vscode.Position(Math.min(first.curStart, editor.document.lineCount - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    /** Side-by-side diff, only used from the Source Control list. */
    async openDiff(file: TrackedFile): Promise<void> {
        const title = `${path.basename(file.fsPath)} (Claude changes)`;
        await vscode.commands.executeCommand('vscode.diff', baselineUri(file), file.uri, title, { preview: true });
    }

    /** Status bar click: continue with the active file, or start with the first one. */
    async start(): Promise<void> {
        const file = this.activeFile() ?? this.tracker.all[0];
        if (file) {
            await this.open(file);
        }
    }

    async step(direction: 1 | -1): Promise<void> {
        const files = this.tracker.all;
        if (!files.length) {
            return;
        }
        const current = this.activeFile();
        const i = current ? files.indexOf(current) : -1;
        const target = i < 0 ? (direction === 1 ? 0 : files.length - 1) : (i + direction + files.length) % files.length;
        await this.open(files[target]);
    }

    async pick(): Promise<void> {
        const active = this.activeFile();
        const items = this.tracker.all.map((f) => {
            const folder = vscode.workspace.getWorkspaceFolder(f.uri);
            return {
                label: `${f === active ? '$(arrow-right) ' : ''}${path.basename(f.fsPath)}`,
                description: folder ? path.relative(folder.uri.fsPath, path.dirname(f.fsPath)) : path.dirname(f.fsPath),
                detail: !f.existedBefore ? `new file, +${f.added}` : `${f.hunks.length} change(s), +${f.added} −${f.removed}`,
                file: f,
            };
        });
        const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Files changed by Claude' });
        if (choice) {
            await this.open(choice.file);
        }
    }

    /**
     * Runs a whole-file action. If the user was reviewing that file, its diff is closed and
     * the review moves on to the next pending file.
     */
    async finish(file: TrackedFile, action: (f: TrackedFile) => Promise<void>): Promise<void> {
        const wasActive = this.activeFile()?.fsPath === file.fsPath;
        const index = this.tracker.all.findIndex((f) => f.fsPath === file.fsPath);
        await action(file);
        await this.afterFileDone(file, wasActive, index);
    }

    /** Called once a file has no pending change any more (whole-file or last hunk handled). */
    async afterFileDone(_file: TrackedFile, wasActive: boolean, index: number): Promise<void> {
        const remaining = this.tracker.all;
        if (wasActive && remaining.length) {
            await this.open(remaining[Math.min(Math.max(index, 0), remaining.length - 1)]);
        }
    }
}

function item(id: string, name: string, priority: number): vscode.StatusBarItem {
    const i = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Left, priority);
    i.name = name;
    return i;
}

function activeTabUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
        return input.modified;
    }
    if (input instanceof vscode.TabInputText) {
        return input.uri;
    }
    return undefined;
}

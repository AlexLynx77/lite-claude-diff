import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { diffLines, Hunk, sameHunk, spliceLines, splitLines } from './diff';

/** Global store shared by every project: `~/.lite-claude-diff/baselines/<sha1(path)>.json`. */
export const STORE_DIR = path.join(os.homedir(), '.lite-claude-diff');
const BASELINES_DIR = path.join(STORE_DIR, 'baselines');

function inWorkspace(fsPath: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => {
        const rel = path.relative(f.uri.fsPath, fsPath);
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
}

/** A record still `pending` (tool not finished) is dropped after this delay if nothing changed. */
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;

/** On-disk format written by hook/lite-claude-diff-hook.js. */
interface BaselineRecord {
    version: number;
    filePath: string;
    existed: boolean;
    content: string;
    pending?: boolean;
    createdAt: string;
    tool?: string;
    sessionId?: string;
}

export interface TrackedFile {
    fsPath: string;
    uri: vscode.Uri;
    recordPath: string;
    /** Content before Claude's (still unreviewed) changes. */
    baseline: string;
    /** False when Claude created the file. */
    existedBefore: boolean;
    current: string;
    exists: boolean;
    hunks: Hunk[];
    added: number;
    removed: number;
    createdAt: Date;
}

export class Tracker implements vscode.Disposable {
    private files = new Map<string, TrackedFile>();
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.emitter.event;
    private timer: NodeJS.Timeout | undefined;
    private refreshing: Promise<void> | undefined;
    private dirty = false;
    private readonly disposables: vscode.Disposable[] = [this.emitter];

    constructor() {
        fs.mkdirSync(BASELINES_DIR, { recursive: true });
        // RelativePattern on an absolute folder lets us watch outside of the workspace.
        const records = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(BASELINES_DIR), '*.json'),
        );
        const anyFile = vscode.workspace.createFileSystemWatcher('**/*');
        const onRecord = () => this.schedule();
        const onFile = (uri: vscode.Uri) => {
            if (this.files.has(uri.fsPath)) {
                this.schedule();
            }
        };
        this.disposables.push(
            records,
            anyFile,
            records.onDidCreate(onRecord),
            records.onDidChange(onRecord),
            records.onDidDelete(onRecord),
            anyFile.onDidChange(onFile),
            anyFile.onDidCreate(onFile),
            anyFile.onDidDelete(onFile),
            vscode.workspace.onDidChangeTextDocument((e) => onFile(e.document.uri)),
            vscode.workspace.onDidCloseTextDocument((d) => onFile(d.uri)),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
        );
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.disposables.forEach((d) => d.dispose());
    }

    get all(): TrackedFile[] {
        return [...this.files.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    }

    get(fsPath: string): TrackedFile | undefined {
        return this.files.get(fsPath);
    }

    schedule(delay = 150): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), delay);
    }

    /** Re-reads every baseline record and recomputes diffs. Concurrent calls are coalesced. */
    async refresh(): Promise<void> {
        if (this.refreshing) {
            this.dirty = true;
            return this.refreshing;
        }
        this.refreshing = (async () => {
            do {
                this.dirty = false;
                await this.doRefresh();
            } while (this.dirty);
        })();
        try {
            await this.refreshing;
        } finally {
            this.refreshing = undefined;
        }
    }

    private async doRefresh(): Promise<void> {
        const next = new Map<string, TrackedFile>();
        let names: string[] = [];
        try {
            names = await fs.promises.readdir(BASELINES_DIR);
        } catch {
            /* nothing recorded yet */
        }
        for (const name of names) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const tracked = await this.load(path.join(BASELINES_DIR, name));
            if (tracked) {
                next.set(tracked.fsPath, tracked);
            }
        }
        this.files = next;
        this.emitter.fire();
    }

    private async load(recordPath: string): Promise<TrackedFile | undefined> {
        let record: BaselineRecord;
        try {
            record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8'));
        } catch {
            return undefined; // being written, or corrupted
        }
        if (typeof record.filePath !== 'string' || typeof record.content !== 'string') {
            return undefined;
        }
        const fsPath = path.normalize(record.filePath);
        if (!inWorkspace(fsPath)) {
            return undefined; // belongs to another project / VS Code window
        }
        const baseline = stripBom(record.content);
        const { text, exists } = await readCurrent(fsPath);
        const unchanged = record.existed ? exists && text === baseline : !exists;
        if (unchanged) {
            const age = Date.now() - Date.parse(record.createdAt);
            if (!record.pending || !(age < PENDING_TIMEOUT_MS)) {
                await fs.promises.rm(recordPath, { force: true });
            }
            return undefined;
        }
        const hunks = diffLines(splitLines(baseline), splitLines(text));
        return {
            fsPath,
            uri: vscode.Uri.file(fsPath),
            recordPath,
            baseline,
            existedBefore: record.existed,
            current: text,
            exists,
            hunks,
            added: hunks.reduce((n, h) => n + h.curLines.length, 0),
            removed: hunks.reduce((n, h) => n + h.baseLines.length, 0),
            createdAt: new Date(record.createdAt),
        };
    }

    // ---- Review actions -------------------------------------------------------------

    async acceptFile(file: TrackedFile): Promise<void> {
        // Accepting keeps the file as currently shown, including unsaved tweaks made during review.
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file.fsPath);
        if (doc?.isDirty) {
            await doc.save();
        }
        await fs.promises.rm(file.recordPath, { force: true });
        await this.refresh();
    }

    async rejectFile(file: TrackedFile): Promise<void> {
        if (!file.existedBefore) {
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(file.uri, { ignoreIfNotExists: true });
            await vscode.workspace.applyEdit(edit);
        } else if (!file.exists) {
            await fs.promises.mkdir(path.dirname(file.fsPath), { recursive: true });
            await fs.promises.writeFile(file.fsPath, file.baseline, 'utf8');
        } else {
            await setDocumentText(file.uri, file.baseline);
        }
        await fs.promises.rm(file.recordPath, { force: true });
        await this.refresh();
    }

    async acceptHunk(file: TrackedFile, hunk: Hunk): Promise<boolean> {
        const fresh = await this.freshHunk(file, hunk);
        if (!fresh) {
            return false;
        }
        const [f, h] = fresh;
        const newBaseline = spliceLines(splitLines(f.baseline), h.baseStart, h.baseLines.length, h.curLines).join('\n');
        if (f.exists && newBaseline === f.current) {
            await fs.promises.rm(f.recordPath, { force: true });
        } else {
            await this.writeRecord(f, newBaseline, true);
        }
        await this.refresh();
        return true;
    }

    async rejectHunk(file: TrackedFile, hunk: Hunk): Promise<boolean> {
        const fresh = await this.freshHunk(file, hunk);
        if (!fresh) {
            return false;
        }
        const [f, h] = fresh;
        const newText = spliceLines(splitLines(f.current), h.curStart, h.curLines.length, h.baseLines).join('\n');
        await setDocumentText(f.uri, newText);
        await this.refresh();
        return true;
    }

    /** Makes sure we act on up-to-date data: the hunk must still exist after a refresh. */
    private async freshHunk(file: TrackedFile, hunk: Hunk): Promise<[TrackedFile, Hunk] | undefined> {
        await this.refresh();
        const f = this.files.get(file.fsPath);
        const h = f?.hunks.find((x) => sameHunk(x, hunk));
        return f && h ? [f, h] : undefined;
    }

    private async writeRecord(file: TrackedFile, baseline: string, existed: boolean): Promise<void> {
        let record: BaselineRecord;
        try {
            record = JSON.parse(await fs.promises.readFile(file.recordPath, 'utf8'));
        } catch {
            record = { version: 1, filePath: file.fsPath, existed, content: '', createdAt: new Date().toISOString() };
        }
        record.content = baseline;
        record.existed = existed;
        record.pending = false;
        const tmp = `${file.recordPath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(record));
        await fs.promises.rename(tmp, file.recordPath);
    }
}

function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readCurrent(fsPath: string): Promise<{ text: string; exists: boolean }> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
    if (doc && !doc.isClosed) {
        return { text: doc.getText(), exists: true };
    }
    try {
        return { text: stripBom(await fs.promises.readFile(fsPath, 'utf8')), exists: true };
    } catch {
        return { text: '', exists: false };
    }
}

/** Replaces only the part of the document that differs (keeps cursor, folding and undo sane), then saves. */
async function setDocumentText(uri: vscode.Uri, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const old = doc.getText();
    let start = 0;
    while (start < old.length && start < text.length && old[start] === text[start]) {
        start++;
    }
    let end = 0;
    while (
        end < old.length - start &&
        end < text.length - start &&
        old[old.length - 1 - end] === text[text.length - 1 - end]
    ) {
        end++;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        uri,
        new vscode.Range(doc.positionAt(start), doc.positionAt(old.length - end)),
        text.slice(start, text.length - end),
    );
    await vscode.workspace.applyEdit(edit);
    await doc.save();
}

import * as vscode from 'vscode';
import { Tracker, TrackedFile } from './tracker';
import { HookInstaller } from './hookInstaller';
import { Hunk } from './diff';
import { BASELINE_SCHEME, BaselineProvider, ChangesTree, Decorator, ExplorerDecorations, HunkCodeLensProvider, fsPathOf } from './views';
import { Review } from './review';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
    const tracker = new Tracker();
    const installer = new HookInstaller(ctx);
    const view = vscode.window.createTreeView('liteClaudeDiff.changes', { treeDataProvider: new ChangesTree(tracker) });
    const review = new Review(tracker);

    ctx.subscriptions.push(
        tracker,
        view,
        review,
        new Decorator(tracker),
        explorerDecorations(tracker),
        vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, new BaselineProvider(tracker)),
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new HunkCodeLensProvider(tracker)),
        tracker.onDidChange(() => {
            const n = tracker.all.length;
            view.badge = n ? { value: n, tooltip: `${n} file(s) changed by Claude` } : undefined;
            void vscode.commands.executeCommand('setContext', 'liteClaudeDiff.hasChanges', n > 0);
        }),
    );

    /** Accepts a TrackedFile (tree), a Uri / uri string (CodeLens, hover, menus) or nothing (active editor). */
    const resolve = (arg: unknown): TrackedFile | undefined => {
        let fsPath: string | undefined;
        if (arg instanceof vscode.Uri) {
            fsPath = fsPathOf(arg);
        } else if (typeof arg === 'string') {
            fsPath = fsPathOf(vscode.Uri.parse(arg));
        } else if (arg && typeof (arg as TrackedFile).fsPath === 'string') {
            fsPath = (arg as TrackedFile).fsPath;
        } else {
            return review.activeFile();
        }
        return tracker.get(fsPath);
    };
    const withFile = (fn: (file: TrackedFile) => Thenable<unknown>) => async (arg?: unknown) => {
        const file = resolve(arg);
        if (!file) {
            vscode.window.showInformationMessage('No pending Claude changes for this file.');
            return;
        }
        try {
            await fn(file);
        } catch (err) {
            vscode.window.showErrorMessage(`Lite Claude Diff: ${(err as Error).message}`);
        }
    };
    const hunkAction = (action: 'acceptHunk' | 'rejectHunk') => async (arg: unknown, hunk: Hunk) => {
        const file = resolve(arg);
        try {
            const wasActive = !!file && review.activeFile()?.fsPath === file.fsPath;
            const index = file ? tracker.all.indexOf(file) : -1;
            if (!file || !(await tracker[action](file, hunk))) {
                vscode.window.showWarningMessage('This change is out of date (the file changed). Please try again.');
            } else if (!tracker.get(file.fsPath)) {
                await review.afterFileDone(file, wasActive, index); // that was the file's last change
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Lite Claude Diff: ${(err as Error).message}`);
        }
    };

    const register = (id: string, fn: (...args: any[]) => unknown) =>
        ctx.subscriptions.push(vscode.commands.registerCommand(`liteClaudeDiff.${id}`, fn));

    register('refresh', () => tracker.refresh());
    register('review', () => review.start());
    register('nextFile', () => review.step(1));
    register('previousFile', () => review.step(-1));
    register('pickFile', () => review.pick());
    register('acceptHunk', hunkAction('acceptHunk'));
    register('rejectHunk', hunkAction('rejectHunk'));
    register('acceptFile', withFile((f) => review.finish(f, (x) => tracker.acceptFile(x))));
    register('rejectFile', withFile((f) => review.finish(f, (x) => tracker.rejectFile(x))));
    register('openFile', withFile((f) => vscode.window.showTextDocument(f.uri)));
    register('openDiff', withFile((f) => review.openDiff(f)));
    register('acceptAll', async () => {
        for (const f of tracker.all) {
            await tracker.acceptFile(f);
        }
    });
    register('rejectAll', async () => {
        const files = tracker.all;
        const ok = await vscode.window.showWarningMessage(
            `Reject all Claude changes in ${files.length} file(s)? Files created by Claude will be deleted.`,
            { modal: true },
            'Reject All',
        );
        if (ok) {
            for (const f of files) {
                await tracker.rejectFile(f);
            }
        }
    });
    register('nextChange', () => jump(tracker, 1));
    register('previousChange', () => jump(tracker, -1));
    register('installHook', async () => {
        await ctx.globalState.update(DISABLED_KEY, false);
        if (await install(installer)) {
            vscode.window.showInformationMessage(
                'Claude Code change tracking enabled. Start a new Claude Code session for it to take effect.',
            );
        }
    });
    register('uninstallHook', async () => {
        try {
            installer.uninstall();
        } catch (err) {
            vscode.window.showErrorMessage(`Could not update ${installer.settingsPath}: ${(err as Error).message}`);
            return;
        }
        await ctx.globalState.update(DISABLED_KEY, true);
        await vscode.commands.executeCommand('setContext', 'liteClaudeDiff.hookInstalled', false);
        vscode.window.showInformationMessage('Claude Code change tracking disabled (hook removed from ~/.claude/settings.json).');
    });

    await tracker.refresh();
    await ensureHook(ctx, installer);
}

export function deactivate(): void {}

/**
 * Purple file names in the Explorer. VS Code applies a single colour per file and the provider
 * registered *last* wins; git registers one provider per repository as repositories open, which
 * would hide ours. So we re-register after git whenever a repository opens.
 */
function explorerDecorations(tracker: Tracker): vscode.Disposable {
    const provider = new ExplorerDecorations(tracker);
    let registration = vscode.window.registerFileDecorationProvider(provider);
    let timer: NodeJS.Timeout | undefined;
    const reRegister = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            registration.dispose();
            registration = vscode.window.registerFileDecorationProvider(provider);
        }, 500);
    };
    const subscriptions: vscode.Disposable[] = [];
    const git = vscode.extensions.getExtension('vscode.git');
    if (git) {
        void Promise.resolve(git.activate()).then(
            (exports: any) => {
                const api = exports?.getAPI?.(1);
                if (api) {
                    subscriptions.push(api.onDidOpenRepository(reRegister));
                    if (api.onDidChangeState) {
                        subscriptions.push(api.onDidChangeState(reRegister));
                    }
                }
                reRegister();
            },
            () => undefined,
        );
    }
    return new vscode.Disposable(() => {
        clearTimeout(timer);
        registration.dispose();
        subscriptions.forEach((d) => d.dispose());
    });
}

const DISABLED_KEY = 'hookDisabledByUser';
const WELCOME_KEY = 'welcomeShown';

/**
 * Zero-setup: installs the user-level hook on first run, and silently rewrites it when it is
 * outdated (e.g. a VS Code update moved the Node binary). Respects an explicit "disable".
 */
async function ensureHook(ctx: vscode.ExtensionContext, installer: HookInstaller): Promise<void> {
    installer.removeLegacyWorkspaceHooks();
    const status = installer.status();
    const auto = vscode.workspace.getConfiguration('liteClaudeDiff').get<boolean>('autoInstallHook', true);
    let installed = status === 'installed';

    if (status === 'outdated' || (status === 'missing' && auto && !ctx.globalState.get(DISABLED_KEY))) {
        installed = await install(installer);
        if (installed && status === 'missing' && !ctx.globalState.get(WELCOME_KEY)) {
            await ctx.globalState.update(WELCOME_KEY, true);
            vscode.window.showInformationMessage(
                'Lite Claude Diff is ready: edits made by Claude Code will appear in Source Control › Claude Changes. ' +
                    'Already-running Claude Code sessions must be restarted.',
            );
        }
    }
    await vscode.commands.executeCommand('setContext', 'liteClaudeDiff.hookInstalled', installed);
}

async function install(installer: HookInstaller): Promise<boolean> {
    try {
        installer.install();
    } catch (err) {
        vscode.window.showErrorMessage(
            `Lite Claude Diff could not update ${installer.settingsPath} (is it valid JSON?): ${(err as Error).message}`,
        );
        return false;
    }
    await vscode.commands.executeCommand('setContext', 'liteClaudeDiff.hookInstalled', true);
    return true;
}

async function jump(tracker: Tracker, direction: 1 | -1): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const file = editor && tracker.get(fsPathOf(editor.document.uri));
    if (!editor || !file || !file.hunks.length) {
        return;
    }
    const line = editor.selection.active.line;
    const starts = file.hunks.map((h) => Math.min(h.curStart, editor.document.lineCount - 1));
    const target =
        direction === 1
            ? starts.find((s) => s > line) ?? starts[0]
            : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
    const pos = new vscode.Position(target, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

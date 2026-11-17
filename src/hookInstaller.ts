import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_DIR, USER_SETTINGS, HookStatus, hookStatus, installHook, removeHook } from './hookSettings';

const HOOK_FILE = 'lite-claude-diff-hook.js';

export { HookStatus };

/**
 * Manages the user-level hook in `~/.claude/settings.json`, so tracking works in every
 * project as soon as the extension is installed. The script is copied to the extension's
 * global storage (stable across extension updates) and run with the extension host's own
 * Node runtime, so no `node` needs to be on Claude Code's PATH.
 */
export class HookInstaller {
    constructor(private readonly ctx: vscode.ExtensionContext) {}

    readonly settingsPath = USER_SETTINGS;

    /** True when Claude Code looks installed for this user (~/.claude exists). */
    claudeInstalled(): boolean {
        return fs.existsSync(CLAUDE_DIR);
    }

    private scriptPath(): string {
        const dir = this.ctx.globalStorageUri.fsPath;
        const target = path.join(dir, HOOK_FILE);
        const src = fs.readFileSync(path.join(this.ctx.extensionPath, 'hook', HOOK_FILE), 'utf8');
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== src) {
            fs.writeFileSync(target, src);
        }
        return target;
    }

    command(): string {
        const slash = (p: string) => p.replace(/\\/g, '/');
        // ELECTRON_RUN_AS_NODE makes the VS Code binary behave as plain Node (ignored by real Node).
        return `ELECTRON_RUN_AS_NODE=1 "${slash(process.execPath)}" "${slash(this.scriptPath())}"`;
    }

    status(): HookStatus {
        return hookStatus(this.command());
    }

    install(): void {
        installHook(this.command());
    }

    uninstall(): void {
        removeHook(USER_SETTINGS);
    }

    /** Removes hooks left by v0.1.0, which installed them per project in .claude/settings.local.json. */
    removeLegacyWorkspaceHooks(): void {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const file = path.join(folder.uri.fsPath, '.claude', 'settings.local.json');
            try {
                removeHook(file);
            } catch {
                /* unreadable: leave it */
            }
        }
    }
}

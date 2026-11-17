/**
 * Read/modify Claude Code settings files. No `vscode` import: this module is also used by
 * the `vscode:uninstall` script, which runs in plain Node after the extension is removed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const HOOK_MARKER = 'lite-claude-diff-hook';
export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const USER_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MATCHER = 'Write|Edit|MultiEdit';
const EVENTS = ['PreToolUse', 'PostToolUse'];

export type HookStatus = 'missing' | 'outdated' | 'installed';

interface HookCommand {
    type: string;
    command?: string;
    timeout?: number;
}
interface MatcherGroup {
    matcher?: string;
    hooks?: HookCommand[];
}
interface ClaudeSettings {
    hooks?: Record<string, MatcherGroup[]>;
    [key: string]: unknown;
}

function read(file: string): ClaudeSettings {
    if (!fs.existsSync(file)) {
        return {};
    }
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? (JSON.parse(raw) as ClaudeSettings) : {};
}

function write(file: string, settings: ClaudeSettings): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

const isOurs = (h: HookCommand) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER);

/** Returns true if something was removed. */
function strip(settings: ClaudeSettings): boolean {
    if (!settings.hooks) {
        return false;
    }
    let changed = false;
    for (const ev of Object.keys(settings.hooks)) {
        const groups = settings.hooks[ev]
            .map((g) => {
                const hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
                changed ||= hooks.length !== (g.hooks ?? []).length;
                return { ...g, hooks };
            })
            .filter((g) => g.hooks.length > 0);
        if (groups.length) {
            settings.hooks[ev] = groups;
        } else {
            delete settings.hooks[ev];
        }
    }
    if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
    }
    return changed;
}

export function hookStatus(expected: string, file = USER_SETTINGS): HookStatus {
    let settings: ClaudeSettings;
    try {
        settings = read(file);
    } catch {
        return 'missing';
    }
    const ours = EVENTS.map((ev) => (settings.hooks?.[ev] ?? []).flatMap((g) => (g.hooks ?? []).filter(isOurs)));
    if (ours.every((h) => h.length === 0)) {
        return 'missing';
    }
    return ours.every((h) => h.length === 1 && h[0].command === expected) ? 'installed' : 'outdated';
}

/** Throws if the settings file exists but is not valid JSON (it is then left untouched). */
export function installHook(command: string, file = USER_SETTINGS): void {
    const settings = read(file);
    strip(settings);
    settings.hooks ??= {};
    for (const ev of EVENTS) {
        (settings.hooks[ev] ??= []).push({ matcher: MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] });
    }
    write(file, settings);
}

export function removeHook(file: string): void {
    if (!fs.existsSync(file)) {
        return;
    }
    const settings = read(file);
    if (strip(settings)) {
        write(file, settings);
    }
}

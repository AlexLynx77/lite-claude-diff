/**
 * Run by VS Code (`vscode:uninstall`) after the extension is fully uninstalled:
 * removes our hook from ~/.claude/settings.json so Claude Code is left clean.
 */
import { USER_SETTINGS, removeHook } from './hookSettings';

try {
    removeHook(USER_SETTINGS);
} catch {
    /* never fail the uninstall */
}

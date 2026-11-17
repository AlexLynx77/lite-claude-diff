#!/usr/bin/env node
/*
 * Lite Claude Diff — Claude Code hook.
 *
 * Registered for PreToolUse and PostToolUse on Write|Edit|MultiEdit.
 *  - PreToolUse: saves the file content as it is *before* Claude touches it
 *    (only if no baseline exists yet, so the oldest unreviewed state is kept).
 *  - PostToolUse: drops the baseline if the tool did not actually change anything.
 *
 * Installed once in ~/.claude/settings.json, so it applies to every project.
 * Baselines go to a single global store (default ~/.lite-claude-diff), keyed by
 * absolute file path; each VS Code window shows the ones inside its workspace.
 *
 * Usage: node lite-claude-diff-hook.js [storeDir]
 * The hook never blocks Claude: it always exits 0 and stays silent.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const MAX_BYTES = 5 * 1024 * 1024;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
    try {
        run(JSON.parse(input));
    } catch (_) {
        // never interfere with Claude Code
    }
    process.exit(0);
});

function run(evt) {
    const toolInput = evt.tool_input || {};
    let filePath = toolInput.file_path;
    if (typeof filePath !== 'string' || !filePath) {
        return;
    }
    const cwd = evt.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    filePath = path.normalize(path.resolve(cwd, filePath));

    const store = path.resolve(process.argv[2] || path.join(os.homedir(), '.lite-claude-diff'));
    if (filePath === store || filePath.startsWith(store + path.sep)) {
        return;
    }
    const dir = path.join(store, 'baselines');
    const id = crypto.createHash('sha1').update(filePath).digest('hex');
    const recordPath = path.join(dir, id + '.json');

    if (evt.hook_event_name === 'PostToolUse') {
        return post(recordPath, filePath);
    }
    if (fs.existsSync(recordPath)) {
        return; // keep the original baseline until the user reviews it
    }
    const current = readFile(filePath);
    if (!current) {
        return; // unreadable / binary / too big
    }
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(recordPath, {
        version: 1,
        filePath,
        existed: current.existed,
        content: current.content,
        pending: true,
        createdAt: new Date().toISOString(),
        tool: evt.tool_name,
        sessionId: evt.session_id,
    });
}

function post(recordPath, filePath) {
    if (!fs.existsSync(recordPath)) {
        return;
    }
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (!record.pending) {
        return;
    }
    const current = readFile(filePath);
    const unchanged = current && (record.existed ? current.existed && current.content === record.content : !current.existed);
    if (unchanged) {
        fs.unlinkSync(recordPath);
    } else {
        record.pending = false;
        writeAtomic(recordPath, record);
    }
}

/** @returns {{existed: boolean, content: string} | null} */
function readFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_BYTES) {
            return null;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('\u0000')) {
            return null;
        }
        return { existed: true, content };
    } catch (err) {
        return err && err.code === 'ENOENT' ? { existed: false, content: '' } : null;
    }
}

function writeAtomic(target, data) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, target);
}

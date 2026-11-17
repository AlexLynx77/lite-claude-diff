/**
 * Minimal line diff (Myers O(ND)) producing change hunks with no context.
 * Lines are produced by splitting on '\n' only, so '\r' stays inside a line
 * and `lines.join('\n')` always rebuilds the exact original text.
 */

export interface Hunk {
    /** 0-based index of the first replaced line in the baseline. */
    baseStart: number;
    /** Baseline lines replaced by this hunk (empty for a pure insertion). */
    baseLines: string[];
    /** 0-based index of the first line of this hunk in the current text. */
    curStart: number;
    /** Current lines introduced by this hunk (empty for a pure deletion). */
    curLines: string[];
}

type Op = 0 | 1 | 2; // 0 = equal, 1 = delete (baseline only), 2 = insert (current only)

/** Above this edit distance we stop searching and emit one big replace hunk. */
const MAX_EDIT_DISTANCE = 4000;

export function splitLines(text: string): string[] {
    return text.split('\n');
}

export function diffLines(base: string[], cur: string[]): Hunk[] {
    let prefix = 0;
    while (prefix < base.length && prefix < cur.length && base[prefix] === cur[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < base.length - prefix &&
        suffix < cur.length - prefix &&
        base[base.length - 1 - suffix] === cur[cur.length - 1 - suffix]
    ) {
        suffix++;
    }
    const a = base.slice(prefix, base.length - suffix);
    const b = cur.slice(prefix, cur.length - suffix);
    const ops = myers(a, b);

    const hunks: Hunk[] = [];
    let i = 0;
    let j = 0;
    let k = 0;
    while (k < ops.length) {
        if (ops[k] === 0) {
            i++;
            j++;
            k++;
            continue;
        }
        const hunk: Hunk = { baseStart: prefix + i, baseLines: [], curStart: prefix + j, curLines: [] };
        while (k < ops.length && ops[k] !== 0) {
            if (ops[k] === 1) {
                hunk.baseLines.push(a[i++]);
            } else {
                hunk.curLines.push(b[j++]);
            }
            k++;
        }
        hunks.push(hunk);
    }
    return hunks;
}

function myers(a: string[], b: string[]): Op[] {
    const n = a.length;
    const m = b.length;
    if (n === 0) {
        return new Array<Op>(m).fill(2);
    }
    if (m === 0) {
        return new Array<Op>(n).fill(1);
    }
    const max = n + m;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] holds the window [-d-1, d+1] of v as it was *before* step d.
    const trace: Int32Array[] = [];

    for (let d = 0; d <= max; d++) {
        if (d > MAX_EDIT_DISTANCE) {
            return [...new Array<Op>(n).fill(1), ...new Array<Op>(m).fill(2)];
        }
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];
            } else {
                x = v[offset + k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                return backtrack(trace, n, m);
            }
        }
    }
    return [];
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
    const ops: Op[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const at = (k: number) => v[k + d + 1];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            ops.push(0);
            x--;
            y--;
        }
        if (d > 0) {
            ops.push(x === prevX ? 2 : 1);
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}

/** Returns a copy of `lines` where `count` lines at `start` are replaced by `insert`. */
export function spliceLines(lines: string[], start: number, count: number, insert: string[]): string[] {
    const copy = lines.slice();
    copy.splice(start, count, ...insert);
    return copy;
}

export function sameHunk(a: Hunk, b: Hunk): boolean {
    return (
        a.baseStart === b.baseStart &&
        a.curStart === b.curStart &&
        a.baseLines.length === b.baseLines.length &&
        a.curLines.length === b.curLines.length &&
        a.baseLines.every((l, i) => l === b.baseLines[i]) &&
        a.curLines.every((l, i) => l === b.curLines[i])
    );
}

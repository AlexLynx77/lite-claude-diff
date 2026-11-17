import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { diffLines, spliceLines, splitLines } from '../diff';

function check(before: string, after: string): void {
    const a = splitLines(before);
    const b = splitLines(after);
    const hunks = diffLines(a, b);
    // Accepting every hunk on the baseline (from last to first) must give the current text.
    let base = a;
    for (const h of [...hunks].reverse()) {
        base = spliceLines(base, h.baseStart, h.baseLines.length, h.curLines);
    }
    assert.equal(base.join('\n'), after);
    // Rejecting every hunk on the current text must give the baseline.
    let cur = b;
    for (const h of [...hunks].reverse()) {
        cur = spliceLines(cur, h.curStart, h.curLines.length, h.baseLines);
    }
    assert.equal(cur.join('\n'), before);
}

test('identical texts have no hunks', () => {
    assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), []);
});

test('insertion, deletion and modification', () => {
    const hunks = diffLines(['a', 'b', 'c', 'd'], ['a', 'X', 'c', 'd', 'e']);
    assert.deepEqual(hunks, [
        { baseStart: 1, baseLines: ['b'], curStart: 1, curLines: ['X'] },
        { baseStart: 4, baseLines: [], curStart: 4, curLines: ['e'] },
    ]);
});

test('round trips', () => {
    check('', 'hello\n');
    check('hello\n', '');
    check('a\nb\nc\n', 'a\nc\n');
    check('a\r\nb\r\n', 'a\r\nB\r\nc\r\n');
    check('1\n2\n3\n4\n5\n6\n7\n8\n', '0\n1\n3\n4\nx\ny\n7\n8\n9');
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const changed = big.map((l, i) => (i % 7 === 0 ? l + ' changed' : l)).filter((_, i) => i % 11 !== 0);
    check(big.join('\n'), changed.join('\n'));
});

test('completely different large files fall back gracefully', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n');
    check(a, b);
});

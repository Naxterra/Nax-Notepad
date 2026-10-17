// Line diff (Myers' O(ND) algorithm) for the compare view.

/** A changed region: lines [a0, a1) of the left text became lines [b0, b1) of the right. */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/**
 * Differences between two line arrays. Common prefix and suffix are skipped first; if the
 * remaining texts differ in more than `maxD` lines the middle is reported as one change.
 */
export function diffLines(a: string[], b: string[], maxD = 2000): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const A = a.slice(pre, a.length - suf).map(id);
  const B = b.slice(pre, b.length - suf).map(id);
  const N = A.length;
  const M = B.length;
  if (N === 0 && M === 0) return [];
  const whole = [{ a0: pre, a1: pre + N, b0: pre, b1: pre + M }];
  if (N === 0 || M === 0) return whole;

  const max = N + M;
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(V.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return whole;

  // Walk back through the trace to recover the edit script (reversed).
  const ops: number[] = []; // 0 = same, 1 = delete from A, 2 = insert from B
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const get = (k: number) => prev[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(2);
      y--;
    } else {
      ops.push(1);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  ops.reverse();

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op === 0) {
      if (cur) hunks.push(cur);
      cur = null;
      i++;
      j++;
      continue;
    }
    if (!cur) cur = { a0: pre + i, a1: pre + i, b0: pre + j, b1: pre + j };
    if (op === 1) cur.a1 = pre + ++i;
    else cur.b1 = pre + ++j;
  }
  if (cur) hunks.push(cur);
  return hunks;
}

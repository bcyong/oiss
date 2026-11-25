/** A minimal discrete-event scheduler: a binary heap ordered by time, then by insertion order, so runs are deterministic. */
export class Scheduler {
  private heap: { t: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  now = 0;

  at(t: number, fn: () => void): void {
    if (t < this.now) t = this.now;
    this.heap.push({ t, seq: this.seq++, fn });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  after(dt: number, fn: () => void): void {
    this.at(this.now + dt, fn);
  }

  run(until = Infinity): void {
    while (this.heap.length > 0 && this.heap[0]!.t <= until) {
      const top = this.heap[0]!;
      const last = this.heap.pop()!;
      if (this.heap.length > 0) {
        this.heap[0] = last;
        this.sink(0);
      }
      this.now = top.t;
      top.fn();
    }
  }

  get size(): number {
    return this.heap.length;
  }

  private less(a: number, b: number): boolean {
    const x = this.heap[a]!, y = this.heap[b]!;
    return x.t < y.t || (x.t === y.t && x.seq < y.seq);
  }

  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
  }

  private sink(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}

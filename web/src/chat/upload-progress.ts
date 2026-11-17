// How far the files going up are (spec, section 8.9; the owner, 17.11: «прогресс… никуда не двигается»):
// the share of each file sent, and of all the bytes of the batch — the files given since the queue was
// last empty. It lives apart from the state of the queue and tells only those who listen: the share
// moves many times a second, and only the rings that show it are drawn anew, not the chips around them.

export class UploadProgress {
  // Bytes of each file of the batch still going up, and how many of them are sent.
  private readonly size = new Map<number, number>();
  private readonly sentOf = new Map<number, number>();
  // Bytes of the batch: all of them, and those of the files already up (or refused on the way).
  private total = 0;
  private done = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private tell(): void {
    for (const listener of this.listeners) listener();
  }

  // A new batch: the queue was empty.
  begin(): void {
    this.size.clear();
    this.sentOf.clear();
    this.total = 0;
    this.done = 0;
    this.tell();
  }

  add(id: number, bytes: number): void {
    this.size.set(id, bytes);
    this.sentOf.set(id, 0);
    this.total += bytes;
    this.tell();
  }

  // Bytes of the file sent so far; the share never goes back.
  sent(id: number, bytes: number): void {
    const size = this.size.get(id);
    if (size === undefined) return;
    const now = Math.max(this.sentOf.get(id) ?? 0, Math.min(bytes, size));
    if (now === this.sentOf.get(id)) return;
    this.sentOf.set(id, now);
    this.tell();
  }

  // The file is up, or will not go: its bytes are done either way.
  finish(id: number): void {
    const size = this.size.get(id);
    if (size === undefined) return;
    this.done += size;
    this.size.delete(id);
    this.sentOf.delete(id);
    this.tell();
  }

  fileShare(id: number): number {
    const size = this.size.get(id);
    return size ? (this.sentOf.get(id) ?? 0) / size : 0;
  }

  batchShare(): number {
    if (this.total === 0) return 0;
    let going = 0;
    for (const sent of this.sentOf.values()) going += sent;
    return Math.min(1, (this.done + going) / this.total);
  }
}

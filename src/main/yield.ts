import type { Phase } from '../shared/messages.ts';

export class ScanCancelled extends Error {
  constructor() {
    super('Scan cancelled');
    this.name = 'ScanCancelled';
  }
}

export interface Progress {
  phase: Phase;
  done: number;
  total: number;
  label: string;
}

/**
 * Yields control back to the event loop periodically during long traversals.
 *
 * The Figma main thread is single-threaded: a blocking loop freezes the entire
 * editor, not just the plugin. The `setTimeout(0)` is also what allows an
 * incoming CANCEL message to be delivered — polling a flag without yielding
 * would never see it change.
 */
export class ScanControl {
  cancelled = false;
  private sinceLastYield = 0;

  constructor(
    private readonly onProgress: (progress: Progress) => void,
    private readonly every = 250,
  ) {}

  async tick(phase: Phase, done: number, total: number, label: string): Promise<void> {
    this.sinceLastYield++;
    if (this.sinceLastYield < this.every) return;
    this.sinceLastYield = 0;

    this.onProgress({ phase, done, total, label });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (this.cancelled) throw new ScanCancelled();
  }

  /** Force a progress emission and yield, regardless of the counter. */
  async flush(phase: Phase, done: number, total: number, label: string): Promise<void> {
    this.sinceLastYield = 0;
    this.onProgress({ phase, done, total, label });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (this.cancelled) throw new ScanCancelled();
  }
}

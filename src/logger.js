// In-memory ring buffer of gaze samples + CSV export.
// Row shape (built by main.js):
// { t, epoch, rawX, rawY, smoothX, smoothY, confidence,
//   fixationState, fixationDurationMs, hasFace }
// Dropped frames (no prediction) are logged with nulls and state 'lost'.
export class GazeLogger {
  constructor({ bufferSize = 600, consoleLog = false } = {}) {
    this.bufferSize = bufferSize;
    this.consoleLog = consoleLog;
    this.samples = [];
    this.subscribers = new Set();
    this.dropped = 0;
  }

  subscribe(cb) {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  log(row) {
    if (row.rawX == null) this.dropped += 1;
    this.samples.push(row);
    if (this.samples.length > this.bufferSize) {
      this.samples.splice(0, this.samples.length - this.bufferSize);
    }
    if (this.consoleLog) console.log('[gaze]', row);
    for (const cb of this.subscribers) {
      try {
        cb(row);
      } catch (err) {
        console.error('logger subscriber error', err);
      }
    }
  }

  clear() {
    this.samples = [];
    this.dropped = 0;
  }

  get count() {
    return this.samples.length;
  }

  toCSV() {
    const header =
      'epoch,t,rawX,rawY,smoothX,smoothY,confidence,' +
      'fixationState,fixationDurationMs,hasFace';
    const fmt = (v) =>
      v == null ? '' : typeof v === 'number' ? v.toFixed(1) : String(v);
    const lines = this.samples.map((r) =>
      [
        r.epoch, r.t, r.rawX, r.rawY, r.smoothX, r.smoothY, r.confidence,
        r.fixationState, r.fixationDurationMs, r.hasFace ? 1 : 0,
      ].map(fmt).join(','),
    );
    return `${header}\n${lines.join('\n')}\n`;
  }

  download(filename = `gaze-log-${Date.now()}.csv`) {
    const blob = new Blob([this.toCSV()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
}

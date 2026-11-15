import { PassThrough, Writable } from "node:stream";

/**
 * A terminal drawn somewhere other than this process's own (xterm.js in an Electron window, say): streams
 * that look enough like a TTY for Ink to draw into and read keys from. What Ink draws goes to `onOutput`;
 * keys typed there come in through input(), and the far side's size through resize().
 */
export class RemoteTerminal {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;

  constructor(onOutput: (data: string) => void, { columns = 120, rows = 40 } = {}) {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        stdin.isRaw = mode;
        return stdin;
      },
      ref: () => stdin,
      unref: () => stdin,
    });
    const stdout = Object.assign(
      new Writable({
        decodeStrings: false,
        write(chunk: string | Buffer, _encoding, done) {
          onOutput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
          done();
        },
      }),
      { isTTY: true, columns, rows, getColorDepth: () => 24, hasColors: () => true },
    );
    this.stdin = stdin as unknown as NodeJS.ReadStream;
    this.stdout = stdout as unknown as NodeJS.WriteStream;
  }

  /** Keys typed in the terminal, as the terminal sends them (escape sequences and all). */
  input(data: string): void {
    this.stdin.push(data);
  }

  resize(columns: number, rows: number): void {
    if (!(columns > 0 && rows > 0)) return;
    if (columns === this.stdout.columns && rows === this.stdout.rows) return;
    Object.assign(this.stdout, { columns, rows });
    this.stdout.emit("resize");
  }
}

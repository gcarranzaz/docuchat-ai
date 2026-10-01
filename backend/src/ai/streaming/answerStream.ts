/**
 * Incremental extraction of the `answer` field from a streamed JSON reply
 * =======================================================================
 * The model is asked for a JSON object ({ "answer": "...", "citations": [...], ... }).
 * Showing that JSON token by token would be unreadable, so while it streams we pull
 * out only the characters inside the "answer" string and send those to the user.
 *
 * What the user sees while streaming is a DRAFT: the full reply is still validated
 * against the schema when it ends (ai/postprocessing/chatOutput.ts), and the final
 * `result` event replaces the draft. If validation fails the draft is discarded.
 *
 * A small state machine rather than a regex, because the text arrives in arbitrary
 * pieces: an escape like \n or é can be split between two chunks, and the word
 * "answer" can appear inside another field's value.
 */

type State = 'search' | 'value' | 'done';

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

export class AnswerStreamExtractor {
  private state: State = 'search';
  private buffer = '';
  private escape = '';
  private pendingHighSurrogate: string | null = null;

  /** True once the closing quote of the answer has been seen */
  get done(): boolean {
    return this.state === 'done';
  }

  /** Feed the next piece of the stream; returns the new answer text it contains (may be empty) */
  push(chunk: string): string {
    let out = '';

    for (const ch of chunk) {
      if (this.state === 'done') break;

      if (this.state === 'search') {
        this.buffer += ch;
        if (this.sawAnswerKey()) {
          this.state = 'value';
          this.buffer = '';
        } else if (this.buffer.length > 4096) {
          // Never found it in a long prefix: keep memory bounded, keep the tail
          this.buffer = this.buffer.slice(-64);
        }
        continue;
      }

      out += this.consumeValueChar(ch);
    }

    return out;
  }

  /**
   * Looking for `"answer"` followed by `:` and the opening quote of its value.
   * A key is only a key when it is followed by a colon, so "answer" appearing as
   * text inside another string value does not count... unless that text is itself
   * followed by `: "`, which a real key always is. Values written by the model
   * escape their quotes (\"answer\"), and the preceding backslash rules those out.
   */
  private sawAnswerKey(): boolean {
    const match = /(^|[^\\])"answer"\s*:\s*"$/.exec(this.buffer);
    return match !== null;
  }

  private consumeValueChar(ch: string): string {
    // Inside an escape sequence
    if (this.escape !== '') {
      this.escape += ch;

      if (this.escape[1] === 'u') {
        if (this.escape.length < 6) return ''; // wait for the 4 hex digits
        const code = parseInt(this.escape.slice(2), 16);
        this.escape = '';
        if (Number.isNaN(code)) return '';
        return this.emitCodeUnit(code);
      }

      const decoded = ESCAPES[ch];
      this.escape = '';
      return decoded ?? '';
    }

    if (ch === '\\') {
      this.escape = '\\';
      return '';
    }
    if (ch === '"') {
      this.state = 'done';
      return '';
    }
    return this.flushSurrogate() + ch;
  }

  /** 😀 arrives as two escapes; hold the first half until the second arrives */
  private emitCodeUnit(code: number): string {
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;

    if (isHigh) {
      const previous = this.flushSurrogate();
      this.pendingHighSurrogate = String.fromCharCode(code);
      return previous;
    }
    if (isLow && this.pendingHighSurrogate !== null) {
      const pair = this.pendingHighSurrogate + String.fromCharCode(code);
      this.pendingHighSurrogate = null;
      return pair;
    }
    return this.flushSurrogate() + String.fromCharCode(code);
  }

  private flushSurrogate(): string {
    if (this.pendingHighSurrogate === null) return '';
    const lone = this.pendingHighSurrogate;
    this.pendingHighSurrogate = null;
    return lone;
  }
}

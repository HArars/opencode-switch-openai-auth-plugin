export class Operation {
  private controller = new AbortController()
  readonly signal = this.controller.signal
  private stop = () => this.cancel()
  constructor(private parent: AbortSignal) {
    if (parent.aborted) this.cancel()
    else parent.addEventListener("abort", this.stop, { once: true })
  }
  get active() { return !this.signal.aborted }
  check() { this.signal.throwIfAborted() }
  cancel() { this.controller.abort(new DOMException("Cancelled", "AbortError")) }
  dispose() { this.parent.removeEventListener("abort", this.stop) }
}

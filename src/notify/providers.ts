import { NotifierError } from './types.ts';
import type { Channel, Notifier, OutboundMessage } from './types.ts';

/** Records what it was asked to send; can be told to fail. For tests. */
export class FakeNotifier implements Notifier {
  readonly sent: OutboundMessage[] = [];
  private next: Error[] = [];
  private always: Error | null = null;
  private counter = 0;

  constructor(readonly channel: Channel) {}

  failNext(err: Error = new NotifierError('fake failure')): void {
    this.next.push(err);
  }

  failAll(err: Error = new NotifierError('fake failure')): void {
    this.always = err;
  }

  async send(message: OutboundMessage): Promise<{ providerRef: string }> {
    const failure = this.next.shift() ?? this.always;
    if (failure) throw failure;
    this.sent.push(message);
    return { providerRef: `fake-${this.channel}-${++this.counter}` };
  }
}

/**
 * Stub for a real provider: logs one redacted line and sends nothing. The address is masked to its last two
 * characters and the subject and text are never logged, only their length.
 */
export class LoggingNotifier implements Notifier {
  constructor(
    readonly channel: Channel,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  async send(message: OutboundMessage): Promise<{ providerRef: string }> {
    const tail = message.to.slice(-2);
    this.log(`[notify:${this.channel}] to=***${tail} chars=${message.text.length} key=${message.idempotencyKey}`);
    return { providerRef: `log-${message.idempotencyKey.slice(0, 40)}` };
  }
}

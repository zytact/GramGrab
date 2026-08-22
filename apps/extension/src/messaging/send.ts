import { browser } from '../lib/browser.ts';
import type { BackgroundMessageType, MessageOf, MessageResponse } from './contracts.ts';

type Answerable = MessageOf<BackgroundMessageType>;
type Notification = MessageOf<'RUNNER_READY' | 'RUNNER_PROGRESS'>;

interface MessageSender {
  sendMessage: (message: unknown) => Promise<unknown>;
}

/**
 * Ask the background worker, with the response type correlated to the request.
 *
 * The assertion here is the one place a response is given its declared type. Nothing decodes
 * responses at runtime: the contract is enforced where the handler is written, so an older
 * receiver's answer is trusted rather than re-validated against a newer sender's expectations.
 */
export function sendMessage<M extends Answerable>(
  message: M,
  sender: MessageSender = browser.runtime
): Promise<MessageResponse<M['type']>> {
  return sender.sendMessage(message) as Promise<MessageResponse<M['type']>>;
}

/** Ask the runner document, with the response type correlated to the request. */
export function sendTabMessage<M extends MessageOf<'RUN_EXPORT'>>(
  tabId: number,
  message: M
): Promise<MessageResponse<M['type']>> {
  return browser.tabs.sendMessage(tabId, message) as Promise<MessageResponse<M['type']>>;
}

/** Tell the background worker something it never answers. */
export function notify(message: Notification): void {
  void browser.runtime.sendMessage(message);
}

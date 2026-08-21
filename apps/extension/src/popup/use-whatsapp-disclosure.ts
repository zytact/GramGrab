import { useCallback, useEffect, useState } from 'react';
import { browser } from '../lib/browser';
import { WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY } from '../whatsapp/disclosure';

export type WhatsAppDisclosureState = 'checking' | 'required' | 'dismissed' | 'acknowledged';

/** The one-time view-receipt notice, backed by extension storage. */
export function useWhatsAppDisclosure({
  eligible,
  onAcknowledgeFailed,
}: {
  eligible: boolean;
  onAcknowledgeFailed: () => void;
}) {
  const [disclosure, setDisclosure] = useState<WhatsAppDisclosureState>('checking');

  useEffect(() => {
    let cancelled = false;
    setDisclosure('checking');
    if (!eligible)
      return () => {
        cancelled = true;
      };
    void browser.storage
      .get(WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY)
      .then(stored => {
        if (!cancelled)
          setDisclosure(
            stored[WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY] === true ? 'acknowledged' : 'required'
          );
      })
      .catch(() => {
        if (!cancelled) setDisclosure('required');
      });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  const acknowledge = useCallback(async () => {
    try {
      await browser.storage.set({ [WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY]: true });
      setDisclosure('acknowledged');
    } catch {
      onAcknowledgeFailed();
    }
  }, [onAcknowledgeFailed]);

  return {
    disclosure,
    acknowledge,
    require: useCallback(() => setDisclosure('required'), []),
    dismiss: useCallback(() => setDisclosure('dismissed'), []),
  };
}

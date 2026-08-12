import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@open-design/components';

import { useT } from '../i18n';
import {
  cancelVelaLogin,
  fetchVelaLoginStatus,
  startVelaLogin,
} from '../providers/daemon';
import {
  AMR_LOGIN_POLL_INTERVAL_MS,
  amrLoginPollOutcome,
  notifyAmrLoginStatusChanged,
} from './amrLoginPolling';
import {
  notifyTeamProjectsChanged,
  notifyWorkspaceBillingRefresh,
  notifyWorkspaceContextRefresh,
} from '../collab/useWorkspaceContext';
import styles from './AmrAuthExpiredDialog.module.css';

export function AmrAuthExpiredDialog({
  onDismiss,
  onSignedIn,
}: {
  onDismiss: () => void;
  onSignedIn: (status: NonNullable<Awaited<ReturnType<typeof fetchVelaLoginStatus>>>) => void;
}) {
  const t = useT();
  const titleId = useId();
  const descriptionId = useId();
  const cancelledRef = useRef(false);
  const [state, setState] = useState<'idle' | 'signing' | 'error'>('idle');

  async function signIn() {
    if (state === 'signing') return;
    cancelledRef.current = false;
    setState('signing');
    const result = await startVelaLogin();
    if (cancelledRef.current) return;
    if (!result.ok && !result.alreadyRunning) {
      setState('error');
      return;
    }
    const startedAt = Date.now();
    while (!cancelledRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, AMR_LOGIN_POLL_INTERVAL_MS));
      if (cancelledRef.current) return;
      const next = await fetchVelaLoginStatus();
      const outcome = amrLoginPollOutcome(next, startedAt);
      if (outcome === 'signed-in') {
        notifyAmrLoginStatusChanged();
        notifyWorkspaceContextRefresh();
        notifyWorkspaceBillingRefresh();
        notifyTeamProjectsChanged();
        if (next) onSignedIn(next);
        return;
      }
      if (outcome === 'stopped' || outcome === 'timed-out') {
        if (outcome === 'timed-out') void cancelVelaLogin();
        setState('error');
        return;
      }
    }
  }

  function dismiss() {
    cancelledRef.current = true;
    onDismiss();
  }

  const dialog = (
    <Dialog
      className={styles.dialog}
      backdropClassName={`${styles.backdrop} modal-backdrop--no-blur`}
      role="alertdialog"
      onClose={dismiss}
      closeOnEscape
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
      data-testid="amr-auth-expired-dialog"
    >
      <DialogTitle id={titleId}>{t('entry.authExpiredTitle')}</DialogTitle>
      <DialogDescription id={descriptionId} className={styles.description}>
        {t('entry.authExpiredBody')}
      </DialogDescription>
      {state !== 'idle' ? (
        <p
          className={`${styles.status}${state === 'error' ? ` ${styles.error}` : ''}`}
          role={state === 'error' ? 'alert' : 'status'}
        >
          {state === 'error'
            ? t('settings.amrLoginErrorCompact')
            : t('settings.amrSigningIn')}
        </p>
      ) : null}
      <DialogFooter>
        <Button onClick={dismiss} disabled={state === 'signing'}>
          {t('entry.authExpiredLater')}
        </Button>
        <Button variant="primary" onClick={() => void signIn()} disabled={state === 'signing'}>
          {t('settings.amrLogin')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

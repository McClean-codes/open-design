import { useEffect, useRef } from 'react';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import styles from './AmrDialogDemoControl.module.css';

export type AmrDialogDemoKind = 'balance' | 'low-balance' | 'artifact-upgrade';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (kind: AmrDialogDemoKind) => void;
}

const DEMO_DIALOGS: ReadonlyArray<{
  kind: AmrDialogDemoKind;
  title: string;
  description: string;
}> = [
  {
    kind: 'balance',
    title: 'Insufficient balance',
    description: 'Hard gate before generation',
  },
  {
    kind: 'low-balance',
    title: 'Low balance',
    description: 'Warning with a continue action',
  },
  {
    kind: 'artifact-upgrade',
    title: 'Artifact upgrade',
    description: 'Upsell after a successful result',
  },
];

/** Development-only launcher for reviewing the three AMR entitlement dialogs. */
export function AmrDialogDemoControl({ open, onOpenChange, onOpen }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onOpenChange, open]);

  return (
    <div ref={rootRef} className={styles.root} data-testid="amr-dialog-demo-control">
      <Button
        variant="ghost"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
      >
        <span className={styles.statusDot} aria-hidden />
        <span>Demo</span>
        <Icon name="chevron-down" size={12} />
      </Button>

      {open ? (
        <div className={styles.menu} role="menu" aria-label="Dialog demos">
          <div className={styles.header}>
            <span className={styles.eyebrow}>Open Design Cloud</span>
            <strong>Dialog states</strong>
          </div>
          <div className={styles.options}>
            {DEMO_DIALOGS.map((dialog, index) => (
              <Button
                key={dialog.kind}
                variant="ghost"
                className={styles.option}
                role="menuitem"
                aria-label={dialog.title}
                onClick={() => {
                  onOpenChange(false);
                  onOpen(dialog.kind);
                }}
              >
                <span className={styles.optionIndex} aria-hidden>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className={styles.optionCopy}>
                  <strong>{dialog.title}</strong>
                  <span>{dialog.description}</span>
                </span>
                <Icon name="arrow-right" size={13} />
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

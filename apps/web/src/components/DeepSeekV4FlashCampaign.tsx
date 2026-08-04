import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog } from '@open-design/components';
import {
  DEEPSEEK_V4_FLASH_CAMPAIGN as campaign,
  DEEPSEEK_V4_FLASH_CAMPAIGN_REVIEW_PARAM,
  formatDeepSeekV4FlashCampaignCountdown,
  type DeepSeekV4FlashCampaignAudience,
} from '../campaigns/deepseek-v4-flash';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import {
  amrPlansUrlForProfile,
  amrPlansUrlForWorkspace,
} from '../runtime/amr-guidance';
import styles from './DeepSeekV4FlashCampaign.module.css';

const SEEN_KEY = `open-design:campaign-seen:${campaign.id}`;

interface Props {
  audience: DeepSeekV4FlashCampaignAudience;
}

function shouldForceCampaignReview(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('campaign')
    === DEEPSEEK_V4_FLASH_CAMPAIGN_REVIEW_PARAM;
}

function hasSeenCampaign(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markCampaignSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Campaign frequency control is advisory; storage failures must not block Home.
  }
}

function focusModelSwitcher(): void {
  const chip = document.querySelector<HTMLButtonElement>(
    '[data-testid="inline-model-switcher-chip"]',
  );
  if (!chip) return;
  chip.click();
  chip.setAttribute('data-campaign-highlight', 'true');
  window.setTimeout(() => chip.removeAttribute('data-campaign-highlight'), 1_500);
}

export function DeepSeekV4FlashCampaign({ audience }: Props) {
  const { context: workspaceContext } = useWorkspaceContext();
  const [modalOpen, setModalOpen] = useState(false);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (audience === 'unknown') return;
    if (shouldForceCampaignReview() || !hasSeenCampaign()) setModalOpen(true);
  }, [audience]);

  useEffect(() => {
    if (!modalOpen) return;
    const panel = document.getElementById(dialogId);
    if (!panel) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [audience, dialogId, modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    setCountdownNow(Date.now());
    const countdownTimer = window.setInterval(() => setCountdownNow(Date.now()), 1_000);
    return () => window.clearInterval(countdownTimer);
  }, [modalOpen]);

  const closeModal = () => {
    markCampaignSeen();
    setModalOpen(false);
  };

  const paid = audience === 'paid';
  const presentation = paid ? campaign.paid : campaign.unpaid;
  const takeAction = () => {
    closeModal();
    if (paid) {
      window.setTimeout(focusModelSwitcher, 0);
      return;
    }
    const plansUrl =
      amrPlansUrlForWorkspace(undefined, workspaceContext?.workspaceId)
      ?? amrPlansUrlForProfile(undefined);
    window.open(plansUrl, '_blank', 'noopener,noreferrer');
  };

  if (!modalOpen || audience === 'unknown' || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <Dialog
      id={dialogId}
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
      onClose={closeModal}
      closeOnEscape
      className={styles.panel}
      backdropClassName={styles.backdrop}
      data-testid="deepseek-v4-flash-campaign-dialog"
    >
      <img
        alt=""
        className={styles.cover}
        data-testid="deepseek-v4-flash-campaign-cover"
        src="/campaigns/deepseek-v4-flash-free-week-poster-v3.png"
      />

      <div className={styles.content}>
        <p className={styles.eyebrow}>{presentation.eyebrow}</p>
        <h2 id={titleId} className={styles.title}>{campaign.headline}</h2>
        <p id={descriptionId} className={styles.lead}>{campaign.description}</p>

        <div className={styles.modelCard}>
          <span className={styles.modelMark} aria-hidden="true">
            <img alt="" src="/agent-icons/deepseek.svg" />
          </span>
          <span className={styles.modelCopy}>
            <strong>{campaign.benefit}</strong>
            <small>{presentation.status}</small>
          </span>
          <span className={paid ? styles.available : styles.locked}>
            {paid ? '已解锁' : '待解锁'}
          </span>
        </div>

        <div className={styles.countdown} aria-label="活动倒计时">
          <span className={styles.countdownLabel}>活动倒计时</span>
          <strong data-testid="deepseek-v4-flash-campaign-countdown">
            {formatDeepSeekV4FlashCampaignCountdown(countdownNow)}
          </strong>
          <small>{campaign.window.label} · 一周免费用</small>
        </div>

        <p className={styles.boundary}>{campaign.boundary}</p>
      </div>

      <div className={styles.footer}>
        <Button className={styles.dismissAction} onClick={closeModal}>
          {paid ? '稍后再说' : '关闭'}
        </Button>
        <Button variant="primary" className={styles.primaryAction} onClick={takeAction}>
          {presentation.cta}
        </Button>
      </div>
    </Dialog>,
    document.body,
  );
}

import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import {
  DEEPSEEK_V4_FLASH_CAMPAIGN as campaign,
  DEEPSEEK_V4_FLASH_CAMPAIGN_REVIEW_PARAM,
} from '../campaigns/deepseek-v4-flash';
import styles from './DeepSeekV4FlashCampaign.module.css';

const SEEN_KEY = `open-design:campaign-seen:${campaign.id}`;

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
  document.querySelector<HTMLButtonElement>('[data-testid="inline-model-switcher-chip"]')?.click();
}

export function DeepSeekV4FlashCampaign() {
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (shouldForceCampaignReview() || !hasSeenCampaign()) setModalOpen(true);
  }, []);

  const closeModal = () => {
    markCampaignSeen();
    setModalOpen(false);
  };

  const start = () => {
    closeModal();
    window.setTimeout(focusModelSwitcher, 0);
  };

  return (
    <>
      <section className={styles.banner} aria-label="DeepSeek V4 Flash 活动">
        <span className={styles.badge}>{campaign.badge}</span>
        <div className={styles.bannerCopy}>
          <strong>{campaign.headline}</strong>
          <span>{campaign.description}</span>
        </div>
        <span className={styles.timing}>{campaign.timing}</span>
        <Button onClick={focusModelSwitcher}>{campaign.cta}</Button>
      </section>

      <div className={`${styles.modalRoot}${modalOpen ? ` ${styles.modalOpen}` : ''}`} aria-hidden={!modalOpen}>
        <button className={styles.backdrop} type="button" aria-label="关闭活动弹窗" onClick={closeModal} />
        <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="deepseek-campaign-title">
          <button className={styles.close} type="button" aria-label="关闭" onClick={closeModal}>×</button>
          <div className={styles.modalBadge}>{campaign.badge}</div>
          <h2 id="deepseek-campaign-title">{campaign.headline}</h2>
          <p className={styles.lead}>{campaign.description}</p>
          <div className={styles.modelCard}>
            <span className={styles.modelMark}>DS</span>
            <span><strong>DeepSeek V4 Flash</strong><small>{campaign.timing}</small></span>
            <span className={styles.free}>免费</span>
          </div>
          <p className={styles.boundary}>{campaign.boundary}</p>
          <div className={styles.actions}>
            <Button onClick={start}>{campaign.cta}</Button>
            <Button variant="ghost" onClick={closeModal}>先逛逛</Button>
          </div>
        </section>
      </div>
    </>
  );
}

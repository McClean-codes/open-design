import { useEffect, useState } from 'react';
import type { BrandSummary, WorkspaceCollabContext } from '@open-design/contracts';
import { useT } from '../i18n';
import { fetchDesignSystem } from '../providers/registry';
import {
  brandSummaryToKit,
  useDesignKit,
} from '../runtime/design-kit';
import type { DesignSystemDetail, DesignSystemSummary } from '../types';
import { DesignKitView } from './DesignKitView';
import {
  designSystemLogoHost,
  isUserSystem,
} from './design-system-metadata';
import {
  useWorkspaceContext,
  workspaceResourceReadContext,
} from '../collab/useWorkspaceContext';

interface DesignSystemKitPreviewProps {
  system: DesignSystemSummary;
  brandSummary?: BrandSummary | null;
  variant?: 'panel' | 'compact';
  showCover?: boolean;
  className?: string;
  dataTestId?: string;
  workspaceContext?: WorkspaceCollabContext | null;
}

export function DesignSystemKitPreview({
  system,
  brandSummary,
  variant = 'panel',
  showCover = false,
  className,
  dataTestId = 'design-system-kit-preview',
  workspaceContext,
}: DesignSystemKitPreviewProps) {
  if (brandSummary) {
    return (
      <BrandDesignSystemKitPreview
        summary={brandSummary}
        variant={variant}
        showCover={showCover}
        className={className}
        dataTestId={dataTestId}
        workspaceContext={workspaceContext}
      />
    );
  }

  return (
    <RegistryDesignSystemKitPreview
      system={system}
      variant={variant}
      showCover={showCover}
      className={className}
      dataTestId={dataTestId}
      workspaceContext={workspaceContext}
    />
  );
}

function BrandDesignSystemKitPreview({
  summary,
  variant,
  showCover,
  className,
  dataTestId,
  workspaceContext: explicitWorkspaceContext,
}: {
  summary: BrandSummary;
  variant: 'panel' | 'compact';
  showCover: boolean;
  className?: string;
  dataTestId: string;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const ambientWorkspaceContext = workspaceResourceReadContext(useWorkspaceContext());
  const workspaceContext = explicitWorkspaceContext === undefined
    ? ambientWorkspaceContext
    : explicitWorkspaceContext;
  const kit = brandSummaryToKit(summary, workspaceContext);
  return (
    <div className={className} data-testid={dataTestId}>
      <DesignKitView
        kit={kit}
        variant={variant}
        showCover={showCover}
        dataTestId={`${dataTestId}-view`}
        workspaceContext={workspaceContext}
      />
    </div>
  );
}

function RegistryDesignSystemKitPreview({
  system,
  variant,
  showCover,
  className,
  dataTestId,
  workspaceContext: explicitWorkspaceContext,
}: {
  system: DesignSystemSummary;
  variant: 'panel' | 'compact';
  showCover: boolean;
  className?: string;
  dataTestId: string;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const t = useT();
  const ambientWorkspaceContext = workspaceResourceReadContext(useWorkspaceContext());
  const workspaceContext = explicitWorkspaceContext === undefined
    ? ambientWorkspaceContext
    : explicitWorkspaceContext;
  const [detail, setDetail] = useState<DesignSystemDetail | null>(null);
  const [detailResolved, setDetailResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailResolved(false);
    void fetchDesignSystem(system.id, workspaceContext)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setDetailResolved(true);
      })
      .catch(() => {
        if (!cancelled) setDetailResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [system.id, workspaceContext]);

  const projectId = detail?.projectId ?? system.projectId;
  const host = designSystemLogoHost(system) || undefined;
  const { kit, loading } = useDesignKit({
    designSystemId: system.id,
    title: system.title,
    projectId,
    body: detail?.body,
    packageInfo: detail?.packageInfo,
    swatches: system.swatches,
    showcaseHtml: null,
    editable: isUserSystem(system),
    host,
    workspaceContext,
  });

  const pending = !detailResolved || loading || !kit;

  return (
    <div className={className} data-testid={dataTestId}>
      {pending ? (
        <div
          className="design-system-kit-preview-loading"
          role="status"
          aria-busy="true"
          data-testid={`${dataTestId}-loading`}
        >
          {t('designSystemPicker.loadingPreview')}
        </div>
      ) : (
        <DesignKitView
          kit={kit}
          workspaceContext={workspaceContext}
          variant={variant}
          showCover={showCover}
          dataTestId={`${dataTestId}-view`}
        />
      )}
    </div>
  );
}

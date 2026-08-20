'use client';

import {
  PIPELINE_STAGE_STYLES,
  normalizePipelineStage,
} from '@/lib/pipeline';

type Lead = {
  id: number;
  clientFirstName: string;
  clientLastName: string;
  clientAddress: string;
  category: string;
};

type Props = {
  lead: Lead;
  showStage: boolean;
  onOpen: () => void;
};

export default function PipelineSwipeRow({ lead, showStage, onOpen }: Props) {
  const stage = normalizePipelineStage(lead.category);
  const styles = PIPELINE_STAGE_STYLES[stage];
  const name =
    [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
    'Untitled lead';

  return (
    <button type="button" className="pl-swipe-card w-full text-left" onClick={onOpen}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-base text-[var(--graphite)] truncate">
            {name}
          </div>
          <div className="text-sm text-[var(--steel)] mt-0.5 line-clamp-2 break-words">
            {lead.clientAddress || 'No address'}
          </div>
        </div>
        {showStage && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full pl-2 pr-2.5 py-1 shrink-0 text-[0.6875rem] font-medium ${styles.badge}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${styles.dash}`}
              aria-hidden
            />
            {stage}
          </span>
        )}
      </div>
    </button>
  );
}

'use client';

import { useRef, useState } from 'react';
import './stage-funnel.css';
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_STYLES,
  normalizePipelineStage,
  type PipelineStage,
} from '@/lib/pipeline';

export type PipelineBoardLead = {
  id: number;
  clientFirstName: string;
  clientLastName: string;
  clientAddress: string;
  clientCity: string;
  clientPhone: string;
  clientEmail: string;
  jobNumber: string;
  category: string;
  estimates?: { date?: string; selectedShingle?: string }[];
  notes?: { text?: string }[];
};

/** Loose trash shape — display-only; kinds mirror AppTrashItem in page.tsx */
export type PipelineTrashItem = {
  id: string;
  kind?: string;
  deletedAt?: string;
  leadLabel?: string;
  lead?: {
    id?: number;
    clientFirstName?: string;
    clientLastName?: string;
    jobNumber?: string;
  };
  photo?: { name?: string };
  measurement?: { label?: string };
  estimate?: {
    clientFirstName?: string;
    clientLastName?: string;
    selectedShingle?: string;
    negotiatedPrice?: number;
    total?: number;
  };
  note?: { text?: string };
  document?: { name?: string };
};

export type PipelineRollup = {
  estimatesCount: number;
  pipelineValue: number;
  avgEstimate: number;
  closedCount: number;
  stageValue: Record<PipelineStage, number>;
};

type PipelineBoardProps = {
  leads: PipelineBoardLead[];
  trash: PipelineTrashItem[];
  leadsView: 'active' | 'trash';
  pipelineFilter: PipelineStage | null;
  rollup: PipelineRollup;
  setLeadsView: (view: 'active' | 'trash') => void;
  setPipelineFilter: (
    next:
      | PipelineStage
      | null
      | ((cur: PipelineStage | null) => PipelineStage | null)
  ) => void;
  onCreateLead: () => void;
  onOpenLead: (id: number) => void;
  onMoveLeadToStage: (leadId: number, stage: PipelineStage) => void;
  onMoveToTrash: (leadId: number) => void;
  onEmptyTrash: () => void;
  onRestoreFromTrash: (id: string) => void;
  onPermanentlyDelete: (id: string) => void;
};

export default function PipelineBoard({
  leads,
  trash,
  leadsView,
  pipelineFilter,
  rollup,
  setLeadsView,
  setPipelineFilter,
  onCreateLead,
  onOpenLead,
  onMoveLeadToStage,
  onMoveToTrash,
  onEmptyTrash,
  onRestoreFromTrash,
  onPermanentlyDelete,
}: PipelineBoardProps) {
  const [dragLeadId, setDragLeadId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<PipelineStage | null>(null);
  const suppressCardClickRef = useRef(false);

  const visibleLeads = pipelineFilter
    ? leads.filter(
        (l) => normalizePipelineStage(l.category) === pipelineFilter
      )
    : leads;

  const stagesToShow = pipelineFilter
    ? ([pipelineFilter] as PipelineStage[])
    : PIPELINE_STAGES;

  const renderActions = () => (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (leadsView === 'trash') {
                    setLeadsView('active');
                  } else {
                    setPipelineFilter(null);
                    setLeadsView('trash');
                  }
                }}
                className="min-h-11 px-4 py-2 text-sm text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-xl transition-colors border border-transparent hover:border-zinc-200"
              >
                {leadsView === 'trash' ? 'Back to Board' : `Trash (${trash.length})`}
              </button>
              <button
                type="button"
                onClick={onCreateLead}
                className="btn-primary min-h-11 px-6 py-3 rounded-3xl font-medium"
              >
                New Lead
              </button>
            </div>
          );

          const renderChips = (variant: string, className = '') =>
            leadsView === 'active' && (
              <div
                className={`stage-funnel-chips flex flex-wrap items-center gap-2 ${className}`.trim()}
              >
                <button
                  type="button"
                  onClick={() => setPipelineFilter(null)}
                  className={`inline-flex items-center gap-2 rounded-full pl-2.5 pr-3.5 py-1.5 min-h-11 transition-colors ${
                    pipelineFilter == null
                      ? 'bg-[var(--accent-blue-soft)]'
                      : 'hover:bg-black/[0.04]'
                  }`}
                  title="Show all stages"
                >
                  <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-zinc-500">
                    All stages
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-zinc-900">
                    {leads.length}
                  </span>
                </button>
                {PIPELINE_STAGES.map((stage) => {
                  const count = leads.filter(
                    (l) => normalizePipelineStage(l.category) === stage
                  ).length;
                  const styles = PIPELINE_STAGE_STYLES[stage];
                  const active = pipelineFilter === stage;
                  return (
                    <button
                      key={`${variant}-${stage}`}
                      type="button"
                      onClick={() =>
                        setPipelineFilter((cur) => (cur === stage ? null : stage))
                      }
                      className={`inline-flex items-center gap-2 rounded-full pl-2.5 pr-3.5 py-1.5 min-h-11 transition-colors ${
                        active
                          ? 'bg-[var(--accent-blue-soft)]'
                          : 'hover:bg-black/[0.04]'
                      }`}
                      data-stage={stage}
                      data-active={active ? 'true' : undefined}
                      title={`View ${stage} leads`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 border border-[var(--dot-ring)] ${styles.dash}`}
                        aria-hidden
                      />
                      <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-zinc-500">
                        {stage}
                      </span>
                      <span className="text-xs font-semibold tabular-nums text-zinc-900">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            );

          const renderBoard = (variant: string) =>
            leadsView === 'trash' ? (
              <div className="space-y-3">
                {trash.length === 0 ? (
                  <div className="text-center py-16 text-zinc-500">
                    <p className="font-medium">Trash is empty</p>
                    <p className="text-sm mt-1">
                      Deleted leads and documents will appear here
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-end mb-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(
                              `Permanently delete all ${trash.length} items? This cannot be undone.`
                            )
                          ) {
                            onEmptyTrash();
                          }
                        }}
                        className="text-sm text-red-600 hover:text-red-700 font-medium min-h-11"
                      >
                        Empty trash permanently
                      </button>
                    </div>

                    {trash.map((item) => {
                      if (!item || !item.id) return null;

                      let title = 'Unknown item';
                      let subtitle = item.deletedAt || '';

                      try {
                        if (item.kind === 'lead' && item.lead) {
                          title =
                            [
                              item.lead.clientFirstName,
                              item.lead.clientLastName,
                            ]
                              .filter(Boolean)
                              .join(' ') ||
                            item.lead.jobNumber ||
                            `Lead #${item.lead.id}`;
                          subtitle = `Lead · ${item.deletedAt}`;
                        } else if (item.kind === 'photo' && item.photo) {
                          title = item.photo.name || 'Photo';
                          subtitle = `Photo · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (
                          item.kind === 'roofMeasurement' &&
                          item.measurement
                        ) {
                          title =
                            item.measurement.label ||
                            'Roof measurement';
                          subtitle = `Map measurement · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (item.kind === 'estimate' && item.estimate) {
                          const leadName =
                            item.leadLabel ||
                            [
                              item.estimate.clientFirstName,
                              item.estimate.clientLastName,
                            ]
                              .filter(Boolean)
                              .join(' ') ||
                            'Lead';
                          const product = item.estimate.selectedShingle || '';
                          const total = Number(
                            item.estimate.negotiatedPrice ||
                              item.estimate.total ||
                              0
                          );
                          title = `${leadName} · Estimate`;
                          subtitle = [
                            product || null,
                            total > 0
                              ? `$${total.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}`
                              : null,
                            item.deletedAt || null,
                          ]
                            .filter(Boolean)
                            .join(' · ');
                        } else if (item.kind === 'note' && item.note) {
                          title =
                            (item.note.text || 'Note').slice(0, 80) || 'Note';
                          subtitle = `Note · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (
                          (item.kind === 'document' ||
                            item.kind === 'measurement') &&
                          item.document
                        ) {
                          title =
                            item.document.name ||
                            (item.kind === 'measurement'
                              ? 'Measurement'
                              : 'Document');
                          subtitle = `${
                            item.kind === 'measurement'
                              ? 'Measurement'
                              : 'Document'
                          } · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else {
                          title = `Broken ${item.kind || 'item'}`;
                          subtitle = `Corrupted entry · ${item.deletedAt || ''}`;
                        }
                      } catch {
                        title = 'Broken trash item';
                        subtitle = 'Could not read this entry';
                      }

                      return (
                        <div
                          key={`${variant}-${item.id}`}
                          className="flex items-center justify-between gap-3 p-4 bg-white border border-zinc-200 rounded-xl"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-zinc-900 truncate">
                              {title}
                            </div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              {subtitle}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => onRestoreFromTrash(item.id)}
                              className="btn-primary px-4 py-1.5 rounded-full text-sm font-semibold min-h-11"
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              onClick={() => onPermanentlyDelete(item.id)}
                              className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1 min-h-11"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            ) : (
              <>
                {leads.length === 0 ? (
                  <div className="text-center py-20 rounded-3xl border border-dashed border-zinc-200 bg-zinc-100/50">
                    <div className="text-zinc-400 mb-4">No leads yet.</div>
                    <button
                      type="button"
                      onClick={onCreateLead}
                      className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-medium"
                    >
                      Create first lead
                    </button>
                  </div>
                ) : (
                  <div className="w-full">
                    <div
                      className={`kanban-board ${
                        pipelineFilter ? 'kanban-board--single' : ''
                      }`}
                    >
                      {stagesToShow.map((stage) => {
                        const stageLeads = visibleLeads
                          .filter((l) => normalizePipelineStage(l.category) === stage)
                          .sort((a, b) => b.id - a.id);
                        const isDropTarget = dragOverStage === stage;
                        const styles = PIPELINE_STAGE_STYLES[stage];
                        const stageValue = rollup.stageValue[stage] ?? 0;

                        return (
                          <div
                            key={`${variant}-${stage}`}
                            className={`kanban-col glass glass-hover rounded-[32px] p-2.5 sm:p-3 min-w-0 flex flex-col ${
                              isDropTarget
                                ? `ring-2 ${styles.ring} ring-offset-2 ring-offset-zinc-100`
                                : ''
                            } ${
                              pipelineFilter === stage
                                ? 'ring-2 ring-zinc-900/15'
                                : ''
                            }`}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              if (dragOverStage !== stage) setDragOverStage(stage);
                            }}
                            onDragLeave={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                setDragOverStage((cur) => (cur === stage ? null : cur));
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const idRaw =
                                e.dataTransfer.getData('text/plain') ||
                                (dragLeadId != null ? String(dragLeadId) : '');
                              const leadId = Number(idRaw);
                              setDragLeadId(null);
                              setDragOverStage(null);
                              if (!leadId || Number.isNaN(leadId)) return;
                              const lead = leads.find((l) => l.id === leadId);
                              if (!lead) return;
                              if (normalizePipelineStage(lead.category) === stage) return;
                              onMoveLeadToStage(leadId, stage);
                            }}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setPipelineFilter((cur) =>
                                  cur === stage ? null : stage
                                )
                              }
                              className="w-full text-left mb-3 min-w-0 group"
                              title={
                                pipelineFilter === stage
                                  ? 'Show all stages'
                                  : `Filter to ${stage}`
                              }
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dash}`}
                                />
                                <div
                                  className={`font-semibold text-xs sm:text-sm truncate ${styles.header} group-hover:underline decoration-slate-300 underline-offset-2`}
                                >
                                  {stage}
                                </div>
                              </div>
                              <div
                                className={`mt-1 text-xs sm:text-sm font-semibold tabular-nums tracking-tight ${
                                  stageValue === 0
                                    ? 'text-zinc-400'
                                    : 'text-zinc-900'
                                }`}
                              >
                                ${stageValue.toLocaleString()}
                              </div>
                            </button>

                            <div className="space-y-2 min-h-[100px] flex-1 overflow-y-auto overscroll-contain">
                              {stageLeads.map((lead, leadIdx) => (
                                <div
                                  key={`${variant}-board-${lead.id}-${leadIdx}`}
                                  draggable
                                  onDragStart={(e) => {
                                    setDragLeadId(lead.id);
                                    e.dataTransfer.setData('text/plain', String(lead.id));
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragEnd={() => {
                                    suppressCardClickRef.current = true;
                                    window.setTimeout(() => {
                                      suppressCardClickRef.current = false;
                                    }, 80);
                                    setDragLeadId(null);
                                    setDragOverStage(null);
                                  }}
                                  className={`kanban-card rounded-xl sm:rounded-2xl p-2.5 sm:p-3 cursor-grab active:cursor-grabbing ${
                                    dragLeadId === lead.id ? 'opacity-50 scale-[0.98]' : ''
                                  }`}
                                  onClick={() => {
                                    if (suppressCardClickRef.current) return;
                                    onOpenLead(lead.id);
                                  }}
                                >
                                  <div className="font-semibold text-xs sm:text-sm text-zinc-900 min-w-0 truncate">
                                    {[lead.clientFirstName, lead.clientLastName]
                                      .filter(Boolean)
                                      .join(' ') || 'Untitled lead'}
                                  </div>
                                  <div className="text-[0.6875rem] sm:text-xs text-zinc-500 mt-0.5 line-clamp-2 break-words">
                                    {lead.clientAddress || 'No address'}
                                  </div>
                                  <div className="mt-2 flex items-center justify-between gap-1">
                                    <span className="text-zinc-400 text-[0.6875rem] font-medium tabular-nums">
                                      {lead.estimates?.length || 0} est.
                                    </span>
                                    <button
                                      type="button"
                                      className="text-[0.6875rem] font-medium text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50 px-1.5 py-0.5 rounded-md transition-colors"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onMoveToTrash(lead.id);
                                      }}
                                    >
                                      Trash
                                    </button>
                                  </div>
                                </div>
                              ))}
                              {stageLeads.length === 0 && (
                                <div className="text-center text-xs text-zinc-500 py-8 border border-dashed border-[var(--glass-border)] rounded-2xl">
                                  Drop leads here
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            );

  return (
        <div className="w-full pb-4">
          <div className="pl-toolbar">
            <h1 className="page-title">Pipeline</h1>
            {leadsView === 'active' && (
              <div className="pl-toolbar-stats">
                <div>
                  <span className="pl-stat-label">Value</span>
                  <b className="pl-stat-num pl-stat-num--money">
                    ${rollup.pipelineValue.toLocaleString()}
                  </b>
                </div>
                <div>
                  <span className="pl-stat-label">Avg</span>
                  <b className="pl-stat-num">
                    ${rollup.avgEstimate.toLocaleString()}
                  </b>
                  {rollup.closedCount > 0 && (
                    <span className="pl-stat-note">
                      {rollup.closedCount} closed
                    </span>
                  )}
                </div>
                <div>
                  <span className="pl-stat-label">Jobs</span>
                  <b className="pl-stat-num">{leads.length}</b>
                </div>
              </div>
            )}
            <div className="pl-toolbar-actions">{renderActions()}</div>
          </div>
          {renderChips('board', 'mb-6')}
          {renderBoard('board')}
        </div>
  );
}

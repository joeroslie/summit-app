'use client';

import { useRef, useState } from 'react';
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

type PipelineBoardProps = {
  leads: PipelineBoardLead[];
  trash: PipelineTrashItem[];
  leadsView: 'active' | 'trash';
  pipelineFilter: PipelineStage | null;
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
  const [leadsSearch, setLeadsSearch] = useState('');
  const [dragLeadId, setDragLeadId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<PipelineStage | null>(null);
  const suppressCardClickRef = useRef(false);

  const q = leadsSearch.trim().toLowerCase();
  const searchFiltered = q
    ? leads.filter((lead) => {
        const hay = [
          lead.clientFirstName,
          lead.clientLastName,
          lead.clientAddress,
          lead.clientCity,
          lead.clientPhone,
          lead.clientEmail,
          lead.jobNumber,
          lead.category,
          ...(lead.estimates || []).map((e) => `${e.date} ${e.selectedShingle}`),
          ...(lead.notes || []).map((n) => n.text),
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
    : leads;

  const visibleLeads = pipelineFilter
    ? searchFiltered.filter(
        (l) => normalizePipelineStage(l.category) === pipelineFilter
      )
    : searchFiltered;

  const stagesToShow = pipelineFilter
    ? ([pipelineFilter] as PipelineStage[])
    : PIPELINE_STAGES;

  const filterCount = pipelineFilter
    ? leads.filter(
        (l) => normalizePipelineStage(l.category) === pipelineFilter
      ).length
    : leads.length;

  return (
        <div className="w-full pb-4">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
            <div>
              <h1 className="page-title">Pipeline</h1>
              {(pipelineFilter || trash.length > 0) && (
              <p className="text-zinc-500 mt-0.5">
                {pipelineFilter ? (
                  <>
                    <span className="font-medium text-zinc-700">{filterCount}</span>
                    {' '}in{' '}
                    <span className="font-medium text-zinc-800">{pipelineFilter}</span>
                    <span className="text-zinc-400">
                      {' '}· {leads.length} total
                    </span>
                  </>
                ) : null}
                {trash.length > 0 && (
                  <span className="text-zinc-400">{pipelineFilter ? ' · ' : ''}{trash.length} in trash</span>
                )}
              </p>
              )}
            </div>
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
                className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-xl transition-colors border border-transparent hover:border-zinc-200"
              >
                {leadsView === 'trash' ? 'Back to Board' : `Trash (${trash.length})`}
              </button>
              <button
                onClick={onCreateLead}
                className="btn-primary px-6 py-3 rounded-3xl font-medium"
              >
                New Lead
              </button>
            </div>
          </div>

          {/* Stage filter chips — same control from Home or board */}
          {leadsView === 'active' && (
            <div className="flex flex-wrap items-center gap-2 mb-6">
              <button
                type="button"
                onClick={() => setPipelineFilter(null)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                  pipelineFilter == null
                    ? 'bg-zinc-900 text-white'
                    : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
                }`}
              >
                All stages
              </button>
              {PIPELINE_STAGES.map((stage) => {
                const count = leads.filter(
                  (l) => normalizePipelineStage(l.category) === stage
                ).length;
                const styles = PIPELINE_STAGE_STYLES[stage];
                const active = pipelineFilter === stage;
                return (
                  <button
                    key={stage}
                    type="button"
                    onClick={() =>
                      setPipelineFilter((cur) => (cur === stage ? null : stage))
                    }
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                      active
                        ? 'bg-zinc-900 text-white border-zinc-900 shadow-sm'
                        : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300 hover:shadow-sm'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        active ? 'bg-white/80' : styles.dash
                      }`}
                    />
                    {stage}
                    <span className={active ? 'text-white/70' : 'text-zinc-400'}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {leadsView === 'trash' ? (
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
                      className="text-sm text-red-600 hover:text-red-700 font-medium"
                    >
                      Empty trash permanently
                    </button>
                  </div>

                  {trash.map((item) => {
                    // Defensive: never let a bad item crash the whole list
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
                        key={item.id}
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
                            className="btn-primary px-4 py-1.5 rounded-full text-sm font-semibold"
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            onClick={() => onPermanentlyDelete(item.id)}
                            className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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
              <div className="mb-6 sm:mb-8">
                <input
                  type="text"
                  value={leadsSearch}
                  placeholder="Search leads..."
                  className="w-full max-w-md px-5 py-4 text-base border border-zinc-200 rounded-3xl focus:outline-none focus:border-zinc-400 bg-white shadow-sm"
                  onChange={(e) => setLeadsSearch(e.target.value)}
                />
              </div>

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

                      return (
                        <div
                          key={stage}
                          className={`kanban-col rounded-2xl sm:rounded-3xl border p-2.5 sm:p-3 min-w-0 flex flex-col ${styles.column} ${
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
                          <div className="flex items-center justify-between mb-3 gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setPipelineFilter((cur) =>
                                  cur === stage ? null : stage
                                )
                              }
                              className="flex items-center gap-1.5 min-w-0 text-left group"
                              title={
                                pipelineFilter === stage
                                  ? 'Show all stages'
                                  : `Filter to ${stage}`
                              }
                            >
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dash}`} />
                              <div
                                className={`font-semibold text-xs sm:text-sm truncate ${styles.header} group-hover:underline decoration-slate-300 underline-offset-2`}
                              >
                                {stage}
                              </div>
                            </button>
                            <div
                              className={`px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-medium border shrink-0 ${styles.pill}`}
                            >
                              {stageLeads.length}
                            </div>
                          </div>

                          {/* Cards scroll inside column — board uses full viewport height */}
                          <div className="space-y-2 min-h-[100px] flex-1 overflow-y-auto overscroll-contain">
                            {stageLeads.map((lead, leadIdx) => (
                              <div
                                key={`board-${lead.id}-${leadIdx}`}
                                draggable
                                onDragStart={(e) => {
                                  setDragLeadId(lead.id);
                                  e.dataTransfer.setData('text/plain', String(lead.id));
                                  e.dataTransfer.effectAllowed = 'move';
                                }}
                                onDragEnd={() => {
                                  // Avoid opening profile when a drag ends on the same card
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
                                <div className="text-[10px] sm:text-xs text-zinc-500 mt-0.5 line-clamp-2 break-words">
                                  {lead.clientAddress || 'No address'}
                                </div>
                                <div className="mt-2 flex items-center justify-between gap-1">
                                  <span className="text-zinc-400 text-[10px] font-medium tabular-nums">
                                    {lead.estimates?.length || 0} est.
                                  </span>
                                  <button
                                    type="button"
                                    className="text-[10px] font-medium text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50 px-1.5 py-0.5 rounded-md transition-colors"
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
          )}
        </div>
  );

}

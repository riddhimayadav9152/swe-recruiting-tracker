'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, PlusCircle, X, ChevronsLeft, ChevronsRight, ClipboardPaste } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const MIN_WIDTH = 190;
const MAX_WIDTH = 320;
const COLLAPSED_WIDTH = 64;
const DEFAULT_WIDTH = 288;

const WIDTH_STORAGE_KEY = 'tracker-sidebar-width';
const COLLAPSED_STORAGE_KEY = 'tracker-sidebar-collapsed';

export type SidebarSection = { key: string; label: string; icon: LucideIcon };

export function Sidebar({
  sections, activeSection, onSelectSection, onNewOpportunity, onPasteImport, profileName,
}: {
  sections: SidebarSection[];
  activeSection: string;
  onSelectSection: (key: string) => void;
  onNewOpportunity: () => void;
  onPasteImport: () => void;
  profileName?: string;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    if (savedWidth && savedWidth >= MIN_WIDTH && savedWidth <= MAX_WIDTH) setWidth(savedWidth);
    setCollapsed(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true');
  }, []);

  useEffect(() => { window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width)); }, [width]);
  useEffect(() => { window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed)); }, [collapsed]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    if (!draggingRef.current) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX));
    setWidth(next);
  }, []);

  const stopDragging = useCallback(() => {
    draggingRef.current = false;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', stopDragging);
  }, [handlePointerMove]);

  const startDragging = (event: React.PointerEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
  };

  const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

  const navButtons = (isCollapsed: boolean) => (
    <nav className="space-y-1">
      {sections.map((section) => {
        const Icon = section.icon;
        return (
          <button
            key={section.key}
            title={isCollapsed ? section.label : undefined}
            onClick={() => { onSelectSection(section.key); setMobileOpen(false); }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${isCollapsed ? 'justify-center' : ''} ${activeSection === section.key ? 'bg-[#ff87ab] text-slate-900' : 'text-slate-600 hover:bg-[#fadde1] hover:text-[#ff5d8f]'}`}
          >
            <Icon size={16} />
            {!isCollapsed && section.label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile top bar + drawer — no dragging on small screens. */}
      <div className="flex items-center justify-between border-b border-[#ffcad4] bg-white p-4 lg:hidden">
        <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="rounded-lg p-2 text-slate-600 hover:bg-[#fadde1]">
          <Menu size={20} />
        </button>
        <h1 className="text-lg font-semibold text-slate-900">Recruiting Workspace</h1>
        <div className="w-9" />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="w-72 overflow-y-auto bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h1 className="text-lg font-semibold text-slate-900">Recruiting Workspace</h1>
              <button onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={20} /></button>
            </div>
            <button onClick={() => { onNewOpportunity(); setMobileOpen(false); }} className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff87ab] px-4 py-3 text-sm font-medium text-slate-900">
              <PlusCircle size={18} /> New Opportunity
            </button>
            <button onClick={() => { onPasteImport(); setMobileOpen(false); }} className="mb-6 flex w-full items-center justify-center gap-2 rounded-lg border border-[#ffc4d6] bg-white px-4 py-3 text-sm text-slate-600">
              <ClipboardPaste size={18} /> Paste Application Import
            </button>
            {navButtons(false)}
          </div>
          <div className="flex-1 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
        </div>
      )}

      {/* Desktop resizable/collapsible sidebar. */}
      <aside
        style={{ width: effectiveWidth }}
        className="relative hidden shrink-0 border-r border-[#ffcad4] bg-white p-4 transition-[width] duration-100 lg:block"
      >
        <div className="flex items-center justify-between">
          {!collapsed && (
            <div className="mb-2">
              <p className="text-xs uppercase tracking-[0.3em] text-[#ffa6c1]">Recruiting Workspace</p>
              <h1 className="mt-1 text-xl font-semibold text-slate-900">Pipeline</h1>
              {profileName && <p className="mt-0.5 text-xs text-slate-400">{profileName}</p>}
            </div>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="mb-2 rounded-lg p-1.5 text-slate-400 hover:bg-[#fadde1] hover:text-[#ff5d8f]"
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>

        <button
          onClick={onNewOpportunity}
          title={collapsed ? 'New Opportunity' : undefined}
          className={`mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[#ff87ab] px-3 py-3 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f]`}
        >
          <PlusCircle size={18} /> {!collapsed && 'New Opportunity'}
        </button>
        <button
          onClick={onPasteImport}
          title={collapsed ? 'Paste Application Import' : undefined}
          className="mb-6 flex w-full items-center justify-center gap-2 rounded-lg border border-[#ffc4d6] bg-white px-3 py-3 text-sm text-slate-600 transition hover:bg-[#fadde1]"
        >
          <ClipboardPaste size={18} /> {!collapsed && 'Paste Application Import'}
        </button>

        {navButtons(collapsed)}

        {/* Drag handle */}
        {!collapsed && (
          <div
            onPointerDown={startDragging}
            className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#ffacc5]"
            data-testid="sidebar-resize-handle"
          />
        )}
      </aside>
    </>
  );
}

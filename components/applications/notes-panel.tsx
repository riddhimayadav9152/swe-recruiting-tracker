'use client';

import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { NOTE_CATEGORIES, type NoteRecord } from './types';

export function NotesPanel({ applicationId, notes, onChanged }: { applicationId: string; notes: NoteRecord[]; onChanged: () => Promise<void> | void }) {
  const [category, setCategory] = useState<string>('General');
  const [content, setContent] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState('General');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!content.trim()) {
      toast.error('Note content is required');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/applications/${applicationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'note', category, content }),
      });
      if (!response.ok) {
        toast.error('Unable to add note');
        return;
      }
      setContent('');
      toast.success('Note added');
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (note: NoteRecord) => {
    setEditingId(note.id);
    setEditCategory(note.category ?? 'General');
    setEditContent(note.content);
  };

  const saveEdit = async (noteId: string) => {
    if (!editContent.trim()) {
      toast.error('Note content is required');
      return;
    }
    const response = await fetch(`/api/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: editCategory, content: editContent }),
    });
    if (!response.ok) {
      toast.error('Unable to update note');
      return;
    }
    setEditingId(null);
    toast.success('Note updated');
    await onChanged();
  };

  const deleteNote = async (noteId: string) => {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    const response = await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
    if (!response.ok) {
      toast.error('Unable to delete note');
      return;
    }
    toast.success('Note deleted');
    await onChanged();
  };

  const sorted = [...notes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-4" data-testid="notes-panel">
      <form onSubmit={addNote} className="space-y-2 rounded-lg border border-[#ffcad4] bg-[#fadde1]/30 p-3">
        <div className="flex flex-wrap gap-2">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm">
            {NOTE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder="Add a note…"
          className="w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm outline-none focus:border-[#ffa6c1] focus:ring-2 focus:ring-[#ffcad4]"
        />
        <button type="submit" disabled={saving} className="rounded-lg bg-[#ff87ab] px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-[#ff5d8f] disabled:opacity-50">
          Add Note
        </button>
      </form>

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500">No notes yet.</p>
      ) : (
        <div className="space-y-3">
          {sorted.map((note) => (
            <div key={note.id} data-testid="note-card" className="rounded-lg border border-[#ffcad4] bg-white p-3 text-sm shadow-sm">
              {editingId === note.id ? (
                <div className="space-y-2">
                  <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} className="rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm">
                    {NOTE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={3} className="w-full rounded-lg border border-[#ffc4d6] bg-white p-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(note.id)} className="rounded-lg bg-[#ff87ab] px-3 py-1.5 text-xs font-medium text-slate-900">Save</button>
                    <button onClick={() => setEditingId(null)} className="rounded-lg border border-[#ffc4d6] px-3 py-1.5 text-xs text-slate-600">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full bg-[#fadde1] px-2 py-0.5 text-xs font-medium text-[#ff5d8f]">{note.category ?? 'General'}</span>
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span>Created {new Date(note.createdAt).toLocaleDateString()}</span>
                      {note.updatedAt !== note.createdAt && <span>• Updated {new Date(note.updatedAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-slate-700">{note.content}</p>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => startEdit(note)} className="text-xs font-medium text-[#ff5d8f] hover:underline">Edit</button>
                    <button onClick={() => deleteNote(note.id)} className="text-xs font-medium text-rose-600 hover:underline">Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
